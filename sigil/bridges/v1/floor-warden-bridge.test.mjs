// sigil/bridges/v1/floor-warden-bridge.test.mjs
// Fake relay, fake fetch, temp session store, mocked timers. No real webhook.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore } from './session-store.mjs';
import { createFloorWardenBridge } from './floor-warden-bridge.mjs';
import { PAYLOAD_MAX_BYTES } from './floor-warden-payload.mjs';

const SELF = 'ep_test_bot';
const BOT_ID = 'bot_fixture_0001';
const WEBHOOK = 'https://hooks.example.test/routines/s3cr3t-path-abc123';
const KEY = 'sk_test_sender_key_value_123456';
const REPLY_BASE = 'https://relay.example.test';
const T0 = Date.parse('2026-10-16T12:00:00.000Z');
const MIN = 60_000;
const TIMEOUT = 15 * MIN;
const POLL = 2000;

const flush = async () => { for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function msg(room, seq, id, sender, text, { thread = null, type = 'room.message', body = null } = {}) {
  return {
    room,
    room_seq: String(seq),
    message_id: id,
    display_name: sender,
    envelope: {
      message_type: type,
      message_id: id,
      conversation_id: room,
      sender: { endpoint_id: sender },
      body: body ?? { text, ...(thread ? { thread_root_id: thread } : {}), mentions: [] },
      created_at: new Date(T0 - (100 - seq) * 1000).toISOString(),
    },
  };
}

function baseMessages(room = 'room_1') {
  return [
    msg(room, 1, 'msg_root', 'ep_web', 'start'),
    msg(room, 2, 'msg_2', 'ep_codex', 'codex says', { thread: 'msg_root' }),
    msg(room, 3, 'msg_other', 'ep_web', 'other thread'),
    msg(room, 4, 'msg_t', 'ep_web', '@ep_test_bot help', { thread: 'msg_root' }),
  ];
}

function inv(id, room, trigger, { status = 'running', startedAt = T0, thread = 'msg_root' } = {}) {
  return { invocation_id: id, room_id: room, trigger_message_id: trigger, thread_root_id: thread, endpoint_id: SELF, decided_by: 'mention', status, created_at: new Date(startedAt).toISOString(), started_at: new Date(startedAt).toISOString() };
}

function fakeRelay({ invocations, messages, rooms = [{ conversation_id: 'room_1', name: 'Ops', max_agent_turns: 6 }] }) {
  const calls = [];
  const failed = [];
  return {
    calls, failed, invocations, messages,
    async request(p) { calls.push(['request', p]); if (p === '/v1/rooms') return { code: 'OK', items: rooms }; throw new Error(`unexpected ${p}`); },
    async listRoomInvocations(roomId, { endpointId = null, status = null } = {}) {
      calls.push(['invocations', roomId, status]);
      return invocations.filter((i) => i.room_id === roomId && (!endpointId || i.endpoint_id === endpointId) && (!status || i.status === status)).map((i) => ({ ...i }));
    },
    async listRoomMembers(roomId) {
      calls.push(['members', roomId]);
      return [
        { endpoint_id: 'ep_web', response_mode: null, display_name: 'Chris' },
        { endpoint_id: SELF, response_mode: 'mentions_only', display_name: 'Chief' },
        { endpoint_id: 'ep_codex', response_mode: 'joins', display_name: 'Codex' },
      ];
    },
    async listRoomMessages(roomId, afterSeq = '0', limit = 500) {
      calls.push(['messages', roomId, afterSeq]);
      const items = messages.filter((m) => m.room === roomId && Number(m.room_seq) > Number(afterSeq)).slice(0, limit).map(({ room, ...rest }) => rest);
      return { items, next_after_seq: items.length ? items.at(-1).room_seq : String(afterSeq) };
    },
    async failRoomInvocation(roomId, reason, invocationId) {
      calls.push(['fail', roomId, reason, invocationId]);
      failed.push([roomId, reason, invocationId]);
      const row = invocations.find((i) => i.invocation_id === invocationId && i.status === 'running');
      if (row) row.status = 'failed';
      return row ?? null;
    },
  };
}

const enabled = new WeakSet();

function setup(t, { invocations, messages, rooms, respond = () => ({ status: 200 }), sessionsPath, ...options } = {}) {
  if (!enabled.has(t)) { t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 }); enabled.add(t); }
  const file = sessionsPath ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-fw-')), 'sessions.json');
  const sessions = createSessionStore(file);
  const relay = fakeRelay({ invocations: invocations ?? [inv('inv_1', 'room_1', 'msg_t')], messages: messages ?? baseMessages(), rooms });
  const posts = [];
  const logs = [];
  const logger = { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) };
  const fetchImpl = async (url, init) => {
    posts.push({ url, init, body: JSON.parse(init.body) });
    const r = await respond(posts.length, posts.at(-1));
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => '' };
  };
  const bridges = [];
  const make = (extra = {}) => {
    const bridge = createFloorWardenBridge({
      identity: { endpoint_id: SELF },
      bot: { bot_id: BOT_ID, display_name: 'Chief' },
      relay, sessions, fetchImpl,
      webhook: { url: WEBHOOK, key: KEY },
      replyUrl: REPLY_BASE,
      replyTimeoutMs: TIMEOUT,
      pollIntervalMs: POLL,
      logger,
      retryBackoffMs: [],
      ...options,
      ...extra,
    });
    bridges.push(bridge);
    return bridge;
  };
  t.after(() => { for (const b of bridges) b.close(); });
  return { relay, sessions, posts, logs, make, file };
}

const envelopeFor = (relay, id) => relay.messages.find((m) => m.message_id === id).envelope;

test('skips without a POST when the relay has no running invocation for this trigger', async (t) => {
  const none = setup(t, { invocations: [] });
  assert.deepEqual(await none.make().handle({ envelope: envelopeFor(none.relay, 'msg_t') }), { outcome: 'skipped' });
  assert.equal(none.posts.length, 0);

  const other = setup(t, { invocations: [inv('inv_1', 'room_1', 'msg_2')] });
  assert.deepEqual(await other.make().handle({ envelope: envelopeFor(other.relay, 'msg_t') }), { outcome: 'skipped' });
  assert.equal(other.posts.length, 0);
  assert.equal(other.relay.failed.length, 0);
});

test('2xx: one compact POST with the payload and Bearer sender key, forwarded, watermark advanced, invocation not failed', async (t) => {
  const s = setup(t);
  const result = await s.make().handle({ envelope: envelopeFor(s.relay, 'msg_t') });
  assert.deepEqual(result, { outcome: 'forwarded' });
  assert.equal(s.posts.length, 1);
  const [post] = s.posts;
  assert.equal(post.url, WEBHOOK);
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(post.init.headers['content-type'], 'application/json');
  assert.equal(post.init.body, JSON.stringify(post.body), 'body is the compact JSON.stringify form');
  assert.ok(post.init.signal instanceof AbortSignal);
  const p = post.body;
  assert.equal(p.type, 'room.message');
  assert.equal(p.delivery_key, 'inv_1');
  assert.deepEqual(p.room, { id: 'room_1', name: 'Ops' });
  assert.deepEqual(p.target_bot, { bot_id: BOT_ID, endpoint_id: SELF, display_name: 'Chief' });
  assert.deepEqual(p.invocation, { id: 'inv_1', decided_by: 'mention' });
  assert.equal(p.trigger.message_id, 'msg_t');
  assert.equal(p.trigger.room_seq, 4);
  assert.equal(p.trigger.thread_root_id, 'msg_root');
  assert.deepEqual(p.trigger.sender, { endpoint_id: 'ep_web', kind: 'human', display_name: 'Chris' });
  assert.equal(p.trigger.text, '@ep_test_bot help');
  assert.deepEqual(p.thread.map((m) => m.message_id), ['msg_root', 'msg_2']);
  assert.deepEqual(p.catch_up, { from_seq: null, to_seq: 4, truncated: false, reset: true });
  assert.equal(p.reply.url, `${REPLY_BASE}/v1/rooms/room_1/replies`);
  assert.equal(p.reply.idempotency_key, `msg_t:${BOT_ID}`);
  assert.equal(p.limits.agent_turns_left, 6);
  assert.equal(s.sessions.get('room_1').last_seq_by_thread.msg_root, '4');
  assert.equal(s.relay.failed.length, 0);
  assert.ok(!JSON.stringify(p).includes(KEY));
});

test('a configured key header carries the raw key, or the given scheme', async (t) => {
  const raw = setup(t);
  await raw.make({ webhook: { url: WEBHOOK, key: KEY, keyHeader: 'X-Floor-Key' } }).handle({ envelope: envelopeFor(raw.relay, 'msg_t') });
  assert.equal(raw.posts[0].init.headers['x-floor-key'], KEY);
  assert.equal(raw.posts[0].init.headers.authorization, undefined);

  const scheme = setup(t);
  await scheme.make({ webhook: { url: WEBHOOK, key: KEY, keyHeader: 'Authorization: Token' } }).handle({ envelope: envelopeFor(scheme.relay, 'msg_t') });
  assert.equal(scheme.posts[0].init.headers.authorization, `Token ${KEY}`);
});

test('string room_seq and a string watermark are coerced to numbers before the payload builder', async (t) => {
  const s = setup(t);
  s.sessions.set('room_1', { session_id: null, last_seq_by_thread: { msg_root: '1' } });
  await s.make().handle({ envelope: envelopeFor(s.relay, 'msg_t') });
  const p = s.posts[0].body;
  assert.deepEqual(p.catch_up, { from_seq: 1, to_seq: 4, truncated: false, reset: false });
  assert.deepEqual(p.thread.map((m) => [m.room_seq, m.message_id]), [[2, 'msg_2']]);
  assert.equal(s.sessions.get('room_1').last_seq_by_thread.msg_root, '4');
});

for (const status of [400, 401, 403, 404, 422]) {
  test(`${status}: fails the invocation with FLOOR_WARDEN_REJECTED, watermark unchanged, no throw`, async (t) => {
    const s = setup(t, { respond: () => ({ status }) });
    const result = await s.make().handle({ envelope: envelopeFor(s.relay, 'msg_t') });
    assert.deepEqual(result, { outcome: 'failed', reason: 'FLOOR_WARDEN_REJECTED' });
    assert.deepEqual(s.relay.failed, [['room_1', 'FLOOR_WARDEN_REJECTED', 'inv_1']]);
    assert.equal(s.sessions.get('room_1')?.last_seq_by_thread?.msg_root, undefined);
  });
}

const networkError = () => { throw new TypeError(`fetch failed: connect ECONNREFUSED ${WEBHOOK}`); };
for (const [label, respond] of [['408', () => ({ status: 408 })], ['429', () => ({ status: 429 })], ['500', () => ({ status: 500 })], ['503', () => ({ status: 503 })], ['network error', networkError]]) {
  test(`${label}: throws (delivery unacked), same delivery_key on retry, no watermark, UNREACHABLE after 5 attempts`, async (t) => {
    const s = setup(t, { respond });
    const bridge = s.make();
    const envelope = envelopeFor(s.relay, 'msg_t');
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await assert.rejects(bridge.handle({ envelope }), (error) => error.code === 'FLOOR_WARDEN_RETRY');
      assert.equal(s.relay.failed.length, 0);
      assert.equal(s.sessions.get('room_1')?.last_seq_by_thread?.msg_root, undefined);
    }
    assert.deepEqual(await bridge.handle({ envelope }), { outcome: 'failed', reason: 'FLOOR_WARDEN_UNREACHABLE' });
    assert.equal(s.posts.length, 5);
    assert.deepEqual(new Set(s.posts.map((p) => p.body.delivery_key)), new Set(['inv_1']));
    assert.deepEqual(s.relay.failed, [['room_1', 'FLOOR_WARDEN_UNREACHABLE', 'inv_1']]);
    assert.equal(s.sessions.get('room_1')?.last_seq_by_thread?.msg_root, undefined);
  });
}

test('attempt counts survive a restart through the session store', async (t) => {
  const s = setup(t, { respond: () => ({ status: 503 }) });
  const envelope = envelopeFor(s.relay, 'msg_t');
  const first = s.make();
  for (let i = 0; i < 3; i += 1) await assert.rejects(first.handle({ envelope }));
  first.close();
  const second = s.make();
  await assert.rejects(second.handle({ envelope }));
  assert.deepEqual(await second.handle({ envelope }), { outcome: 'failed', reason: 'FLOOR_WARDEN_UNREACHABLE' });
  assert.equal(s.posts.length, 5);
});

test('no reply URL: fails with REPLY_URL_UNSET and makes no POST', async (t) => {
  const s = setup(t);
  const result = await s.make({ replyUrl: '' }).handle({ envelope: envelopeFor(s.relay, 'msg_t') });
  assert.deepEqual(result, { outcome: 'failed', reason: 'REPLY_URL_UNSET' });
  assert.equal(s.posts.length, 0);
  assert.deepEqual(s.relay.failed, [['room_1', 'REPLY_URL_UNSET', 'inv_1']]);
});

test('a payload still over 256 KiB (trigger text alone) is not POSTed and fails with PAYLOAD_TOO_LARGE', async (t) => {
  const messages = baseMessages();
  messages[3].envelope.body.text = 'x'.repeat(PAYLOAD_MAX_BYTES + 10);
  const s = setup(t, { messages });
  const result = await s.make().handle({ envelope: envelopeFor(s.relay, 'msg_t') });
  assert.deepEqual(result, { outcome: 'failed', reason: 'PAYLOAD_TOO_LARGE' });
  assert.equal(s.posts.length, 0);
  assert.deepEqual(s.relay.failed, [['room_1', 'PAYLOAD_TOO_LARGE', 'inv_1']]);
  assert.equal(s.sessions.get('room_1')?.last_seq_by_thread?.msg_root, undefined);
});

test('reply deadline: still running after replyTimeoutMs fails with REPLY_TIMEOUT', async (t) => {
  const s = setup(t);
  await s.make().handle({ envelope: envelopeFor(s.relay, 'msg_t') });
  t.mock.timers.tick(TIMEOUT - POLL);
  await flush();
  assert.equal(s.relay.failed.length, 0);
  t.mock.timers.tick(POLL);
  await flush();
  assert.deepEqual(s.relay.failed, [['room_1', 'REPLY_TIMEOUT', 'inv_1']]);
  // Nothing armed afterwards: further time makes no relay calls.
  const before = s.relay.calls.length;
  t.mock.timers.tick(TIMEOUT * 2);
  await flush();
  assert.equal(s.relay.calls.length, before);
});

test('reply deadline: an invocation that completed first gets no failure call and its timers are cleared', async (t) => {
  const s = setup(t);
  await s.make().handle({ envelope: envelopeFor(s.relay, 'msg_t') });
  s.relay.invocations[0].status = 'completed';
  t.mock.timers.tick(POLL);
  await flush();
  const before = s.relay.calls.length;
  t.mock.timers.tick(TIMEOUT * 2);
  await flush();
  assert.equal(s.relay.calls.length, before, 'no poll and no deadline remain armed');
  assert.equal(s.relay.failed.length, 0);
  assert.equal(s.posts.length, 1, 'a completed invocation sends no halt');
});

function haltEvent(room, seq, id, endpointIds = [SELF], reason = 'stopped') {
  return msg(room, seq, id, 'ep_relay_system', null, { type: 'room.event', body: { kind: 'room_halted', reason, endpoint_ids: endpointIds } });
}

test('halt: a forwarded invocation that is cancelled gets exactly one halt frame with the room_halted seq and id', async (t) => {
  const s = setup(t);
  await s.make().handle({ envelope: envelopeFor(s.relay, 'msg_t') });
  s.relay.invocations[0].status = 'cancelled';
  s.relay.messages.push(haltEvent('room_1', 5, 'msg_halt_other', ['ep_codex']), haltEvent('room_1', 6, 'msg_halt'));
  t.mock.timers.tick(POLL);
  await flush();
  t.mock.timers.tick(POLL * 5);
  await flush();
  assert.equal(s.posts.length, 2);
  const halt = s.posts[1].body;
  assert.equal(halt.type, 'halt');
  assert.equal(halt.delivery_key, 'halt:inv_1');
  assert.deepEqual(halt.invocation, { id: 'inv_1' });
  assert.deepEqual(halt.trigger, { message_id: 'msg_t' });
  assert.deepEqual(halt.halt, { room_seq: 6, message_id: 'msg_halt', reason: 'stopped' });
  assert.equal(s.posts[1].init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(s.relay.failed.length, 0);
  assert.ok(s.sessions.get('room_1').floor_warden.halts.inv_1);
  // A restart does not resend it.
  await s.make().recover();
  await flush();
  assert.equal(s.posts.length, 2);
});

test('recover() fails stale running invocations, re-arms younger ones, and sends missing halt frames once', async (t) => {
  const rooms = [
    { conversation_id: 'room_old', name: 'Old', max_agent_turns: 6 },
    { conversation_id: 'room_young', name: 'Young', max_agent_turns: 6 },
    { conversation_id: 'room_cut', name: 'Cut', max_agent_turns: 6 },
  ];
  const messages = [...baseMessages('room_old'), ...baseMessages('room_young'), ...baseMessages('room_cut'), haltEvent('room_cut', 5, 'msg_cut_halt', [SELF], 'left')];
  const invocations = [
    inv('inv_old', 'room_old', 'msg_t', { startedAt: T0 - 20 * MIN }),
    inv('inv_young', 'room_young', 'msg_t', { startedAt: T0 - 5 * MIN }),
    inv('inv_cut', 'room_cut', 'msg_t', { status: 'cancelled', startedAt: T0 - 3 * MIN }),
  ];
  const s = setup(t, { rooms, messages, invocations });
  s.sessions.set('room_cut', { session_id: null, last_seq_by_thread: { msg_root: '4' }, floor_warden: { attempts: {}, halts: {}, forwards: { inv_cut: { thread_root_id: 'msg_root', trigger_message_id: 'msg_t', trigger_room_seq: 4, forwarded_at: new Date(T0 - 2 * MIN).toISOString() } } } });
  const bridge = s.make();
  await bridge.recover();
  await flush();
  assert.deepEqual(s.relay.failed, [['room_old', 'REPLY_TIMEOUT', 'inv_old']]);
  assert.equal(s.posts.length, 1);
  assert.equal(s.posts[0].body.delivery_key, 'halt:inv_cut');
  assert.deepEqual(s.posts[0].body.halt, { room_seq: 5, message_id: 'msg_cut_halt', reason: 'left' });

  t.mock.timers.tick(10 * MIN - 1);
  await flush();
  assert.equal(s.relay.failed.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(s.relay.failed.at(-1), ['room_young', 'REPLY_TIMEOUT', 'inv_young']);

  await s.make().recover();
  await flush();
  assert.equal(s.posts.length, 1, 'a recorded halt is not sent again');
});

test('a thrown fetch error that names the webhook URL is scrubbed from the logger, the thrown error and the failure reason', async (t) => {
  const s = setup(t, { respond: networkError, maxAttempts: 2 });
  const bridge = s.make();
  const envelope = envelopeFor(s.relay, 'msg_t');
  let thrown;
  await bridge.handle({ envelope }).catch((error) => { thrown = error; });
  assert.ok(thrown);
  const finalResult = await bridge.handle({ envelope });
  const pathPart = new URL(WEBHOOK).pathname;
  const surfaces = [thrown.message, String(thrown.stack), JSON.stringify(finalResult), JSON.stringify(s.relay.failed), ...s.logs];
  for (const text of surfaces) {
    assert.ok(!text.includes(pathPart), `leaked URL path: ${text}`);
    assert.ok(!text.includes(KEY), `leaked key: ${text}`);
  }
  assert.equal(thrown.cause, undefined);
  assert.ok(s.logs.length > 0, 'the failure is logged');
});

test('close() clears every timer', async (t) => {
  const s = setup(t);
  const bridge = s.make();
  await bridge.handle({ envelope: envelopeFor(s.relay, 'msg_t') });
  bridge.close();
  const before = s.relay.calls.length;
  t.mock.timers.tick(TIMEOUT * 2);
  await flush();
  assert.equal(s.relay.calls.length, before);
  assert.equal(s.relay.failed.length, 0);
});

// ---- fix round 1 ------------------------------------------------------------

test('deadline: a failRoomInvocation that rejects once is retried and the forward record is kept until it succeeds', async (t) => {
  const s = setup(t);
  await s.make().handle({ envelope: envelopeFor(s.relay, 'msg_t') });
  const original = s.relay.failRoomInvocation.bind(s.relay);
  let calls = 0;
  s.relay.failRoomInvocation = async (...args) => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('relay blip'), { code: 'DELIVERY_UNAVAILABLE' });
    return original(...args);
  };
  t.mock.timers.tick(TIMEOUT);
  await flush();
  assert.equal(calls, 1);
  assert.equal(s.relay.failed.length, 0);
  assert.ok(s.sessions.get('room_1').floor_warden.forwards.inv_1, 'forward record kept while the failure is unconfirmed');
  t.mock.timers.tick(POLL);
  await flush();
  assert.deepEqual(s.relay.failed, [['room_1', 'REPLY_TIMEOUT', 'inv_1']]);
  assert.equal(s.sessions.get('room_1').floor_warden.forwards.inv_1, undefined);
  const before = s.relay.calls.length;
  t.mock.timers.tick(TIMEOUT * 2);
  await flush();
  assert.equal(s.relay.calls.length, before, 'nothing armed after the confirmed failure');
});

test('persistent relay read errors stop the watch after maxAttempts, log one warning, and keep the forward record', async (t) => {
  const s = setup(t);
  await s.make().handle({ envelope: envelopeFor(s.relay, 'msg_t') });
  let reads = 0;
  s.relay.listRoomInvocations = async () => { reads += 1; throw Object.assign(new Error('Room not found'), { code: 'ROOM_NOT_FOUND', status: 404 }); };
  for (let i = 0; i < 12; i += 1) { t.mock.timers.tick(POLL); await flush(); }
  assert.equal(reads, 5);
  assert.equal(s.logs.filter((line) => /stopped watching inv_1/.test(line)).length, 1);
  t.mock.timers.tick(TIMEOUT * 2);
  await flush();
  assert.equal(reads, 5, 'deadline and poll are both disarmed');
  assert.ok(s.sessions.get('room_1').floor_warden.forwards.inv_1, 'recover() can retry it');
  assert.equal(s.relay.failed.length, 0);
});

test('recover() also walks rooms recorded in the session store that /v1/rooms no longer lists', async (t) => {
  const messages = [...baseMessages('room_gone'), haltEvent('room_gone', 5, 'msg_gone_halt')];
  const s = setup(t, { rooms: [], messages, invocations: [inv('inv_gone', 'room_gone', 'msg_t', { status: 'cancelled' })] });
  s.sessions.set('room_gone', { session_id: null, last_seq_by_thread: {}, floor_warden: { attempts: {}, halts: {}, forwards: { inv_gone: { thread_root_id: 'msg_root', trigger_message_id: 'msg_t', trigger_room_seq: 4, forwarded_at: new Date(T0 - MIN).toISOString() } } } });
  await s.make().recover();
  await flush();
  assert.equal(s.posts.length, 1);
  assert.equal(s.posts[0].body.delivery_key, 'halt:inv_gone');
});

test('scrub covers the normalized href and URL credentials', async (t) => {
  // Fixture credentials, set through the URL API so no literal userinfo URL sits in the source.
  const built = new URL('https://Hooks.Example.test/r/abc-path-123?sig=zzzz9999');
  built.username = 'fwuser9';
  built.password = ['fwpass', 'fixture9'].join('-');
  const url = built.href;
  const parsed = new URL(url);
  const s = setup(t, { respond: (n, p) => { throw new TypeError(`fetch failed ${parsed.href} user=${parsed.username} pass=${parsed.password}`); }, maxAttempts: 2 });
  const bridge = s.make({ webhook: { url, key: KEY } });
  const envelope = envelopeFor(s.relay, 'msg_t');
  let thrown;
  await bridge.handle({ envelope }).catch((error) => { thrown = error; });
  await bridge.handle({ envelope });
  for (const text of [thrown.message, ...s.logs]) {
    for (const secret of [parsed.href, 'fwuser9', 'fwpass-fixture9', '/r/abc-path-123', 'zzzz9999']) assert.ok(!text.includes(secret), `leaked ${secret}: ${text}`);
  }
});

test('an invalid key header name throws INVALID_CONFIG at construction', (t) => {
  const s = setup(t);
  for (const keyHeader of ['Bad Header: Bearer', 'X(y)', ': Bearer', 'X-Key\r\nInjected', 'X,Key']) {
    assert.throws(() => s.make({ webhook: { url: WEBHOOK, key: KEY, keyHeader } }), (error) => error.code === 'INVALID_CONFIG', keyHeader);
  }
  assert.doesNotThrow(() => s.make({ webhook: { url: WEBHOOK, key: KEY, keyHeader: "X-Floor_Key.v1!#$%&'*+^`|~: Token" } }));
});

for (const [label, thrownValue, reason] of [['null', null, 'BRIDGE_ERROR'], ['undefined', undefined, 'BRIDGE_ERROR'], ['an error without a code', new Error('boom'), 'BRIDGE_ERROR'], ['a relay error with a code', Object.assign(new Error('relay down'), { code: 'DELIVERY_UNAVAILABLE' }), 'DELIVERY_UNAVAILABLE']]) {
  test(`a relay read that throws ${label} after the invocation is known fails it with ${reason}`, async (t) => {
    const s = setup(t);
    s.relay.listRoomMembers = async () => { throw thrownValue; };
    const result = await s.make().handle({ envelope: envelopeFor(s.relay, 'msg_t') });
    assert.deepEqual(result, { outcome: 'failed', reason });
    assert.deepEqual(s.relay.failed, [['room_1', reason, 'inv_1']]);
    assert.equal(s.posts.length, 0);
  });
}

test('halt: a halt POST that needs a retry is resent on the next poll and recorded once it succeeds', async (t) => {
  const statuses = [200, 503, 200];
  const s = setup(t, { respond: (n) => ({ status: statuses[n - 1] ?? 200 }) });
  await s.make().handle({ envelope: envelopeFor(s.relay, 'msg_t') });
  s.relay.invocations[0].status = 'cancelled';
  s.relay.messages.push(haltEvent('room_1', 5, 'msg_halt'));
  t.mock.timers.tick(POLL);
  await flush();
  assert.equal(s.posts.length, 2);
  assert.equal(s.sessions.get('room_1').floor_warden.halts.inv_1, undefined);
  t.mock.timers.tick(POLL);
  await flush();
  assert.equal(s.posts.length, 3);
  assert.equal(s.posts[2].body.delivery_key, 'halt:inv_1');
  assert.ok(s.sessions.get('room_1').floor_warden.halts.inv_1);
  t.mock.timers.tick(POLL * 5);
  await flush();
  assert.equal(s.posts.length, 3);
});

test('halt: a rejected halt POST is logged and recorded, and not retried', async (t) => {
  const statuses = [200, 400];
  const s = setup(t, { respond: (n) => ({ status: statuses[n - 1] ?? 200 }) });
  await s.make().handle({ envelope: envelopeFor(s.relay, 'msg_t') });
  s.relay.invocations[0].status = 'cancelled';
  s.relay.messages.push(haltEvent('room_1', 5, 'msg_halt'));
  t.mock.timers.tick(POLL);
  await flush();
  t.mock.timers.tick(POLL * 5);
  await flush();
  assert.equal(s.posts.length, 2);
  assert.ok(s.sessions.get('room_1').floor_warden.halts.inv_1);
  assert.ok(s.logs.some((line) => /rejected the halt frame for inv_1 with HTTP 400/.test(line)));
});

// ---- fix round 2 ------------------------------------------------------------

test('deadline: a failRoomInvocation that always rejects stops after maxAttempts even while polls succeed, and keeps the record', async (t) => {
  const s = setup(t);
  await s.make().handle({ envelope: envelopeFor(s.relay, 'msg_t') });
  let failCalls = 0;
  s.relay.failRoomInvocation = async () => { failCalls += 1; throw Object.assign(new Error('Invocation not found'), { code: 'INVOCATION_NOT_FOUND', status: 404 }); };
  t.mock.timers.tick(TIMEOUT);
  await flush();
  for (let i = 0; i < 12; i += 1) { t.mock.timers.tick(POLL); await flush(); }
  assert.equal(failCalls, 5);
  assert.equal(s.logs.filter((line) => /stopped watching inv_1/.test(line)).length, 1);
  assert.ok(s.sessions.get('room_1').floor_warden.forwards.inv_1, 'recover() can retry it');
  const before = s.relay.calls.length;
  t.mock.timers.tick(TIMEOUT * 2);
  await flush();
  assert.equal(s.relay.calls.length, before, 'poll and deadline are both disarmed');
  assert.equal(failCalls, 5);
});

test('recover() still walks /v1/rooms when the session store cannot list its rooms', async (t) => {
  const s = setup(t, { invocations: [inv('inv_1', 'room_1', 'msg_t', { startedAt: T0 - 20 * MIN })] });
  s.sessions.rooms = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  await s.make().recover();
  await flush();
  assert.deepEqual(s.relay.failed, [['room_1', 'REPLY_TIMEOUT', 'inv_1']]);
  assert.ok(s.logs.some((line) => /session store room list/.test(line)));
});

test('fail(): a failRoomInvocation that rejects is retried by a deadline watch instead of being dropped', async (t) => {
  const s = setup(t);
  const original = s.relay.failRoomInvocation.bind(s.relay);
  let calls = 0;
  s.relay.failRoomInvocation = async (...args) => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('relay blip'), { code: 'DELIVERY_UNAVAILABLE' });
    return original(...args);
  };
  const result = await s.make({ replyUrl: '' }).handle({ envelope: envelopeFor(s.relay, 'msg_t') });
  assert.deepEqual(result, { outcome: 'failed', reason: 'REPLY_URL_UNSET' });
  assert.equal(s.relay.failed.length, 0, 'the first call was rejected');
  t.mock.timers.tick(POLL);
  await flush();
  assert.deepEqual(s.relay.failed, [['room_1', 'REPLY_URL_UNSET', 'inv_1']]);
});

test('halt: halt records older than a day are pruned when a new one is recorded', async (t) => {
  const s = setup(t);
  s.sessions.set('room_1', { floor_warden: { halts: { inv_old: new Date(T0 - 25 * 3600_000).toISOString(), inv_recent: new Date(T0 - 3600_000).toISOString() } } });
  await s.make().handle({ envelope: envelopeFor(s.relay, 'msg_t') });
  s.relay.invocations[0].status = 'cancelled';
  s.relay.messages.push(haltEvent('room_1', 6, 'msg_halt'));
  t.mock.timers.tick(POLL);
  await flush();
  t.mock.timers.tick(POLL * 5);
  await flush();
  const halts = s.sessions.get('room_1').floor_warden.halts;
  assert.deepEqual(Object.keys(halts).sort(), ['inv_1', 'inv_recent']);
});

test('retries a retryable forward in-bridge with 1s/2s/4s backoff and forwards on success', async (t) => {
  const s = setup(t, { respond: (n) => ({ status: n < 3 ? 503 : 202 }) });
  const waits = [];
  const bridge = s.make({ retryBackoffMs: [1000, 2000, 4000], sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(await bridge.handle({ envelope: envelopeFor(s.relay, 'msg_t') }), { outcome: 'forwarded' });
  assert.equal(s.posts.length, 3);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(s.relay.failed.length, 0);
  assert.equal(s.sessions.get('room_1').floor_warden.attempts.inv_1, undefined);
});

test('in-bridge retries stop at maxAttempts and fail FLOOR_WARDEN_UNREACHABLE', async (t) => {
  const s = setup(t, { respond: () => ({ status: 503 }) });
  const waits = [];
  const bridge = s.make({ maxAttempts: 3, retryBackoffMs: [1000, 2000, 4000], sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(await bridge.handle({ envelope: envelopeFor(s.relay, 'msg_t') }), { outcome: 'failed', reason: 'FLOOR_WARDEN_UNREACHABLE' });
  assert.equal(s.posts.length, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('past the backoff list the delivery is left for the next poll', async (t) => {
  const s = setup(t, { respond: () => ({ status: 503 }) });
  const waits = [];
  const bridge = s.make({ retryBackoffMs: [1000], sleep: async (ms) => { waits.push(ms); } });
  await assert.rejects(bridge.handle({ envelope: envelopeFor(s.relay, 'msg_t') }), (error) => error.code === 'FLOOR_WARDEN_RETRY');
  assert.equal(s.posts.length, 2);
  assert.deepEqual(waits, [1000]);
  assert.equal(s.sessions.get('room_1').floor_warden.attempts.inv_1, 2);
});

test('a second handle for an already-forwarded invocation makes no POST', async (t) => {
  const s = setup(t);
  const bridge = s.make();
  const envelope = envelopeFor(s.relay, 'msg_t');
  assert.deepEqual(await bridge.handle({ envelope }), { outcome: 'forwarded' });
  assert.deepEqual(await bridge.handle({ envelope }), { outcome: 'skipped' });
  assert.equal(s.posts.length, 1);
});
