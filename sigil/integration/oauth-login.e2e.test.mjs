// End to end for the third-party (GitHub) login topology: a real `sigil relay up
// --public-origin --enable-mock-oauth`, the real static server in cookie mode,
// a fake GitHub, and a loopback TLS proxy in front of both (one origin, /v1/* to
// the relay's public listener). Needs SIGIL_TEST_DATABASE_URL (disposable DB).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync, spawn } from 'node:child_process';
import pg from 'pg';
import { WebSocket } from 'ws';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';
import { PostgresRepository } from '../relay/v1/postgres-repository.mjs';
import { withTransaction } from '../relay/v1/with-transaction.mjs';
import { createInvite } from '../relay/v1/oauth/invites.mjs';
import { MOCK_OAUTH_ISSUER } from '../relay/v1/oauth/wiring.mjs';
import { SESSION_COOKIE, FLOW_COOKIE } from '../relay/v1/oauth/cookies.mjs';
import { createIdentity, saveIdentity } from '../cli/identity.mjs';
import { startLoopbackTlsProxy, TLS_CERT } from './fixtures/loopback-tls-proxy.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const sigilCli = fileURLToPath(new URL('../cli/sigil.mjs', import.meta.url));
const webBin = fileURLToPath(new URL('../../packages/sigil-rooms-web/bin/sigil-rooms-web.mjs', import.meta.url));
const SESSION = SESSION_COOKIE;
const FLOW = FLOW_COOKIE;

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  server.once('error', reject);
});

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32' && child.pid) { try { execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' }); } catch { /* gone */ } }
    else child.kill('SIGTERM');
  } catch { /* ignore */ }
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
}

function waitFor(child, out, needle, ms = 45_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${needle}": ${out.text}`)), ms);
    const poll = setInterval(() => { if (out.text.includes(needle)) { clearInterval(poll); clearTimeout(timer); resolve(); } }, 25);
    child.once('exit', (code) => { clearInterval(poll); clearTimeout(timer); reject(new Error(`exited early (${code}): ${out.text}`)); });
  });
}

function spawnLogged(args, options) {
  const child = spawn(process.execPath, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { text: '' };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { out.text += c; }); child.stderr.on('data', (c) => { out.text += c; });
  return { child, out };
}

// code "c<id>" exchanges for token "t<id>", which /user resolves to GitHub id <id>.
async function fakeGitHub(t) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/token') {
      let body = ''; for await (const c of req) body += c;
      return res.end(JSON.stringify({ access_token: `t${new URLSearchParams(body).get('code').slice(1)}`, token_type: 'bearer' }));
    }
    const id = (req.headers.authorization ?? '').replace('Bearer t', '');
    return res.end(JSON.stringify({ id: Number(id), login: `u${id}`, name: `GH ${id}` }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return `http://127.0.0.1:${server.address().port}`;
}

// HTTPS client that trusts the fixture certificate and keeps no cookie state.
function makeClient(port) {
  const send = (method, urlPath, { headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, method, path: urlPath, headers, ca: TLS_CERT }, (res) => {
      let data = ''; res.setEncoding('utf8'); res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('request timed out: ' + method + ' ' + urlPath)));
    req.end(body);
  });
  return send;
}

const cookieOf = (res, name) => {
  const header = [].concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`) && !/Max-Age=0/.test(c));
  return header ? header.split(';')[0].slice(name.length + 1) : null;
};

async function setup(t) {
  assertDisposableTestDatabase(connectionString);
  const admin = new pg.Pool({ connectionString });
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-oauth-e2e-'));
  const cli = (...args) => execFileSync(process.execPath, [sigilCli, ...args], { cwd, encoding: 'utf8' });
  cli('init', 'alice');
  cli('init', 'router', '--owner', 'usr_alice@local', '--kind', 'agent');
  cli('init', 'bot', '--owner', 'usr_alice@local', '--kind', 'agent');
  const identityPath = (name) => path.join(cwd, '.sigil', `${name}.identity.json`);
  const readIdentity = (name) => JSON.parse(fs.readFileSync(identityPath(name), 'utf8'));
  const systemIdentity = createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' });
  saveIdentity(identityPath('relay_system'), systemIdentity);

  const github = await fakeGitHub(t);
  const relayPort = await freePort();
  const staticPort = await freePort();
  // The proxy port is the public origin, so reserve it before the relay starts.
  const proxyPort = await freePort();
  const origin = `https://127.0.0.1:${proxyPort}`;
  const streamPort = await freePort();
  const publicPort = await freePort();

  const relay = spawnLogged([sigilCli, 'relay', 'up', '--port', String(relayPort), '--stream-port', String(streamPort), '--public-port', String(publicPort), '--database-url', connectionString,
    '--public-origin', origin, '--enable-mock-oauth', '--room-key-wrap-key', 'SIGIL_WRAP_KEY_TEST',
    '--room-human-identity', identityPath('alice'), '--room-system-identity', identityPath('relay_system')],
  { cwd, env: { ...process.env, SIGIL_WRAP_KEY_TEST: crypto.randomBytes(32).toString('base64'), SIGIL_MOCK_OAUTH_BASE_URL: github } });
  const web = spawnLogged([webBin, '--auth-mode', 'cookie', '--public-origin', origin, '--port', String(staticPort)], { cwd });
  const pool = new pg.Pool({ connectionString });
  let proxy = null;
  t.after(async () => {
    await proxy?.close();
    await killChild(relay.child); await killChild(web.child);
    await pool.end();
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await waitFor(relay.child, relay.out, 'Registered endpoints:');
  await waitFor(web.child, web.out, 'Open http://');
  assert.ok(relay.out.text.includes(`Cookie-only listener: 127.0.0.1:${publicPort}`), relay.out.text);
  proxy = await startLoopbackTlsProxy({ relayPort: publicPort, staticPort, port: proxyPort });
  assert.equal(proxy.origin, origin);

  return {
    cwd, cli, origin, relayPort, publicPort, send: makeClient(proxy.port), pool, repository: new PostgresRepository({ pool }),
    identityPath, readIdentity, relay, proxy,
  };
}

// Full login through the proxy: start (browser-style form POST) -> fake GitHub -> callback.
async function login(ctx, { token, githubId }) {
  const start = await ctx.send('POST', '/v1/auth/oauth/github/start', {
    headers: { origin: ctx.origin, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams(token ? { invite: token } : {}).toString(),
  });
  assert.equal(start.status, 302, start.body);
  const flow = cookieOf(start, FLOW);
  assert.ok(flow, `start must set the flow cookie: ${start.headers.location}`);
  const state = new URL(start.headers.location).searchParams.get('state');
  const done = await ctx.send('GET', `/v1/auth/oauth/github/callback?state=${state}&code=c${githubId}`, { headers: { cookie: `${FLOW}=${flow}` } });
  return { start, done, session: cookieOf(done, SESSION) };
}

const mutating = (ctx, session, extra = {}) => ({ cookie: `${SESSION}=${session}`, origin: ctx.origin, 'x-sigil-csrf': '1', 'content-type': 'application/json', ...extra });
const readOnly = (session) => ({ headers: { cookie: `${SESSION}=${session}` } });

test('one-origin topology: operator and guest login, refusal, proxy surface, ws lifecycle', { skip: !connectionString }, async (t) => {
  const ctx = await setup(t);
  t.after(() => { if (process.env.E2E_DEBUG) console.log(ctx.relay.out.text.split(String.fromCharCode(10)).slice(-40).join(String.fromCharCode(10))); });

  if (process.env.E2E_DEBUG) console.error("step 1", Date.now() % 1000000);
  // 1. Operator invite (pinned to the operator's own human) redeemed through start -> GitHub -> callback.
  const operatorEndpoint = ctx.readIdentity('alice').endpoint_id;
  const { token: operatorToken } = await withTransaction(ctx.pool, (c) => createInvite(c, {
    name: 'self', createdByHumanId: 'usr_alice@local', ttlMs: 600_000,
    target: { humanId: 'usr_alice@local', endpointId: operatorEndpoint, issuer: MOCK_OAUTH_ISSUER, subject: '777' },
  }));
  const operator = await login(ctx, { token: operatorToken, githubId: 777 });
  // The browser form POST carries no X-Sigil-CSRF header: `start` must still work (Origin check only).
  assert.equal(operator.start.status, 302);
  assert.equal(operator.done.status, 302);
  assert.ok(operator.session, 'callback must set the session cookie');
  const setCookies = [].concat(operator.done.headers['set-cookie']);
  assert.ok(setCookies.some((c) => c.startsWith(`${SESSION}=`) && /Secure/i.test(c) && /HttpOnly/i.test(c) && /Path=\//.test(c) && !/Domain=/i.test(c)), setCookies.join('\n'));
  const me = JSON.parse((await ctx.send('GET', '/v1/auth/me', readOnly(operator.session))).body);
  assert.deepEqual([me.human_id, me.endpoint_id, me.is_operator], ['usr_alice@local', operatorEndpoint, true]);

  // Room, router, and an owner-only agent, seeded for the invocation check.
  const created = await ctx.send('POST', '/v1/rooms', { headers: mutating(ctx, operator.session), body: JSON.stringify({ name: 'e2e' }) });
  assert.equal(created.status, 201, created.body);
  const roomId = JSON.parse(created.body).room.conversation_id;
  const router = ctx.readIdentity('router');
  const bot = ctx.readIdentity('bot');
  await ctx.repository.addRoomMember({ conversationId: roomId, endpointId: router.endpoint_id, role: 'member', responseMode: 'router', addedByHumanId: 'usr_alice@local', now: new Date() });
  await ctx.repository.addRoomMember({ conversationId: roomId, endpointId: bot.endpoint_id, role: 'member', responseMode: 'joins', addedByHumanId: 'usr_alice@local', now: new Date() });
  await ctx.repository.setRoomMemberInvokableBy({ conversationId: roomId, endpointId: bot.endpoint_id, invokableBy: 'owner' });

  if (process.env.E2E_DEBUG) console.error("step 2", Date.now() % 1000000);
  // 2. Guest invite via the operator CLI (one room, member); redeemed; the guest posts a signed message.
  const invited = ctx.cli('relay', 'invite', 'create', '--name', 'Guest', '--room', `${roomId}:member`, '--identity', ctx.identityPath('alice'),
    '--database-url', connectionString, '--public-origin', ctx.origin);
  const guestToken = invited.match(/\/invite#(\S+)/)?.[1];
  assert.ok(guestToken, invited);
  const guest = await login(ctx, { token: guestToken, githubId: 888 });
  assert.ok(guest.session);
  const guestMe = JSON.parse((await ctx.send('GET', '/v1/auth/me', readOnly(guest.session))).body);
  assert.equal(guestMe.is_operator, false);
  const sent = await ctx.send('POST', `/v1/rooms/${roomId}/messages`, { headers: mutating(ctx, guest.session), body: JSON.stringify({ text: 'hello from the guest', idempotency_key: 'g1' }) });
  assert.equal(sent.status, 201, sent.body);
  const messageId = JSON.parse(sent.body).message_id;
  const seen = JSON.parse((await ctx.send('GET', `/v1/rooms/${roomId}/messages?after_seq=0&limit=50`, readOnly(operator.session))).body);
  const row = seen.items.find((item) => (item.envelope?.message_id ?? item.message_id) === messageId);
  assert.ok(row, 'the owner must see the guest message');
  assert.equal((row.envelope ?? row).sender.endpoint_id, guestMe.endpoint_id);

  if (process.env.E2E_DEBUG) console.error("step 3", Date.now() % 1000000);
  // 3. A router pick of the owner-only agent, triggered by the guest, is refused.
  const pick = await new Promise((resolve, reject) => {
    const payload = JSON.stringify({ trigger_message_id: messageId, invoke: [bot.endpoint_id] });
    const req = http.request({ host: '127.0.0.1', port: ctx.relayPort, method: 'POST', path: `/v1/rooms/${roomId}/invocations`,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: `Bearer ${router.relay_token}` } }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject); req.end(payload);
  });
  assert.equal(pick.status, 200, JSON.stringify(pick.body));
  assert.deepEqual([pick.body.items[0].status, pick.body.items[0].reason, pick.body.items[0].subject_human_id], ['refused', 'not_allowed', guestMe.human_id]);

  if (process.env.E2E_DEBUG) console.error("step 4", Date.now() % 1000000);
  // 4. The bearer-only surface is not reachable through the proxy.
  for (const [method, p] of [['POST', '/v1/endpoint-tokens'], ['POST', '/v1/identities'], ['POST', '/v1/envelopes'], ['POST', '/v1/federation/envelopes'], ['GET', '/v1/health']]) {
    const res = await ctx.send(method, p, { headers: { cookie: `${SESSION}=${operator.session}`, origin: ctx.origin, 'x-sigil-csrf': '1' } });
    assert.equal(res.status, 404, `${method} ${p} -> ${res.status}`);
  }
  // /approve is not a /v1 path, so the proxy sends it to the static server: it must be the SPA shell, never the relay's approval page.
  const approve = await ctx.send('GET', '/approve');
  const shell = await ctx.send('GET', '/');
  assert.equal(approve.body, shell.body);
  assert.ok(!/passkey|webauthn|challenge/i.test(approve.body));
  const relayApprove = await ctx.send('GET', '/v1/approvals/ceremony');
  assert.equal(relayApprove.status, 404);

  if (process.env.E2E_DEBUG) console.error("step 6", Date.now() % 1000000);
  // 6. A ticketed WebSocket upgrade through the proxy works; logout closes it.
  const ticketRes = await ctx.send('POST', '/v1/rooms/ws-ticket', { headers: mutating(ctx, guest.session), body: '{}' });
  assert.equal(ticketRes.status, 200, ticketRes.body);
  const { ticket } = JSON.parse(ticketRes.body);
  const socket = new WebSocket(`wss://127.0.0.1:${ctx.proxy.port}/v1/stream?ticket=${ticket}`, { ca: TLS_CERT, headers: { origin: ctx.origin } });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('websocket did not open through the proxy')), 8000); socket.once('open', () => { clearTimeout(timer); resolve(); }); socket.once('error', reject); socket.once('close', (code) => reject(new Error('closed early ' + code))); });
  const closed = new Promise((resolve) => socket.once('close', resolve));
  const out = await ctx.send('POST', '/v1/auth/logout', { headers: mutating(ctx, guest.session), body: '{}' });
  assert.equal(out.status, 204);
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('logout did not close the websocket')), 5000))]);
  assert.equal((await ctx.send('GET', '/v1/auth/me', readOnly(guest.session))).status, 401);

  // A ticket from another origin is refused even with a fresh ticket.
  const second = JSON.parse((await ctx.send('POST', '/v1/rooms/ws-ticket', { headers: mutating(ctx, operator.session), body: '{}' })).body).ticket;
  const wrongOrigin = new WebSocket(`wss://127.0.0.1:${ctx.proxy.port}/v1/stream?ticket=${second}`, { ca: TLS_CERT, headers: { origin: 'https://evil.example' } });
  const wrongCode = await new Promise((resolve) => { wrongOrigin.once('close', resolve); wrongOrigin.once('error', () => resolve('error')); });
  assert.notEqual(wrongCode, 1000);
});

// 5. Header passthrough: the proxy must not rewrite Origin or Host, and must deliver
// __Host- Set-Cookie headers untouched. A recording stub stands in for the relay.
test('proxy passes Origin, Host, and __Host- Set-Cookie through unchanged', async (t) => {
  const seen = [];
  const stub = http.createServer((req, res) => {
    seen.push({ origin: req.headers.origin, host: req.headers.host, cookie: req.headers.cookie, url: req.url });
    res.writeHead(200, { 'set-cookie': [`${SESSION}=abc; Path=/; Secure; HttpOnly; SameSite=Lax`], 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { stub.closeAllConnections?.(); stub.close(r); }));
  const proxy = await startLoopbackTlsProxy({ relayPort: stub.address().port, staticPort: stub.address().port });
  t.after(() => proxy.close());
  const send = makeClient(proxy.port);
  const res = await send('POST', '/v1/auth/oauth/github/start', { headers: { origin: proxy.origin, cookie: `${FLOW}=x`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'invite=t' });
  assert.equal(res.status, 200);
  assert.deepEqual(seen[0], { origin: proxy.origin, host: `127.0.0.1:${proxy.port}`, cookie: `${FLOW}=x`, url: '/v1/auth/oauth/github/start' });
  assert.deepEqual([].concat(res.headers['set-cookie']), [`${SESSION}=abc; Path=/; Secure; HttpOnly; SameSite=Lax`]);
});
