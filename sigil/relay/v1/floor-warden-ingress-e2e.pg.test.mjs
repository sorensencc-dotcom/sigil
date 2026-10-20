import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { createIdentity, loadIdentity, saveIdentity } from '../../cli/identity.mjs';
import { createAgentDaemon } from '../../cli/agent-daemon.mjs';
import { createRedactingLogger, floorWardenSecrets } from '../../cli/redacting-logger.mjs';
import { createFloorWardenBridge } from '../../bridges/v1/floor-warden-bridge.mjs';
import { createSessionStore } from '../../bridges/v1/session-store.mjs';
import { RelayClient } from '../../connectors/v1/relay-client.mjs';
const { startLoopbackTlsProxy, TLS_CERT } = await import(new URL('../../integration/fixtures/loopback-tls-proxy.mjs', import.meta.url));

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const sigilCli = fileURLToPath(new URL('../../cli/sigil.mjs', import.meta.url));
const run = promisify(execFile);
const BOT_EP = 'ep_test_bot';
const BOT_ID = 'bot_test';
const OWNER = 'usr_web@local';
const BOT_WRAP_KEY = crypto.randomBytes(32).toString('base64');
const logs = [];
const world = {};

const random = () => crypto.randomBytes(18).toString('base64url');
const tokenFrom = (stdout) => stdout.split(/\r?\n/).findLast((line) => line.startsWith('fwr_'));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  server.once('error', reject);
});

async function waitFor(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(25);
  }
}

async function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) await run('taskkill', ['/F', '/T', '/PID', String(child.pid)]).catch(() => {});
  else child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
}

async function cli(cwd, args, { env = process.env } = {}) {
  return run(process.execPath, [sigilCli, ...args], { cwd, env: { ...env, SIGIL_E2E_BOT_WRAP_KEY: BOT_WRAP_KEY } });
}

function startFakeFloorWarden() {
  const hookPath = `/hooks/${random()}`;
  const key = random();
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== hookPath) { logs.push(`fake unknown ${req.method}`); return res.writeHead(404).end(); }
      if (req.headers.authorization !== `Bearer ${key}`) { logs.push('fake bad sender key'); return res.writeHead(401).end(); }
      const payload = JSON.parse(raw);
      received.push({ payload, raw });
      logs.push(`fake floor warden: received ${payload.delivery_key}`);
      res.writeHead(202).end();
    });
  });
  return {
    hookPath, key,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}${hookPath}`))),
    next: (count = 1) => waitFor(() => received[count - 1], `fake payload ${count}`),
    reply(payload, token, overrides = {}) {
      const body = {
        room_id: payload.room.id, target_bot_id: payload.target_bot.bot_id, sender: payload.target_bot.endpoint_id,
        in_reply_to: payload.reply.in_reply_to, text: 'Answer from the fake Floor Warden',
        idempotency_key: payload.reply.idempotency_key, ...overrides,
      };
      return postJson(new URL(payload.reply.url), body, token).then((result) => {
        logs.push(`fake floor warden: reply ${result.status} ${result.body?.code ?? (result.body?.duplicate ? 'duplicate' : 'accepted')}`);
        return result;
      });
    },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

function postJson(url, body, token) {
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: 'POST', ca: TLS_CERT,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

function startRelay(cwd, args, env) {
  const child = spawn(process.execPath, [sigilCli, 'relay', 'up', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const capture = (stream) => (chunk) => { output += chunk; logs.push(`relay ${stream} ${chunk}`); };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay did not start: ${output}`)), 30_000);
    const poll = setInterval(() => {
      const match = output.match(/Sigil relay listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match && output.includes('Registered endpoints:')) { clearInterval(poll); clearTimeout(timer); resolve(match[1]); }
    }, 25);
    child.once('exit', (code) => { clearInterval(poll); clearTimeout(timer); reject(new Error(`relay exited (${code}): ${output}`)); });
  });
  return { child, ready };
}

async function startBot({ identityPath, relayUrl, replyUrl, webhookUrl, webhookKey, dir }) {
  const identity = loadIdentity(identityPath);
  const secrets = floorWardenSecrets({ webhookUrl, key: webhookKey, relayToken: identity.relay_token });
  const sink = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((level) => [level, (line) => logs.push(`bot ${level} ${line}`)]));
  const { logger } = createRedactingLogger({ secrets, sink });
  const bridge = (replyTimeoutMs, sessionFile) => createFloorWardenBridge({ identity, bot: { bot_id: BOT_ID }, relay: new RelayClient({ baseUrl: relayUrl, token: identity.relay_token }),
    sessions: createSessionStore(path.join(dir, sessionFile)), webhook: { url: webhookUrl, key: webhookKey }, replyUrl, replyTimeoutMs, pollIntervalMs: 100, logger });
  const slow = bridge(60_000, 'sessions.json');
  const fast = bridge(1_500, 'sessions-fast.json');
  const fastRooms = new Set();
  const daemon = createAgentDaemon({ identity, relayUrl, logger, pollIntervalMs: 100,
    onRoomMessage: (item) => (fastRooms.has(item.envelope.conversation_id) ? fast : slow).handle(item),
    onStart: () => Promise.all([slow.recover(), fast.recover()]), onStop: () => { slow.close(); fast.close(); } });
  daemon.start();
  return { daemon, identity, fastRooms };
}

test.before(async () => {
  if (!connectionString) return;
  assertDisposableTestDatabase(connectionString);
  const originalLog = console.log;
  console.log = (...args) => logs.push(`migrate ${args.join(' ')}`);
  try { await applyMigrations(connectionString, { reset: true }); } finally { console.log = originalLog; }
  world.pool = new pg.Pool({ connectionString });
  world.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-fw-ingress-e2e-'));
  await cli(world.dir, ['init', 'web', '--kind', 'human']);
  await cli(world.dir, ['init', 'agent', '--owner', OWNER, '--kind', 'agent']);
  await world.pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW()) ON CONFLICT DO NOTHING`, [OWNER]);
  const botPath = path.join(world.dir, '.sigil', `${BOT_EP}.json`);
  await cli(world.dir, ['bot', 'add', '--bot-id', BOT_ID, '--endpoint', BOT_EP, '--name', 'Test Bot', '--identity', path.join(world.dir, '.sigil', 'web.identity.json'),
    '--config', path.join(world.dir, 'none.json'), '--out', botPath, '--registry', path.join(world.dir, '.sigil', 'registry.json'), '--database-url', connectionString, '--room-bot-key-wrap-key', 'SIGIL_E2E_BOT_WRAP_KEY']);
  const tokenResult = await cli(world.dir, ['bot', 'token', 'create', '--bot-id', BOT_ID, '--database-url', connectionString]);
  world.oldToken = tokenFrom(tokenResult.stdout);
  const tokenRow = await world.pool.query('SELECT token_id FROM floor_warden_reply_tokens WHERE bot_id = $1 ORDER BY created_at DESC LIMIT 1', [BOT_ID]);
  world.oldTokenId = tokenRow.rows[0].token_id;
  const systemPath = path.join(world.dir, 'system.identity.json');
  saveIdentity(systemPath, createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' }));
  world.fake = startFakeFloorWarden();
  const webhookUrl = await world.fake.listen();
  world.ingressPort = await freePort();
  const relayPort = await freePort();
  const streamPort = await freePort();
  world.proxy = await startLoopbackTlsProxy({ relayPort: world.ingressPort, staticPort: relayPort });
  const relay = startRelay(world.dir, ['--port', String(relayPort), '--stream-port', String(streamPort), '--ingress-port', String(world.ingressPort), '--ingress-origin', world.proxy.origin,
    '--database-url', connectionString, '--room-human-identity', path.join(world.dir, '.sigil', 'web.identity.json'), '--room-system-identity', systemPath, '--room-bot-key-wrap-key', 'SIGIL_E2E_BOT_WRAP_KEY'],
  { ...process.env, SIGIL_E2E_BOT_WRAP_KEY: BOT_WRAP_KEY });
  world.relayChild = relay.child;
  world.relayUrl = await relay.ready;
  world.web = loadIdentity(path.join(world.dir, '.sigil', 'web.identity.json'));
  world.bot = await startBot({ identityPath: botPath, relayUrl: world.relayUrl, replyUrl: world.proxy.origin, webhookUrl, webhookKey: world.fake.key, dir: world.dir });
  world.botIdentity = world.bot.identity;
}, { timeout: 90_000 });

test.after(async () => {
  world.bot?.daemon.stop();
  await stopTree(world.relayChild);
  await world.proxy?.close();
  await world.fake?.close();
  await world.pool?.end();
  if (world.dir) fs.rmSync(world.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function api(method, urlPath, body) {
  const response = await fetch(`${world.relayUrl}${urlPath}`, { method, headers: { authorization: `Bearer ${world.web.relay_token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : null };
}

let roomCount = 0;
async function newRoom(label) {
  const created = await api('POST', '/v1/rooms', { name: `${label}-${++roomCount}-${random().slice(0, 6)}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const roomId = created.body.room.conversation_id;
  const member = await api('POST', `/v1/rooms/${roomId}/members`, { endpoint_id: BOT_EP, response_mode: 'mentions_only' });
  assert.equal(member.status, 201, JSON.stringify(member.body));
  return roomId;
}

async function say(roomId, text) {
  const result = await api('POST', `/v1/rooms/${roomId}/messages`, { text, mentions: [BOT_EP], idempotency_key: crypto.randomUUID() });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return { message_id: result.body.message_id, room_seq: Number(result.body.room_seq) };
}

async function invocation(roomId, triggerId, status) {
  return waitFor(async () => {
    const result = await api('GET', `/v1/rooms/${roomId}/invocations?endpoint_id=${BOT_EP}`);
    const row = result.body.items.find((item) => item.trigger_message_id === triggerId);
    return row?.status === status ? row : null;
  }, `${status} invocation`);
}

const messages = async (roomId) => (await api('GET', `/v1/rooms/${roomId}/messages?after_seq=0&limit=500`)).body.items;
const skip = !connectionString;

test('happy path: the TLS proxy carries a bot reply into the thread', { skip, timeout: 60_000 }, async () => {
  const roomId = await newRoom('happy');
  const trigger = await say(roomId, 'hello @Test Bot');
  const frame = await world.fake.next();
  const reply = await world.fake.reply(frame.payload, world.oldToken);
  assert.equal(reply.status, 202, JSON.stringify(reply.body));
  assert.equal(reply.body.duplicate, false);
  const rows = await messages(roomId);
  assert.equal(rows.filter((row) => row.envelope.sender.endpoint_id === BOT_EP).length, 1);
  assert.equal((await invocation(roomId, trigger.message_id, 'completed')).reply_message_id, reply.body.message_id);
});

test('duplicate reply: the second TLS call returns duplicate true', { skip, timeout: 60_000 }, async () => {
  const roomId = await newRoom('duplicate');
  await say(roomId, 'hello again @Test Bot');
  const frame = await world.fake.next(2);
  const first = await world.fake.reply(frame.payload, world.oldToken);
  const second = await world.fake.reply(frame.payload, world.oldToken, { text: 'changed' });
  assert.equal(first.status, 202);
  assert.deepEqual([second.status, second.body.duplicate], [202, true]);
});

test('stale reply: an older trigger is refused while a newer invocation runs', { skip, timeout: 60_000 }, async () => {
  const roomId = await newRoom('stale');
  const older = await say(roomId, 'first @Test Bot');
  const first = await world.fake.next(3);
  assert.equal((await world.fake.reply(first.payload, world.oldToken)).status, 202);
  await invocation(roomId, older.message_id, 'completed');
  const newer = await say(roomId, 'second @Test Bot');
  const second = await world.fake.next(4);
  const stale = await world.fake.reply(second.payload, world.oldToken, { in_reply_to: older.message_id, idempotency_key: `${older.message_id}:late` });
  assert.deepEqual([stale.status, stale.body.code], [403, 'ROOM_NOT_INVOKED']);
  assert.equal((await invocation(roomId, newer.message_id, 'running')).reply_message_id, null);
  assert.equal((await world.fake.reply(second.payload, world.oldToken)).status, 202);
});

test('timeout: the proxy receives no reply before the short deadline', { skip, timeout: 60_000 }, async () => {
  const roomId = await newRoom('timeout');
  world.bot.fastRooms?.add(roomId);
  const trigger = await say(roomId, 'wait for me @Test Bot');
  await world.fake.next(5);
  const failed = await invocation(roomId, trigger.message_id, 'failed');
  assert.equal(failed.reason, 'REPLY_TIMEOUT');
  const rows = await messages(roomId);
  assert.ok(rows.some((row) => row.envelope.body?.kind === 'invocation_failed' && row.envelope.body.reason === 'REPLY_TIMEOUT'));
});

test('token rotation mid-run: old grace token and new token both work', { skip, timeout: 60_000 }, async () => {
  const roomId = await newRoom('rotate');
  const first = await say(roomId, 'rotate me @Test Bot');
  const firstFrame = await world.fake.next(6);
  const rotated = await cli(world.dir, ['bot', 'token', 'rotate', '--bot-id', BOT_ID, '--grace-minutes', '5', '--database-url', connectionString]);
  world.newToken = tokenFrom(rotated.stdout);
  assert.equal((await world.fake.reply(firstFrame.payload, world.oldToken)).status, 202);
  await invocation(roomId, first.message_id, 'completed');
  const second = await say(roomId, 'use new token @Test Bot');
  const secondFrame = await world.fake.next(7);
  assert.equal((await world.fake.reply(secondFrame.payload, world.newToken)).status, 202);
  await invocation(roomId, second.message_id, 'completed');
});

test('revoke: a token revoked in Postgres is refused by the next ingress call', { skip, timeout: 60_000 }, async () => {
  const roomId = await newRoom('revoke');
  const trigger = await say(roomId, 'revoke me @Test Bot');
  const frame = await world.fake.next(8);
  const token = world.newToken ?? world.oldToken;
  const row = await world.pool.query('SELECT token_id FROM floor_warden_reply_tokens WHERE bot_id = $1 AND status = \'active\' ORDER BY created_at DESC LIMIT 1', [BOT_ID]);
  await cli(world.dir, ['bot', 'token', 'revoke', '--bot-id', BOT_ID, '--token-id', row.rows[0].token_id, '--database-url', connectionString]);
  const result = await world.fake.reply(frame.payload, token);
  assert.deepEqual([result.status, result.body.code], [401, 'UNAUTHENTICATED']);
  assert.equal((await invocation(roomId, trigger.message_id, 'running')).reply_message_id, null);
});

test('secrets: relay, bridge and fake logs contain no reply token, relay token, or webhook path', { skip, timeout: 60_000 }, async () => {
  const text = logs.join('\n');
  for (const secret of [world.oldToken, world.newToken, world.web.relay_token, world.botIdentity.relay_token, world.fake.hookPath, world.fake.hookPath.slice(1)]) {
    assert.equal(text.includes(secret), false, 'secret appeared in captured logs');
  }
});
