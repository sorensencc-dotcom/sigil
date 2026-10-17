// Rooms phase 6, Task 14: the Floor Warden bridge end to end against a fake
// routine. A real `sigil relay up` runs on a disposable Postgres with the reply
// token and the bot wrap key set through the environment. `sigil bot add`
// provisions the fixture bot (ep_test_bot, bot_test), whose receive-only
// identity drives a real agent daemon running the Floor Warden bridge. The fake
// Floor Warden is a node:http server on 127.0.0.1 with a random path and key;
// it receives the payload and calls the relay's reply route. No real network
// service runs. Skipped without SIGIL_TEST_DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { execFile, execSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { createIdentity, identityKeys, loadIdentity, saveIdentity } from '../../cli/identity.mjs';
import { createAgentDaemon } from '../../cli/agent-daemon.mjs';
import { createRedactingLogger, floorWardenSecrets } from '../../cli/redacting-logger.mjs';
import { createFloorWardenBridge } from '../../bridges/v1/floor-warden-bridge.mjs';
import { createSessionStore } from '../../bridges/v1/session-store.mjs';
import { RelayClient } from '../../connectors/v1/relay-client.mjs';
import { LocalOutbox } from '../../connectors/v1/local-outbox.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const sigilCli = fileURLToPath(new URL('../../cli/sigil.mjs', import.meta.url));
const run = promisify(execFile);
const random = () => crypto.randomBytes(18).toString('base64url');

const BOT_EP = 'ep_test_bot';
const BOT_ID = 'bot_test';
const OWNER = 'usr_web@local';
const AGENT_EP = 'ep_agent@local';
const REPLY_TOKEN = crypto.randomBytes(32).toString('hex');
const BOT_WRAP_KEY = crypto.randomBytes(32).toString('base64');
const FAST_REPLY_TIMEOUT_MS = 1500;

// Every line the relay, the bot daemon with its bridge, the fake Floor Warden,
// and the bot CLI write lands here; the secrets scenario scans all of it.
const logs = [];
const world = {};

async function waitFor(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(25);
  }
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch { /* already gone */ }
  return Promise.race([exited, delay(5000)]);
}

async function sigil(cwd, args) {
  const { stdout, stderr } = await run(process.execPath, [sigilCli, ...args], { cwd, env: { ...process.env, SIGIL_E2E_BOT_WRAP_KEY: BOT_WRAP_KEY } });
  logs.push(`cli ${stdout}${stderr}`);
}

// ---- fake Floor Warden ---------------------------------------------------------

function startFakeFloorWarden() {
  const hookPath = `/hooks/${random()}`;
  const key = random();
  const received = [];
  const plans = new Map();
  const roomOfInvocation = new Map();
  const log = (line) => logs.push(`fake floor warden: ${line}`);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== hookPath) { log(`${req.method} on an unknown path -> 404`); res.writeHead(404).end(); return; }
      if (req.headers.authorization !== `Bearer ${key}`) { log('bad sender key -> 401'); res.writeHead(401).end(); return; }
      const payload = JSON.parse(raw);
      const roomId = payload.room?.id ?? roomOfInvocation.get(payload.invocation?.id) ?? null;
      if (payload.room?.id) roomOfInvocation.set(payload.invocation.id, roomId);
      const plan = plans.get(roomId) ?? [];
      const status = payload.type === 'room.message' && plan.length ? plan.shift() : 202;
      received.push({ roomId, payload, raw, headers: req.headers, status });
      log(`${payload.type} ${payload.delivery_key} -> ${status}`);
      res.writeHead(status).end();
    });
  });
  const frames = (roomId, type = 'room.message') => received.filter((f) => f.roomId === roomId && f.payload.type === type);
  return {
    hookPath,
    key,
    received,
    frames,
    // Answer the next N room.message POSTs for this room with these statuses.
    plan(roomId, statuses) { plans.set(roomId, [...statuses]); },
    next(roomId, { type = 'room.message', count = 1 } = {}) {
      return waitFor(() => frames(roomId, type).length >= count && frames(roomId, type)[count - 1], `${type} frame #${count} for ${roomId}`);
    },
    async reply(payload, overrides = {}) {
      const body = {
        room_id: payload.room.id, target_bot_id: payload.target_bot.bot_id, sender: payload.target_bot.endpoint_id,
        in_reply_to: payload.reply.in_reply_to, text: 'Answer from the fake Floor Warden', idempotency_key: payload.reply.idempotency_key, ...overrides,
      };
      const res = await fetch(payload.reply.url, { method: 'POST', headers: { authorization: `Bearer ${REPLY_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const parsed = await res.json();
      log(`reply to ${body.in_reply_to} -> ${res.status} ${parsed.code ?? (parsed.duplicate ? 'duplicate' : 'accepted')}`);
      return { status: res.status, body: parsed };
    },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}${hookPath}`))),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

// ---- relay -----------------------------------------------------------------------

function startRelay(cwd, args, env) {
  const child = spawn(process.execPath, [sigilCli, 'relay', 'up', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  const capture = (stream) => (chunk) => { text += chunk; logs.push(`relay ${stream} ${chunk}`); };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', capture('stdout'));
  child.stderr.on('data', capture('stderr'));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay did not start: ${text}`)), 30_000);
    const poll = setInterval(() => {
      const match = text.match(/Sigil relay listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match && text.includes('Registered endpoints:')) { clearInterval(poll); clearTimeout(timer); resolve(match[1]); }
    }, 25);
    child.once('exit', (code) => { clearInterval(poll); clearTimeout(timer); reject(new Error(`relay exited (${code}): ${text}`)); });
  });
  return { child, ready };
}

// ---- bot daemon --------------------------------------------------------------------

// One real agent daemon for the bot, polling fast. Rooms in `fastRooms` go to a
// second bridge with a short reply deadline (the timeout scenario); every other
// room goes to a bridge whose deadline no scenario reaches. Both are real
// bridges with their own session store, recovered on start and closed on stop.
function startBotDaemon({ identityPath, relayUrl, webhookUrl, webhookKey, dir }) {
  const identity = loadIdentity(identityPath);
  // The same secrets `sigil agent run --room-bridge floor-warden` hands its logger.
  const secrets = floorWardenSecrets({ webhookUrl, key: webhookKey, relayToken: identity.relay_token });
  const sink = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((level) => [level, (line) => logs.push(`bot ${level} ${line}`)]));
  const { logger } = createRedactingLogger({ secrets, sink });
  const bridgeFor = (replyTimeoutMs, sessions) => createFloorWardenBridge({
    identity, bot: { bot_id: identity.bot_id }, relay: new RelayClient({ baseUrl: relayUrl, token: identity.relay_token }),
    sessions: createSessionStore(path.join(dir, sessions)), webhook: { url: webhookUrl, key: webhookKey },
    replyUrl: relayUrl, replyTimeoutMs, pollIntervalMs: 100, logger,
  });
  const slow = bridgeFor(10 * 60_000, 'sessions.json');
  const fast = bridgeFor(FAST_REPLY_TIMEOUT_MS, 'sessions-fast.json');
  const fastRooms = new Set();
  const daemon = createAgentDaemon({
    identity, relayUrl, logger, pollIntervalMs: 100,
    onRoomMessage: (item) => (fastRooms.has(item.envelope.conversation_id) ? fast : slow).handle(item),
    onStart: () => Promise.all([slow.recover(), fast.recover()]),
    onStop: () => { slow.close(); fast.close(); },
  });
  daemon.start();
  return { daemon, identity, fastRooms };
}

// ---- world -------------------------------------------------------------------------

test.before(async () => {
  if (!connectionString) return;
  assertDisposableTestDatabase(connectionString);
  // applyMigrations narrates each file on console.log; keep the test output to the test results.
  const log = console.log;
  console.log = (...args) => logs.push(`migrate ${args.join(' ')}`);
  try { await applyMigrations(connectionString, { reset: true }); } finally { console.log = log; }
  world.pool = new pg.Pool({ connectionString });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-fw-e2e-'));
  world.dir = dir;
  await sigil(dir, ['init', 'web', '--kind', 'human']);
  await sigil(dir, ['init', 'agent', '--owner', OWNER, '--kind', 'agent']);
  // `sigil bot add` needs the operator provisioned; the relay's registry seed does the same insert.
  await world.pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW()) ON CONFLICT DO NOTHING`, [OWNER]);
  const botIdentityPath = path.join(dir, '.sigil', `${BOT_EP}.json`);
  await sigil(dir, ['bot', 'add', '--bot-id', BOT_ID, '--endpoint', BOT_EP, '--name', 'Test Bot',
    '--identity', path.join(dir, '.sigil', 'web.identity.json'), '--config', path.join(dir, 'none.json'), '--out', botIdentityPath,
    '--registry', path.join(dir, '.sigil', 'registry.json'), '--database-url', connectionString, '--room-bot-key-wrap-key', 'SIGIL_E2E_BOT_WRAP_KEY']);
  const systemPath = path.join(dir, 'system.identity.json');
  saveIdentity(systemPath, createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' }));

  world.fake = startFakeFloorWarden();
  const webhookUrl = await world.fake.listen();

  // The bot was added before the relay starts, so the relay loads its token from the registry.
  const relay = startRelay(dir, ['--port', '0', '--stream-port', '0', '--database-url', connectionString,
    '--room-human-identity', path.join(dir, '.sigil', 'web.identity.json'), '--room-system-identity', systemPath,
    '--floor-warden-reply-token-env', 'SIGIL_E2E_FW_REPLY_TOKEN', '--room-bot-key-wrap-key', 'SIGIL_E2E_BOT_WRAP_KEY'],
  { ...process.env, SIGIL_E2E_FW_REPLY_TOKEN: REPLY_TOKEN, SIGIL_E2E_BOT_WRAP_KEY: BOT_WRAP_KEY });
  world.relayChild = relay.child;
  world.relayUrl = await relay.ready;

  world.web = loadIdentity(path.join(dir, '.sigil', 'web.identity.json'));
  world.agent = loadIdentity(path.join(dir, '.sigil', 'agent.identity.json'));
  world.bot = startBotDaemon({ identityPath: botIdentityPath, relayUrl: world.relayUrl, webhookUrl, webhookKey: world.fake.key, dir });
  world.botIdentity = world.bot.identity;
}, { timeout: 90_000 });

test.after(async () => {
  world.bot?.daemon.stop();
  await killTree(world.relayChild);
  await world.fake?.close();
  await world.pool?.end();
  if (world.dir) fs.rmSync(world.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ---- relay API helpers ---------------------------------------------------------------

async function api(method, urlPath, { token = world.web.relay_token, body } = {}) {
  const res = await fetch(`${world.relayUrl}${urlPath}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let rooms = 0;
async function newRoom(label, { withAgent = false } = {}) {
  const created = await api('POST', '/v1/rooms', { body: { name: `${label}-${rooms += 1}-${random().slice(0, 6)}` } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const roomId = created.body.room.conversation_id;
  // Response mode lives on the membership row, so the bot joins as mentions_only explicitly.
  const members = withAgent ? [BOT_EP, AGENT_EP] : [BOT_EP];
  for (const endpointId of members) {
    const added = await api('POST', `/v1/rooms/${roomId}/members`, { body: { endpoint_id: endpointId, response_mode: 'mentions_only' } });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.member.response_mode, 'mentions_only');
  }
  return { roomId, name: created.body.room.name };
}

async function say(roomId, text, extra = {}) {
  const res = await api('POST', `/v1/rooms/${roomId}/messages`, { body: { text, idempotency_key: crypto.randomUUID(), ...extra } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { message_id: res.body.message_id, room_seq: Number(res.body.room_seq) };
}

async function messages(roomId) {
  const res = await api('GET', `/v1/rooms/${roomId}/messages?after_seq=0&limit=500`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.items;
}

const botMessages = async (roomId) => (await messages(roomId)).filter((m) => m.envelope.message_type === 'room.message' && m.envelope.sender.endpoint_id === BOT_EP);
const events = async (roomId, kind) => (await messages(roomId)).filter((m) => m.envelope.message_type === 'room.event' && (!kind || m.envelope.body.kind === kind));

async function invocations(roomId, endpointId = BOT_EP) {
  const res = await api('GET', `/v1/rooms/${roomId}/invocations${endpointId ? `?endpoint_id=${encodeURIComponent(endpointId)}` : ''}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.items;
}

const invocationFor = async (roomId, triggerId, endpointId = BOT_EP) => (await invocations(roomId, endpointId)).find((row) => row.trigger_message_id === triggerId);
const waitForInvocation = (roomId, triggerId, status, endpointId = BOT_EP) => waitFor(async () => {
  const row = await invocationFor(roomId, triggerId, endpointId);
  return row?.status === status && row;
}, `${endpointId} invocation for ${triggerId} to be ${status}`);

// The agent posts as itself: a signed room.message over /v1/envelopes, as a CLI bridge does.
async function agentSays(roomId, text, { threadRootId, mentions = [], correlationId = null }) {
  const keys = identityKeys(world.agent);
  const outbox = new LocalOutbox({ privateKey: keys.privateKey, endpoint: { owner_id: world.agent.owner_id, endpoint_id: world.agent.endpoint_id, key_id: world.agent.key_id, kind: 'agent' } });
  const now = new Date();
  const { envelope } = outbox.queue({
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: roomId, message_type: 'room.message',
    broadcast_scope: { conversation_id: roomId }, correlation_id: correlationId, body: { text, thread_root_id: threadRootId, mentions },
    context_refs: [], capabilities: [], idempotency_key: `agent_${crypto.randomUUID()}`, created_at: now.toISOString(), expires_at: new Date(now.getTime() + 3600_000).toISOString(),
  });
  await new RelayClient({ baseUrl: world.relayUrl, token: world.agent.relay_token }).sendEnvelope(envelope);
  return envelope.message_id;
}

const skip = !connectionString;

// ---- scenarios -------------------------------------------------------------------------

test('happy path: one payload with the key header, a bot-signed reply in the thread at the next room_seq, then duplicate: true', { skip, timeout: 30_000 }, async () => {
  const { roomId, name } = await newRoom('happy');
  const trigger = await say(roomId, 'hello @Test Bot', { mentions: [BOT_EP] });
  const frame = await world.fake.next(roomId);
  const inv = await waitForInvocation(roomId, trigger.message_id, 'running');

  assert.equal(frame.headers.authorization, `Bearer ${world.fake.key}`);
  assert.match(frame.headers['content-type'], /^application\/json/);
  assert.equal(frame.raw, JSON.stringify(frame.payload), 'the bridge posts the compact JSON.stringify(payload)');
  const p = frame.payload;
  assert.equal(p.schema, 'sigil.floor_warden/1');
  assert.equal(p.type, 'room.message');
  assert.equal(p.delivery_key, inv.invocation_id);
  assert.deepEqual(p.room, { id: roomId, name });
  assert.deepEqual(p.target_bot, { bot_id: BOT_ID, endpoint_id: BOT_EP, display_name: 'Test Bot' });
  assert.deepEqual(p.invocation, { id: inv.invocation_id, decided_by: 'mention' });
  assert.equal(p.trigger.message_id, trigger.message_id);
  assert.equal(p.trigger.room_seq, trigger.room_seq);
  assert.equal(p.trigger.thread_root_id, trigger.message_id);
  assert.equal(p.trigger.text, 'hello @Test Bot');
  assert.deepEqual([p.trigger.sender.endpoint_id, p.trigger.sender.kind], [world.web.endpoint_id, 'human']);
  assert.deepEqual(p.thread, []);
  assert.deepEqual(p.catch_up, { from_seq: null, to_seq: trigger.room_seq, truncated: false, reset: true });
  assert.deepEqual(p.reply, { url: `${world.relayUrl}/v1/rooms/${roomId}/replies`, in_reply_to: trigger.message_id, idempotency_key: `${trigger.message_id}:${BOT_ID}`, text_max: 16000 });
  assert.equal(p.limits.agent_turns_left, 6);
  assert.equal(world.fake.frames(roomId).length, 1, 'exactly one payload');

  const reply = await world.fake.reply(p, { text: 'Hello from the bot' });
  assert.equal(reply.status, 202, JSON.stringify(reply.body));
  assert.equal(reply.body.duplicate, false);
  assert.equal(Number(reply.body.room_seq), trigger.room_seq + 1);

  const [row] = await botMessages(roomId);
  assert.equal(row.message_id, reply.body.message_id);
  assert.equal(Number(row.room_seq), trigger.room_seq + 1);
  assert.equal(row.envelope.body.thread_root_id, trigger.message_id);
  assert.equal(row.envelope.body.text, 'Hello from the bot');
  assert.deepEqual(row.envelope.body.mentions, []);
  assert.equal(row.envelope.signature.key_id, world.botIdentity.key_id);
  const signedByBot = crypto.verify(null, Buffer.from(row.canonical_bytes, 'base64url'), crypto.createPublicKey(world.botIdentity.public_key_pem), Buffer.from(row.envelope.signature.value, 'base64url'));
  assert.equal(signedByBot, true, 'the reply is signed with the bot endpoint key');

  const done = await invocationFor(roomId, trigger.message_id);
  assert.deepEqual([done.status, done.reply_message_id], ['completed', reply.body.message_id]);

  const again = await world.fake.reply(p, { text: 'changed text' });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.deepEqual([again.body.message_id, Number(again.body.room_seq), again.body.duplicate], [reply.body.message_id, trigger.room_seq + 1, true]);
  assert.equal((await botMessages(roomId)).length, 1);
});

test('duplicate delivery: the fake receives the payload twice, replies twice under one key, and one message is stored', { skip, timeout: 30_000 }, async () => {
  const { roomId } = await newRoom('dup');
  world.fake.plan(roomId, [503]);
  const trigger = await say(roomId, 'twice please @Test Bot', { mentions: [BOT_EP] });
  const first = await world.fake.next(roomId);
  const second = await world.fake.next(roomId, { count: 2 });
  assert.deepEqual([first.status, second.status], [503, 202]);
  assert.equal(first.payload.delivery_key, second.payload.delivery_key, 'the retry resends the same delivery_key');
  assert.deepEqual(first.payload.reply, second.payload.reply);
  assert.deepEqual(first.payload.catch_up, second.payload.catch_up, 'a failed forward does not advance the watermark');

  const [a, b] = await Promise.all([world.fake.reply(first.payload, { text: 'one' }), world.fake.reply(second.payload, { text: 'two' })]);
  assert.deepEqual([a.status, b.status], [202, 202], JSON.stringify([a.body, b.body]));
  assert.equal(a.body.message_id, b.body.message_id);
  assert.deepEqual([a.body.duplicate, b.body.duplicate].sort(), [false, true]);
  assert.equal((await botMessages(roomId)).length, 1);
  assert.equal((await waitForInvocation(roomId, trigger.message_id, 'completed')).reply_message_id, a.body.message_id);
});

test('stale reply: answering an older message while a newer invocation runs is 403 ROOM_NOT_INVOKED and leaves the newer one untouched', { skip, timeout: 30_000 }, async () => {
  const { roomId } = await newRoom('stale');
  const older = await say(roomId, 'first @Test Bot', { mentions: [BOT_EP] });
  const olderFrame = await world.fake.next(roomId);
  assert.equal((await world.fake.reply(olderFrame.payload)).status, 202);
  await waitForInvocation(roomId, older.message_id, 'completed');

  const newer = await say(roomId, 'second @Test Bot', { mentions: [BOT_EP] });
  const newerFrame = await world.fake.next(roomId, { count: 2 });
  assert.equal(newerFrame.payload.trigger.message_id, newer.message_id);
  // A late second answer to the older trigger under a new key (the canonical key would replay the first reply).
  const stale = await world.fake.reply(newerFrame.payload, { in_reply_to: older.message_id, idempotency_key: `${older.message_id}:${BOT_ID}:late` });
  assert.equal(stale.status, 403, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'ROOM_NOT_INVOKED');
  const running = await invocationFor(roomId, newer.message_id);
  assert.deepEqual([running.status, running.reply_message_id], ['running', null]);
  assert.equal((await botMessages(roomId)).length, 1);

  const ok = await world.fake.reply(newerFrame.payload);
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  assert.equal((await waitForInvocation(roomId, newer.message_id, 'completed')).reply_message_id, ok.body.message_id);
});

test('stop: Stop while the fake holds the payload posts invocation_stopped and room_halted, sends a halt frame, and refuses the late reply', { skip, timeout: 30_000 }, async () => {
  const { roomId } = await newRoom('stop');
  const trigger = await say(roomId, 'long job @Test Bot', { mentions: [BOT_EP] });
  const frame = await world.fake.next(roomId);
  const inv = await waitForInvocation(roomId, trigger.message_id, 'running');

  const stop = await api('POST', `/v1/rooms/${roomId}/stop`, { body: {} });
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  assert.equal(stop.body.cancelled, 1);
  // The relay writes the stop events after it answers, so wait for them.
  const stopped = await waitFor(async () => (await events(roomId, 'invocation_stopped'))[0], 'invocation_stopped event');
  assert.equal(stopped.envelope.body.invocation_id, inv.invocation_id);
  const halted = await waitFor(async () => (await events(roomId, 'room_halted'))[0], 'room_halted event');
  assert.deepEqual(halted.envelope.body.endpoint_ids, [BOT_EP]);
  assert.equal(halted.envelope.body.reason, 'stopped');

  const halt = await world.fake.next(roomId, { type: 'halt' });
  assert.equal(halt.headers.authorization, `Bearer ${world.fake.key}`);
  assert.equal(halt.payload.delivery_key, `halt:${inv.invocation_id}`);
  assert.deepEqual(halt.payload.trigger, { message_id: trigger.message_id });
  assert.deepEqual(halt.payload.halt, { room_seq: Number(halted.room_seq), message_id: halted.message_id, reason: 'stopped' });

  const late = await world.fake.reply(frame.payload);
  assert.equal(late.status, 403, JSON.stringify(late.body));
  assert.equal(late.body.code, 'ROOM_NOT_INVOKED');
  assert.equal((await invocationFor(roomId, trigger.message_id)).status, 'cancelled');
  assert.equal((await botMessages(roomId)).length, 0);
});

test('timeout: no reply within replyTimeoutMs posts invocation_failed REPLY_TIMEOUT and the bot can be invoked again', { skip, timeout: 30_000 }, async () => {
  const { roomId } = await newRoom('timeout');
  world.bot.fastRooms.add(roomId);
  const first = await say(roomId, 'are you there @Test Bot', { mentions: [BOT_EP] });
  const held = await world.fake.next(roomId);
  const failed = await waitForInvocation(roomId, first.message_id, 'failed');
  assert.equal(failed.reason, 'REPLY_TIMEOUT');
  const failure = await waitFor(async () => (await events(roomId, 'invocation_failed'))[0], 'invocation_failed event');
  assert.deepEqual([failure.envelope.body.invocation_id, failure.envelope.body.reason], [held.payload.invocation.id, 'REPLY_TIMEOUT']);

  const second = await say(roomId, 'try again @Test Bot', { mentions: [BOT_EP] });
  const frame = await world.fake.next(roomId, { count: 2 });
  assert.equal(frame.payload.trigger.message_id, second.message_id);
  const reply = await world.fake.reply(frame.payload);
  assert.equal(reply.status, 202, JSON.stringify(reply.body));
  await waitForInvocation(roomId, second.message_id, 'completed');
});

test('webhook down: five 503 answers post FLOOR_WARDEN_UNREACHABLE in the room', { skip, timeout: 30_000 }, async () => {
  const { roomId } = await newRoom('down');
  world.fake.plan(roomId, [503, 503, 503, 503, 503]);
  const trigger = await say(roomId, 'anyone @Test Bot', { mentions: [BOT_EP] });
  const failed = await waitForInvocation(roomId, trigger.message_id, 'failed');
  assert.equal(failed.reason, 'FLOOR_WARDEN_UNREACHABLE');
  const failure = await waitFor(async () => (await events(roomId, 'invocation_failed'))[0], 'invocation_failed event');
  assert.deepEqual([failure.envelope.body.invocation_id, failure.envelope.body.reason], [failed.invocation_id, 'FLOOR_WARDEN_UNREACHABLE']);
  const frames = world.fake.frames(roomId);
  assert.equal(frames.length, 5);
  assert.ok(frames.every((f) => f.status === 503 && f.payload.delivery_key === failed.invocation_id));
});

test('cap: the agent and the bot hand work back and forth to the cap, one agent_cap_reached appears, Continue resumes, and a bot reply dispatches no agent', { skip, timeout: 30_000 }, async () => {
  const { roomId } = await newRoom('cap', { withAgent: true });
  // A bot reply is a leaf, and one agent posts once per invocation, so one
  // agent and the bot cannot spend the default budget of 6 in a thread
  // without a human post (which refills it). Lower this room's cap to 2.
  await world.pool.query('UPDATE rooms SET max_agent_turns = 2 WHERE conversation_id = $1', [roomId]);

  const root = await say(roomId, '@agent and @Test Bot, work this out', { mentions: [AGENT_EP, BOT_EP] });
  await waitForInvocation(roomId, root.message_id, 'running', AGENT_EP);
  const firstFrame = await world.fake.next(roomId);
  assert.equal(firstFrame.payload.limits.agent_turns_left, 2);
  // The bot "hands back" to the agent by name; the relay never turns bot text into mentions.
  const firstReply = await world.fake.reply(firstFrame.payload, { text: `Over to you, @${AGENT_EP}` });
  assert.equal(firstReply.status, 202, JSON.stringify(firstReply.body));
  await waitForInvocation(roomId, root.message_id, 'completed');

  // The agent hands work back to the bot: the third turn in the thread is refused.
  const handoff = await agentSays(roomId, 'Bot, please check my part', { threadRootId: root.message_id, mentions: [BOT_EP], correlationId: root.message_id });
  await waitForInvocation(roomId, root.message_id, 'completed', AGENT_EP);
  const refused = await waitForInvocation(roomId, handoff, 'refused');
  assert.equal(refused.reason, 'hop_budget');
  const caps = await events(roomId, 'agent_cap_reached');
  assert.equal(caps.length, 1);
  assert.deepEqual(caps[0].envelope.body.endpoint_ids, [BOT_EP]);
  assert.equal(caps[0].envelope.body.thread_root_id, root.message_id);
  assert.match(caps[0].envelope.body.reason, /agent turn cap of 2 reached/);
  assert.equal(world.fake.frames(roomId).length, 1, 'the refused handoff never reaches the fake');

  const resume = await api('POST', `/v1/rooms/${roomId}/continue`, { body: { thread_root_id: root.message_id, idempotency_key: crypto.randomUUID() } });
  assert.equal(resume.status, 201, JSON.stringify(resume.body));
  const resumedFrame = await world.fake.next(roomId, { count: 2 });
  assert.equal(resumedFrame.payload.trigger.message_id, resume.body.message_id);
  assert.equal(resumedFrame.payload.trigger.text, 'Continue.');
  assert.equal(resumedFrame.payload.trigger.thread_root_id, root.message_id);
  const resumedReply = await world.fake.reply(resumedFrame.payload, { text: `Done. @${AGENT_EP} take it from here` });
  assert.equal(resumedReply.status, 202, JSON.stringify(resumedReply.body));
  await waitForInvocation(roomId, resume.body.message_id, 'completed');
  assert.equal((await events(roomId, 'agent_cap_reached')).length, 1, 'Continue starts a new epoch without a new cap event');
  const nothing = await api('POST', `/v1/rooms/${roomId}/continue`, { body: { thread_root_id: root.message_id, idempotency_key: crypto.randomUUID() } });
  assert.deepEqual([nothing.status, nothing.body.code], [409, 'NOTHING_TO_CONTINUE']);

  // Bot replies are leaves: no invocation of any agent was ever triggered by one.
  const bot = await botMessages(roomId);
  assert.deepEqual(bot.map((m) => m.message_id).sort(), [firstReply.body.message_id, resumedReply.body.message_id].sort());
  assert.ok(bot.every((m) => m.envelope.body.mentions.length === 0));
  const all = await invocations(roomId, null);
  const botIds = new Set(bot.map((m) => m.message_id));
  assert.deepEqual(all.filter((row) => botIds.has(row.trigger_message_id)), []);
  assert.deepEqual((await invocations(roomId, AGENT_EP)).map((row) => row.trigger_message_id), [root.message_id], 'the agent ran once, for the human');
});

test('disabled bot: after sigil bot disable, a reply answers 403 BOT_NOT_ON_ROSTER', { skip, timeout: 30_000 }, async () => {
  const { roomId } = await newRoom('disabled');
  const trigger = await say(roomId, 'last one @Test Bot', { mentions: [BOT_EP] });
  const frame = await world.fake.next(roomId);
  await sigil(world.dir, ['bot', 'disable', '--bot-id', BOT_ID, '--database-url', connectionString]);
  const reply = await world.fake.reply(frame.payload);
  assert.equal(reply.status, 403, JSON.stringify(reply.body));
  assert.equal(reply.body.code, 'BOT_NOT_ON_ROSTER');
  assert.equal((await botMessages(roomId)).length, 0);
  assert.equal((await invocationFor(roomId, trigger.message_id)).status, 'running');
});

test('secrets: the combined relay, bridge and fake logs hold no reply token, sender key, webhook path or relay token', { skip, timeout: 30_000 }, async () => {
  const text = logs.join('\n');
  assert.match(text, /Sigil relay listening on/, 'relay output was captured');
  assert.match(text, /floor warden: forwarded inv_/, 'bridge output was captured');
  assert.match(text, /webhook .*unavailable for inv_/, 'bridge warnings were captured');
  assert.match(text, /fake floor warden: reply to /, 'fake output was captured');
  const secrets = {
    'reply token': REPLY_TOKEN,
    'sender key': world.fake.key,
    'webhook path': world.fake.hookPath,
    'webhook path without its slash': world.fake.hookPath.slice(1),
    'bot relay token': world.botIdentity.relay_token,
    'web relay token': world.web.relay_token,
    'agent relay token': world.agent.relay_token,
    'bot wrap key': BOT_WRAP_KEY,
  };
  for (const [label, secret] of Object.entries(secrets)) assert.equal(text.includes(secret), false, `${label} leaked into the logs`);
});
