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
      child.stdout.on('data', (d) => { buf += d; if (buf.includes('Room bridge: router (model qwen2.5:7b)')) { clearTimeout(timer); resolve(buf); } });
      child.stderr.on('data', (d) => { buf += d; });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`exited early: ${buf}`)); });
    });
    assert.match(out, /Room bridge: router \(model qwen2\.5:7b\)/);
  } finally {
    killTree(child);
  }
});
