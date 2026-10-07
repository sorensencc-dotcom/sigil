// Rooms phase 4a: `relay up --browser-origin` / `--room-human-identity`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { createIdentity, loadIdentity, saveIdentity } from './identity.mjs';

const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');
const ORIGIN = 'https://app.example';

function tmpCwdWithRegistry() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-relay-browser-test-'));
  execFileSync(process.execPath, [sigilCli, 'init', 'alice'], { cwd, encoding: 'utf8' });
  return cwd;
}

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      try { execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' }); } catch { /* already gone */ }
    } else child.kill('SIGTERM');
  } catch { /* ignore */ }
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
}

async function rmCwd(cwd) {
  for (let attempt = 0; ; attempt++) {
    try { fs.rmSync(cwd, { recursive: true, force: true }); break; } catch (error) {
      if (attempt >= 10 || error.code !== 'EPERM') throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

// Starts `relay up --port 0 --stream-port 0` and resolves with the bound ports
// plus a live view of everything the process wrote.
function startRelay(cwd, extraArgs = []) {
  const child = spawn(process.execPath, [sigilCli, 'relay', 'up', '--port', '0', '--stream-port', '0', ...extraArgs], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { text: '' };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { out.text += c; });
  child.stderr.on('data', (c) => { out.text += c; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for relay: ${out.text}`)), 15_000);
    const poll = setInterval(() => {
      const httpMatch = out.text.match(/Sigil relay listening on http:\/\/127\.0\.0\.1:(\d+)/);
      const wsMatch = out.text.match(/Sigil stream \(push notify\) on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (httpMatch && wsMatch) { clearInterval(poll); clearTimeout(timer); resolve({ port: Number(httpMatch[1]), streamPort: Number(wsMatch[1]) }); }
    }, 25);
    child.once('exit', (code) => { clearInterval(poll); clearTimeout(timer); reject(new Error(`relay exited early (${code}): ${out.text}`)); });
  });
  return { child, out, ready };
}

function call(port, method, urlPath, { token, origin, body } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = {
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin, 'access-control-request-method': 'POST' } : {}),
    };
    const req = http.request({ hostname: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const humanIdentityPath = (cwd) => path.join(cwd, '.sigil', 'alice.identity.json');

async function withRelay(extraArgs, fn) {
  const cwd = tmpCwdWithRegistry();
  const relay = startRelay(cwd, extraArgs);
  try {
    const ports = await relay.ready;
    await fn({ cwd, ...ports, out: relay.out, token: loadIdentity(humanIdentityPath(cwd)).relay_token });
  } finally {
    await killChild(relay.child);
    await rmCwd(cwd);
  }
}

test('a ticket issued on the HTTP port is redeemed on the stream port and receives room.updated', async () => {
  const cwd = tmpCwdWithRegistry();
  const system = path.join(cwd, 'system.json');
  saveIdentity(system, createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' }));
  const relay = startRelay(cwd, ['--browser-origin', ORIGIN, '--room-human-identity', humanIdentityPath(cwd), '--room-system-identity', system]);
  try {
    const { port, streamPort } = await relay.ready;
    const token = loadIdentity(humanIdentityPath(cwd)).relay_token;
    const room = await call(port, 'POST', '/v1/rooms', { token, body: { name: 'general' } });
    assert.equal(room.status, 201, JSON.stringify(room.body));
    const roomId = room.body.room.conversation_id;
    const ticket = await call(port, 'POST', '/v1/rooms/ws-ticket', { token });
    assert.equal(ticket.status, 200, JSON.stringify(ticket.body));
    const ws = new WebSocket(`ws://127.0.0.1:${streamPort}/v1/stream?ticket=${ticket.body.ticket}`, { origin: ORIGIN });
    const frame = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no room.updated frame')), 10_000);
      ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'room.updated') { clearTimeout(timer); resolve(m); } });
      ws.on('close', (code) => { clearTimeout(timer); reject(new Error(`socket closed ${code}`)); });
    });
    frame.catch(() => {});
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    const sent = await call(port, 'POST', `/v1/rooms/${roomId}/messages`, { token, body: { text: 'hi', idempotency_key: 'k1' } });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal((await frame).room_id, roomId);
    ws.close();
    // The ticket never reaches the relay's own output.
    assert.equal(relay.out.text.includes(ticket.body.ticket), false);
  } finally {
    await killChild(relay.child);
    await rmCwd(cwd);
  }
});

test('--browser-origin makes a preflight from that origin succeed', async () => {
  await withRelay(['--browser-origin', ORIGIN], async ({ port }) => {
    const res = await call(port, 'OPTIONS', '/v1/rooms/ws-ticket', { origin: ORIGIN });
    assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
  });
});

test('without --browser-origin no browser origin is answered', async () => {
  await withRelay([], async ({ port }) => {
    const res = await call(port, 'OPTIONS', '/v1/rooms/ws-ticket', { origin: ORIGIN });
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });
});

test('--browser-origin given twice allows both origins', async () => {
  await withRelay(['--browser-origin', ORIGIN, '--browser-origin', 'https://other.example'], async ({ port }) => {
    for (const origin of [ORIGIN, 'https://other.example']) {
      const res = await call(port, 'OPTIONS', '/v1/rooms/ws-ticket', { origin });
      assert.equal(res.headers['access-control-allow-origin'], origin);
    }
    const denied = await call(port, 'OPTIONS', '/v1/rooms/ws-ticket', { origin: 'https://evil.example' });
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
  });
});

test('--room-human-identity with a key that differs from the registry exits non-zero before listening', () => {
  const cwd = tmpCwdWithRegistry();
  try {
    const real = loadIdentity(humanIdentityPath(cwd));
    const forged = path.join(cwd, 'forged.json');
    saveIdentity(forged, { ...createIdentity({ ownerId: real.owner_id, endpointId: real.endpoint_id, kind: 'human' }), key_id: real.key_id });
    const result = spawnSync(process.execPath, [sigilCli, 'relay', 'up', '--port', '0', '--room-human-identity', forged], { cwd, encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.status, 1, `${result.stderr}${result.stdout}`);
    assert.match(result.stderr, /ROOM_HUMAN_KEY_MISMATCH/);
    assert.doesNotMatch(result.stdout, /listening/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('without --room-human-identity the send route answers 503', async () => {
  await withRelay([], async ({ port, token }) => {
    const room = await call(port, 'POST', '/v1/rooms', { token, body: { name: 'general' } });
    assert.equal(room.status, 201, JSON.stringify(room.body));
    const sent = await call(port, 'POST', `/v1/rooms/${room.body.room.conversation_id}/messages`, { token, body: { text: 'hi', idempotency_key: 'k1' } });
    assert.equal(sent.status, 503, JSON.stringify(sent.body));
  });
});
