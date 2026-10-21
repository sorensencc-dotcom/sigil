import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { freeDistinctPorts } from '../../../test-support/free-ports.mjs';
import { assertDisposableTestDatabase } from '../../../scripts/assert-disposable-test-db.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const sigilCli = fileURLToPath(new URL('../../../cli/sigil.mjs', import.meta.url));

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32' && child.pid) { try { execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' }); } catch { /* gone */ } }
    else child.kill('SIGTERM');
  } catch { /* ignore */ }
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
}

const call = (port, method, urlPath, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
    let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject); req.end();
});

test('relay up --public-origin prints the proxy table and serves only the cookie routes on the public port', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.end();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-relay-up-oauth-'));
  execFileSync(process.execPath, [sigilCli, 'init', 'alice'], { cwd, encoding: 'utf8' });
  const [port, streamPort, publicPort] = await freeDistinctPorts(3);
  const env = { ...process.env, SIGIL_WRAP_KEY_TEST: crypto.randomBytes(32).toString('base64'), GITHUB_OAUTH_CLIENT_ID: 'id', GITHUB_OAUTH_CLIENT_SECRET: 'secret' };
  const child = spawn(process.execPath, [sigilCli, 'relay', 'up', '--port', String(port), '--stream-port', String(streamPort), '--public-port', String(publicPort), '--database-url', connectionString,
    '--public-origin', 'https://rooms.test', '--room-key-wrap-key', 'SIGIL_WRAP_KEY_TEST',
    '--room-human-identity', path.join(cwd, '.sigil', 'alice.identity.json')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { text: '' };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { out.text += c; }); child.stderr.on('data', (c) => { out.text += c; });
  t.after(async () => { await killChild(child); fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${out.text}`)), 20_000);
    const poll = setInterval(() => { if (out.text.includes('Registered endpoints:')) { clearInterval(poll); clearTimeout(timer); resolve(); } }, 25);
    child.once('exit', (code) => { clearInterval(poll); clearTimeout(timer); reject(new Error(`exited early (${code}): ${out.text}`)); });
  });
  assert.match(out.text, /Public origin: https:\/\/rooms\.test/);
  assert.ok(out.text.includes(`Cookie-only listener: 127.0.0.1:${publicPort}`), out.text);
  assert.match(out.text, /Proxy table \(dedicated hostname required\):/);
  assert.ok(out.text.includes(`  /v1/*        -> 127.0.0.1:${publicPort}   (includes the /v1/stream upgrade)`), out.text);
  assert.match(out.text, /Set-Cookie, Origin, and Host must pass through unchanged\./);

  assert.equal((await call(publicPort, 'GET', '/v1/health')).status, 404);
  assert.equal((await call(publicPort, 'POST', '/v1/envelopes')).status, 404);
  // Cookie routes answer 401 without a session cookie.
  assert.equal((await call(publicPort, 'GET', '/v1/auth/me')).status, 401);
  // The main port is unchanged: bearer-only, no cookie auth.
  assert.equal((await call(port, 'GET', '/v1/rooms', { cookie: '__Host-sigil_session=abc' })).status, 401);
});
