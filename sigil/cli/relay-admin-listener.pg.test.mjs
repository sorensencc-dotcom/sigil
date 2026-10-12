// Cross-process: a CLI command in a second process reaches a running relay
// through the sigil_admin NOTIFY channel.
import test from 'node:test';
import assert from 'node:assert/strict';
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

test('human suspend from a second process closes every socket of that human', { skip: 'waits for Task 15 (human suspend command)' }, () => {});
