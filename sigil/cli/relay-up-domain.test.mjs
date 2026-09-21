import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync, spawn } from 'node:child_process';

const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');

function tmpCwdWithRegistry() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-relay-domain-test-'));
  execFileSync(process.execPath, [sigilCli, 'init', 'alice'], { cwd, encoding: 'utf8' });
  return cwd;
}

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      try { execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' }); } catch { /* already gone */ }
    } else {
      child.kill('SIGTERM');
    }
  } catch { /* ignore */ }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

async function waitForListening(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for relay to start: ${buf}`));
    }, timeoutMs);
    const onData = (chunk) => {
      buf += chunk;
      if (buf.includes('Sigil relay listening on')) {
        cleanup();
        resolve(buf);
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`sigil relay up exited early with code ${code}: ${buf}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}

async function rmCwd(cwd) {
  for (let attempt = 0; ; attempt++) {
    try { fs.rmSync(cwd, { recursive: true, force: true }); break; }
    catch (error) {
      if (attempt >= 10 || error.code !== 'EPERM') throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

test('sigil relay up rejects a malformed --domain before binding a port', () => {
  const cwd = tmpCwdWithRegistry();
  try {
    assert.throws(
      () => execFileSync(process.execPath, [sigilCli, 'relay', 'up', '--port', '0', '--domain', 'not a domain!'], { cwd, encoding: 'utf8', timeout: 5000 }),
      (error) => /INVALID_DOMAIN_SYNTAX|sigil: /.test(String(error.stderr ?? error.message)),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('sigil relay up warns when no endpoint in the registry belongs to --domain', async () => {
  const cwd = tmpCwdWithRegistry();
  const child = spawn(process.execPath, [sigilCli, 'relay', 'up', '--port', '0', '--domain', 'relay.example.com'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const output = await waitForListening(child);
    assert.match(output, /WARNING: no endpoint in .+ belongs to domain "relay\.example\.com"/);
  } finally {
    await killChild(child);
    await rmCwd(cwd);
  }
});

test('sigil relay up does not warn when an endpoint already belongs to --domain', async () => {
  const cwd = tmpCwdWithRegistry();
  const child = spawn(process.execPath, [sigilCli, 'relay', 'up', '--port', '0', '--domain', 'local'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const output = await waitForListening(child);
    assert.doesNotMatch(output, /WARNING: no endpoint/);
  } finally {
    await killChild(child);
    await rmCwd(cwd);
  }
});

test('sigil relay up starts successfully with a syntactically valid --domain', async () => {
  const cwd = tmpCwdWithRegistry();
  const child = spawn(process.execPath, [sigilCli, 'relay', 'up', '--port', '0', '--domain', 'relay.example.com'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const output = await waitForListening(child);
    assert.match(output, /Sigil relay listening on/);
  } finally {
    await killChild(child);
    await rmCwd(cwd);
  }
});
