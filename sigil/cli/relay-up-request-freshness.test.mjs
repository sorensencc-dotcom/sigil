// sigil/cli/relay-up-request-freshness.test.mjs
//
// `sigil relay up` operator config for the inbound relay-request freshness
// window. The relay announces the EFFECTIVE window on stderr at startup
// (`logRelayRequestFreshnessOnce` in http-server.mjs), and that line is the
// only externally observable proof of what the server resolved -- so these
// tests boot a real federated relay and read it back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');
const FRESHNESS_LINE = /sigil: relay request freshness window = (\d+) ms/;

// Boot a `--federation-mode sync` relay (no database needed) and resolve with
// the freshness window it announced, then kill it. The process otherwise runs
// forever, so every path here tears the child down.
function bootRelay(t, { extraArgs = [], env = {} } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-freshness-test-'));
  execFileSync(process.execPath, [sigilCli, 'init', 'a', '--domain', 'local'], { cwd, encoding: 'utf8' });

  const child = spawn(process.execPath, [
    sigilCli, 'relay', 'up',
    '--domain', 'local',
    '--federation-mode', 'sync',
    '--federation-identity', '.sigil/a.identity.json',
    ...extraArgs,
  ], { cwd, env: { ...process.env, SIGIL_DATABASE_URL: '', ...env } });
  // Windows keeps a handle on the child's cwd until it has actually exited, so
  // the temp dir can only be removed after the process is gone.
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`relay never announced a freshness window; stderr:\n${stderr}`)), 15_000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(FRESHNESS_LINE);
      if (!match) return;
      clearTimeout(timer);
      child.kill();
      resolve(Number(match[1]));
    });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', () => { clearTimeout(timer); reject(new Error(`relay exited early; stderr:\n${stderr}`)); });
  });
}

test('relay up defaults the request freshness window to 300s', async (t) => {
  assert.equal(await bootRelay(t), 300_000);
});

test('relay up honours --relay-request-freshness-ms', async (t) => {
  assert.equal(await bootRelay(t, { extraArgs: ['--relay-request-freshness-ms', '120000'] }), 120_000);
});

test('relay up honours SIGIL_RELAY_REQUEST_FRESHNESS_MS', async (t) => {
  assert.equal(await bootRelay(t, { env: { SIGIL_RELAY_REQUEST_FRESHNESS_MS: '600000' } }), 600_000);
});

test('the --relay-request-freshness-ms flag beats the env var', async (t) => {
  const resolved = await bootRelay(t, {
    extraArgs: ['--relay-request-freshness-ms', '90000'],
    env: { SIGIL_RELAY_REQUEST_FRESHNESS_MS: '600000' },
  });
  assert.equal(resolved, 90_000);
});

test('an out-of-range window is clamped, not rejected', async (t) => {
  // resolveRelayRequestFreshnessMs clamps to [60s, 1h]; 1s floors to 60s.
  assert.equal(await bootRelay(t, { extraArgs: ['--relay-request-freshness-ms', '1000'] }), 60_000);
});

test('an unparseable window falls back to the 300s default', async (t) => {
  assert.equal(await bootRelay(t, { extraArgs: ['--relay-request-freshness-ms', 'nope'] }), 300_000);
});

test('an empty SIGIL_RELAY_REQUEST_FRESHNESS_MS counts as unset, not 0', async (t) => {
  // Number('') is 0, which would clamp UP to the 60s floor and silently
  // narrow the window for anyone who exported the variable empty.
  assert.equal(await bootRelay(t, { env: { SIGIL_RELAY_REQUEST_FRESHNESS_MS: '' } }), 300_000);
});
