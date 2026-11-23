// Contract test: the real connector-daemon serves /mcp/memory on loopback with a
// disposable identity and cache. Guards the kb-sync sandbox contract (port 4412).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createIdentity } from './identity.mjs';

const daemon = path.resolve(import.meta.dirname, 'connector-daemon.mjs');
const fixture = path.resolve(import.meta.dirname, 'fixtures', 'kb-memory-server.fixture.mjs');

function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

// 4412 when free, otherwise any free loopback port.
async function pickPort() {
  const s = await listenOnce(4412).catch(() => listenOnce(0));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function rpc(url, id, method, params = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function waitForPort(port, child, logs) {
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`daemon exited early: ${logs()}`);
    const up = await new Promise((resolve) => {
      const c = net.connect(port, '127.0.0.1', () => { c.destroy(); resolve(true); });
      c.once('error', () => resolve(false));
    });
    if (up) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon never listened: ${logs()}`);
}

test('connector-daemon serves query_context_cache from a disposable cache (no fallback)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-kb-contract-'));
  let child;
  try {
    const identityPath = path.join(dir, 'fake.identity.json');
    fs.writeFileSync(identityPath, JSON.stringify(createIdentity({ ownerId: 'owner_fixture', endpointId: 'ep_fixture', kind: 'agent' })));
    const cachePath = path.join(dir, 'cache.json');
    fs.writeFileSync(cachePath, JSON.stringify({ notes: [{ topic: 'sandbox', text: 'contract-marker-4412 lives here' }] }));

    const port = await pickPort();
    let output = '';
    // No --relay-url: also proves memory-only mode needs no relay.
    child = spawn(process.execPath, [daemon, '--port', String(port), '--identity', identityPath], {
      env: { ...process.env, KB_MEMORY_SERVER_PATH: fixture, KB_FIXTURE_CACHE: cachePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    await waitForPort(port, child, () => output);

    const url = `http://127.0.0.1:${port}/mcp/memory`;
    const init = await rpc(url, 1, 'initialize', { protocolVersion: '2024-11-05' });
    assert.ok(init.result?.serverInfo, JSON.stringify(init));

    const list = await rpc(url, 2, 'tools/list');
    assert.ok(list.result.tools.some((t) => t.name === 'query_context_cache'));

    const call = await rpc(url, 3, 'tools/call', { name: 'query_context_cache', arguments: { query: 'contract-marker' } });
    assert.equal(call.error, undefined, JSON.stringify(call.error));
    const text = call.result.content[0].text;
    assert.ok(!text.startsWith('[fallback-cache]'), text);
    assert.match(text, /contract-marker-4412/);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
