import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const root = import.meta.filename
  ? dirname(dirname(import.meta.filename))
  : fileURLToPath(new URL('../', import.meta.url));
const watchdog = join(root, 'scripts', 'chief-watchdog.ps1');
const setup = join(root, 'scripts', 'setup-chief-daemon.ps1');

function runPowerShell(file, args, timeout = 30_000) {
  return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], {
    cwd: root, encoding: 'utf8', timeout,
  });
}

function destroyStdio(child) {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try { stream?.destroy(); } catch { /* already closed */ }
  }
}

function killPid(pid, signal = 'SIGKILL') {
  if (!pid || Number.isNaN(pid)) return;
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

async function waitForExit(child, ms = 500) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
}

async function teardownWatchdog(child, pids, pidFile) {
  for (const pid of pids) killPid(pid, 'SIGKILL');
  if (existsSync(pidFile)) {
    try { killPid(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL'); } catch { /* gone */ }
  }
  destroyStdio(child);
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  await waitForExit(child);
  destroyStdio(child);
}

test('watchdog restarts a killed daemon, probes its room socket, and redacts credentials in audit events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigil-chief-watchdog-'));
  const daemon = join(dir, 'fake-daemon.mjs');
  const pidFile = join(dir, 'chief.pid');
  const audit = join(dir, 'audit.log');
  const port = 39000 + (process.pid % 1000);
  writeFileSync(daemon, `
    import net from 'node:net';
    const server = net.createServer().listen(${port}, '127.0.0.1');
    process.on('SIGTERM', () => {
      server.close();
      process.exit(0);
    });
    const timer = setTimeout(() => {
      try { server.close(); } catch {}
      process.exit(0);
    }, 15000);
    timer.unref();
  `);

  let childStderr = '';
  const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', watchdog,
    '-DaemonPath', process.execPath, '-DaemonArguments', daemon,
    '-PidFile', pidFile, '-RoomSocketPort', String(port), '-AuditLogPath', audit,
    '-IntervalSeconds', '0.2', '-StartupGraceSeconds', '0.5', '-MaxBackoffSeconds', '1', '-StopAfterSeconds', '20'],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', (chunk) => { childStderr += chunk.toString(); });
  let firstPid = null;
  let secondPid = null;
  try {
    for (let i = 0; i < 100 && firstPid === null; i++) {
      if (existsSync(pidFile)) {
        const candidate = Number(readFileSync(pidFile, 'utf8').trim());
        try { process.kill(candidate, 0); firstPid = candidate; } catch { /* wait for Start-Process to finish */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.notEqual(firstPid, null, `watchdog should publish a live daemon PID${childStderr ? `: ${childStderr}` : ''}`);
    process.kill(firstPid, 'SIGTERM');
    secondPid = firstPid;
    for (let i = 0; i < 50 && secondPid === firstPid; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (existsSync(pidFile)) secondPid = Number(readFileSync(pidFile, 'utf8').trim());
    }
    assert.notEqual(secondPid, firstPid, 'watchdog should respawn the daemon within the probe window');
    for (let i = 0; i < 50; i++) {
      if (existsSync(audit) && readFileSync(audit, 'utf8').includes('"event":"daemon_healthy"')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const lines = readFileSync(audit, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(lines.some((event) => event.event === 'daemon_started'));
    assert.ok(lines.some((event) => event.event === 'daemon_unhealthy'));
    assert.ok(lines.some((event) => event.event === 'daemon_restarted'));
    assert.ok(lines.some((event) => event.event === 'daemon_healthy' && event.socket_port === port));
    assert.ok(lines.every((event) => !JSON.stringify(event).includes('token')));
  } finally {
    await teardownWatchdog(child, [firstPid, secondPid], pidFile);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setup script plans a logon task that runs the watchdog without embedding secrets', () => {
  assert.match(readFileSync(watchdog, 'utf8'), /\$IntervalSeconds = 60/);
  const res = runPowerShell(setup, ['-WhatIf']);
  const out = `${res.stdout}\n${res.stderr}`;
  assert.equal(res.status, 0, out);
  assert.match(out, /SigilChiefWatchdog/);
  assert.match(out, /-File "[^"]*chief-watchdog\.ps1" -RepoRoot "/);
  assert.doesNotMatch(out, /TOKEN|SECRET|Bearer/i);
});

test('setup script plans unregistration with -WhatIf', () => {
  const res = runPowerShell(setup, ['-Unregister', '-WhatIf']);
  const out = `${res.stdout}\n${res.stderr}`;
  assert.equal(res.status, 0, out);
  assert.match(out, /Unregister scheduled task/);
  assert.match(out, /SigilChiefWatchdog/);
});
