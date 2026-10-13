// Cross-process: a CLI command in a second process reaches a running relay
// through the sigil_admin NOTIFY channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync, execSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { WebSocket } from 'ws';
import { loadIdentity } from './identity.mjs';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');
const run = promisify(execFile);

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

function startRelay(cwd) {
  const child = spawn(process.execPath, [sigilCli, 'relay', 'up', '--port', '0', '--stream-port', '0', '--database-url', connectionString], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { text: '' };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { out.text += c; });
  child.stderr.on('data', (c) => { out.text += c; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for relay: ${out.text}`)), 30_000);
    const poll = setInterval(() => {
      const httpMatch = out.text.match(/Sigil relay listening on http:\/\/127\.0\.0\.1:(\d+)/);
      const wsMatch = out.text.match(/Sigil stream \(push notify\) on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (httpMatch && wsMatch) { clearInterval(poll); clearTimeout(timer); resolve({ port: Number(httpMatch[1]), streamPort: Number(wsMatch[1]) }); }
    }, 25);
    child.once('exit', (code) => { clearInterval(poll); clearTimeout(timer); reject(new Error(`relay exited early (${code}): ${out.text}`)); });
  });
  return { child, out, ready };
}

function get(port, urlPath, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'GET', path: urlPath, headers: { authorization: `Bearer ${token}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('endpoint revoke from a second process closes the live bearer socket and 401s the next request before the cache TTL', { skip: !connectionString, timeout: 60_000 }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-admin-listener-'));
  let relay = null;
  let socket = null;
  // One hook, in order: hooks run first-registered-first, and the relay must
  // be dead before its cwd can be removed on Windows.
  t.after(async () => {
    socket?.terminate();
    if (relay) await killChild(relay.child);
    await rmCwd(cwd);
    await pool.end();
  });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  execFileSync(process.execPath, [sigilCli, 'init', 'bot', '--kind', 'agent'], { cwd, encoding: 'utf8' });
  const identity = loadIdentity(path.join(cwd, '.sigil', 'bot.identity.json'));

  relay = startRelay(cwd);
  const { port, streamPort } = await relay.ready;

  // Warm the authenticator cache so a 401 below proves the NOTIFY cleared it.
  assert.equal(await get(port, '/v1/inbox', identity.relay_token), 200);

  socket = new WebSocket(`ws://127.0.0.1:${streamPort}/v1/stream`, { headers: { authorization: `Bearer ${identity.relay_token}` } });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const closed = new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString(), at: Date.now() })));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(socket.readyState, WebSocket.OPEN, `socket should stay open while live: ${relay.out.text}`);

  await run(process.execPath, [sigilCli, 'endpoint', 'revoke', identity.endpoint_id, '--database-url', connectionString]);
  const revokedAt = Date.now();

  const close = await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error(`socket not closed within 2 s: ${relay.out.text}`)), 2000))]);
  assert.equal(close.code, 1008);
  assert.equal(close.reason, 'unauthorized');
  assert.equal(await get(port, '/v1/inbox', identity.relay_token), 401);
  assert.ok(Date.now() - revokedAt < 5000, 'rejected before the 5 s cache TTL would have expired');
});

test('human suspend from a second process closes every socket of that human', { skip: !connectionString, timeout: 60_000 }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-admin-suspend-'));
  let relay = null;
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    if (relay) await killChild(relay.child);
    await rmCwd(cwd);
    await pool.end();
  });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  // One human, two endpoints: both must close.
  const owner = 'usr_pat@local';
  for (const name of ['bot1', 'bot2']) execFileSync(process.execPath, [sigilCli, 'init', name, '--kind', 'agent', '--owner', owner], { cwd, encoding: 'utf8' });
  const identities = ['bot1', 'bot2'].map((name) => loadIdentity(path.join(cwd, '.sigil', `${name}.identity.json`)));

  relay = startRelay(cwd);
  const { port, streamPort } = await relay.ready;

  const closes = [];
  for (const identity of identities) {
    assert.equal(await get(port, '/v1/inbox', identity.relay_token), 200);
    const socket = new WebSocket(`ws://127.0.0.1:${streamPort}/v1/stream`, { headers: { authorization: `Bearer ${identity.relay_token}` } });
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    closes.push(new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(sockets.every((socket) => socket.readyState === WebSocket.OPEN), `sockets should stay open while live: ${relay.out.text}`);

  await run(process.execPath, [sigilCli, 'human', 'suspend', owner, '--database-url', connectionString]);
  const suspendedAt = Date.now();

  const results = await Promise.race([Promise.all(closes), new Promise((_, reject) => setTimeout(() => reject(new Error(`sockets not closed within 2 s: ${relay.out.text}`)), 2000))]);
  assert.deepEqual(results, [{ code: 1008, reason: 'unauthorized' }, { code: 1008, reason: 'unauthorized' }]);
  for (const identity of identities) assert.equal(await get(port, '/v1/inbox', identity.relay_token), 401);
  assert.ok(Date.now() - suspendedAt < 5000, 'rejected before the 5 s cache TTL would have expired');

  await run(process.execPath, [sigilCli, 'human', 'unsuspend', owner, '--database-url', connectionString]);
  const deadline = Date.now() + 5000;
  while (await get(port, '/v1/inbox', identities[0].relay_token) !== 200) {
    if (Date.now() > deadline) throw new Error('unsuspend did not restore access');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

// Spec Testing, cross-process: `human add` in a second process reaches a live
// relay and a live stream socket. The operator's socket learns of the new
// member through room.updated without any request to the relay.
test('human add --room from a second process sends room.updated to the operator socket of a running relay', { skip: !connectionString, timeout: 60_000 }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-admin-human-add-'));
  let relay = null;
  let socket = null;
  t.after(async () => {
    socket?.terminate();
    if (relay) await killChild(relay.child);
    await rmCwd(cwd);
    await pool.end();
  });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  const owner = 'usr_op@local';
  execFileSync(process.execPath, [sigilCli, 'init', 'op', '--owner', owner], { cwd, encoding: 'utf8' });
  const identityPath = path.join(cwd, '.sigil', 'op.identity.json');
  const operator = loadIdentity(identityPath);

  relay = startRelay(cwd);
  const { port, streamPort } = await relay.ready;

  const now = new Date().toISOString();
  await pool.query(`INSERT INTO workspaces (workspace_id, name, created_by, created_at) VALUES ('ws_x', 'ws_x', $1, $2)`, [owner, now]);
  await pool.query(`INSERT INTO conversations (conversation_id, kind, created_by, created_at) VALUES ('room_x', 'room', $1, $2)`, [owner, now]);
  await pool.query(`INSERT INTO rooms (conversation_id, workspace_id, name, created_at) VALUES ('room_x', 'ws_x', 'room_x', $1)`, [now]);
  await pool.query(`INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at) VALUES ('room_x', $1, 'owner', $2, $3)`, [operator.endpoint_id, owner, now]);

  assert.equal(await get(port, '/v1/inbox', operator.relay_token), 200);
  socket = new WebSocket(`ws://127.0.0.1:${streamPort}/v1/stream`, { headers: { authorization: `Bearer ${operator.relay_token}` } });
  const frames = [];
  socket.on('message', (data) => { try { frames.push(JSON.parse(data)); } catch { /* not JSON */ } });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const env = { ...process.env, SIGIL_WRAP_KEY_TEST: crypto.randomBytes(32).toString('base64') };
  const { stdout } = await run(process.execPath, [sigilCli, 'human', 'add', '--name', 'Guest', '--room', 'room_x:member', '--identity', identityPath, '--database-url', connectionString, '--room-key-wrap-key', 'SIGIL_WRAP_KEY_TEST'], { env });
  const guestEndpoint = /endpoint_id: (ep_[0-9a-f]{32})/.exec(stdout)?.[1];
  assert.ok(guestEndpoint, stdout);

  const deadline = Date.now() + 5000;
  while (!frames.some((f) => f.type === 'room.updated' && f.room_id === 'room_x' && f.changed === 'members')) {
    if (Date.now() > deadline) throw new Error(`no room.updated frame: ${JSON.stringify(frames)} ${relay.out.text}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(socket.readyState, WebSocket.OPEN, 'the operator socket stays open');
  const member = await pool.query('SELECT role FROM conversation_members WHERE conversation_id = $1 AND endpoint_id = $2', ['room_x', guestEndpoint]);
  assert.equal(member.rows[0].role, 'member');
});
