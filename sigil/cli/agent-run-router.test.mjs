import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { createIdentity, saveIdentity } from './identity.mjs';

const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch { /* already gone */ }
}

test('agent run --room-bridge router without --identity prints the usage error', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-agent-router-test-'));
  const result = spawnSync(process.execPath, [sigilCli, 'agent', 'run', '--room-bridge', 'router', '--config', path.join(cwd, 'none.json')], { cwd, encoding: 'utf8', timeout: 20_000, env: { ...process.env, SIGIL_IDENTITY: '' } });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /usage: sigil agent run --identity/);
});

test('agent run --room-bridge router announces the router model before polling', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-agent-router-test-'));
  const idFile = path.join(cwd, 'agent.json');
  saveIdentity(idFile, createIdentity({ ownerId: 'alice', endpointId: 'ep_alice_router', kind: 'agent' }));
  const child = spawn(process.execPath, [sigilCli, 'agent', 'run', '--identity', idFile, '--relay-url', 'http://127.0.0.1:1', '--room-bridge', 'router', '--router-model', 'qwen2.5:7b'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const out = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`timed out: ${buf}`)), 15_000);
      child.stdout.on('data', (d) => { buf += d; if (buf.includes('Room bridge: router (model qwen2.5:7b, sole-agent fallback on)')) { clearTimeout(timer); resolve(buf); } });
      child.stderr.on('data', (d) => { buf += d; });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`exited early: ${buf}`)); });
    });
    assert.match(out, /Room bridge: router \(model qwen2\.5:7b, sole-agent fallback on\)/);
  } finally {
    killTree(child);
  }
});

function announce(extraArgs) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-agent-router-test-'));
  const idFile = path.join(cwd, 'agent.json');
  saveIdentity(idFile, createIdentity({ ownerId: 'alice', endpointId: 'ep_alice_router', kind: 'agent' }));
  const child = spawn(process.execPath, [sigilCli, 'agent', 'run', '--identity', idFile, '--relay-url', 'http://127.0.0.1:1', '--room-bridge', 'router', ...extraArgs], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const done = new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timed out: ${buf}`)), 15_000);
    child.stdout.on('data', (d) => { buf += d; if (buf.includes('Room bridge: router')) { clearTimeout(timer); resolve(buf); } });
    child.stderr.on('data', (d) => { buf += d; });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`exited early: ${buf}`)); });
  });
  return done.finally(() => killTree(child));
}

function runSync(extraArgs) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-agent-router-test-'));
  const idFile = path.join(cwd, 'agent.json');
  saveIdentity(idFile, createIdentity({ ownerId: 'alice', endpointId: 'ep_alice_router', kind: 'agent' }));
  return spawnSync(process.execPath, [sigilCli, 'agent', 'run', '--identity', idFile, '--relay-url', 'http://127.0.0.1:1', '--room-bridge', 'router', ...extraArgs], { cwd, encoding: 'utf8', timeout: 20_000 });
}

for (const flag of ['--router-timeout-ms', '--router-context-messages']) {
  for (const bad of ['abc', '0', '-5', '1.5', '']) {
    test(`${flag} ${JSON.stringify(bad)} exits with a clear error`, () => {
      const result = runSync([`${flag}=${bad}`]);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}${result.stdout}`, new RegExp(`${flag} must be a positive integer`));
    });
  }
}

test('valid --router-timeout-ms and --router-context-messages start the router', async () => {
  assert.match(await announce(['--router-timeout-ms', '15000', '--router-context-messages', '8']), /Room bridge: router/);
});

test('--router-sole-agent-fallback off is announced', async () => {
  assert.match(await announce(['--router-sole-agent-fallback', 'off']), /sole-agent fallback off\)/);
});

test('--router-sole-agent-fallback rejects values other than on or off', () => {
  const result = runSync(['--router-sole-agent-fallback', 'maybe']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /--router-sole-agent-fallback must be on or off/);
});
