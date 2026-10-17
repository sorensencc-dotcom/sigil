import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRelayServer } from './http-server.mjs';
import { loadReplyTokens } from './floor-warden-token.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createIdentity } from '../../cli/identity.mjs';
import { createRoomHumanSigner } from './room-human-signer.mjs';
import { createRoomBotSigner } from './room-bot-signer.mjs';
import { wrapPrivateKey } from './key-wrap.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { entryFromRegistryRow } from './trusted-endpoint.mjs';

const REPLY = 'r'.repeat(40);
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const tokenHashes = new Map([[sha('human-token'), 'ep_human'], [sha('agent-token'), 'ep_agent']]);
const registry = new Map([['ep_human', { kind: 'human', owner_id: 'alice' }], ['ep_agent', { kind: 'agent', owner_id: 'alice' }]]);

function call(port, method, path, authorization) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let body = null; try { body = JSON.parse(text); } catch {} resolve({ status: res.statusCode, body }); });
    });
    req.on('error', reject);
    req.end('{}');
  });
}

async function withServer(options, fn) {
  const server = createRelayServer({ registry, tokenHashes, ...options });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(server.address().port); } finally { await new Promise((r) => server.close(r)); }
}

const configured = () => {
  const calls = [];
  const floorWardenReplies = { tokens: loadReplyTokens({ FWT: REPLY }, 'FWT'), handler: async (ctx) => { calls.push(ctx); return { status: 201, body: { code: 'OK' } }; } };
  return { floorWardenReplies, calls };
};
const PATH = '/v1/rooms/room_1/replies';

test('unconfigured route answers 404 for any bearer', async () => {
  await withServer({}, async (port) => {
    for (const auth of [undefined, 'Bearer human-token', `Bearer ${REPLY}`]) {
      assert.equal((await call(port, 'POST', PATH, auth)).status, 404);
    }
  });
});

test('reply token continues to the handler', async () => {
  const { floorWardenReplies, calls } = configured();
  await withServer({ floorWardenReplies }, async (port) => {
    const res = await call(port, 'POST', PATH, `Bearer ${REPLY}`);
    assert.equal(res.status, 201);
    assert.equal(calls[0].roomId, 'room_1');
  });
});

test('valid endpoint bearers get 403 ROUTE_NOT_AUTHORIZED', async () => {
  const { floorWardenReplies, calls } = configured();
  await withServer({ floorWardenReplies }, async (port) => {
    for (const t of ['human-token', 'agent-token']) {
      const res = await call(port, 'POST', PATH, `Bearer ${t}`);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'ROUTE_NOT_AUTHORIZED');
    }
    assert.equal(calls.length, 0);
  });
});

test('no header and wrong header answer 401 UNAUTHENTICATED', async () => {
  const { floorWardenReplies } = configured();
  await withServer({ floorWardenReplies }, async (port) => {
    for (const auth of [undefined, 'Bearer nope', 'Basic abc']) {
      const res = await call(port, 'POST', PATH, auth);
      assert.equal(res.status, 401);
      assert.equal(res.body.code, 'UNAUTHENTICATED');
    }
  });
});

test('the reply token is not an endpoint token on other paths', async () => {
  const { floorWardenReplies, calls } = configured();
  await withServer({ floorWardenReplies }, async (port) => {
    assert.equal((await call(port, 'POST', '/v1/rooms/room_1/other', `Bearer ${REPLY}`)).status, 401);
    // Only POST is the reply route; GET falls through to the existing gates.
    assert.notEqual((await call(port, 'GET', PATH, `Bearer ${REPLY}`)).status, 201);
    assert.equal(calls.length, 0);
    assert.equal((await call(port, 'GET', '/v1/health')).status, 200);
  });
});

// ---- Reply handler (spec "Reply route" steps 3-6, 8, 9, 10) ----

const NOW = new Date('2026-10-16T12:00:00.000Z');
const BOT_ID = 'bot_test_0001';
const BOT_EP = 'ep_test_bot';
const ROOM = 'room_1';
const withKeys = (row) => ({ ...row, keys: entryFromRegistryRow(row).keys });

function post(port, path, authorization, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(authorization ? { authorization } : {}) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let parsed = null; try { parsed = JSON.parse(text); } catch {} resolve({ status: res.statusCode, body: parsed }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function withWorld(fn, { botSigner: injectedSigner = null, handler, noWrapKey = false, signerWrapKey = null, wrapRepository = (r) => r } = {}) {
  const human = createIdentity({ ownerId: 'usr_op', endpointId: 'ep_web', kind: 'human' });
  const bot = crypto.generateKeyPairSync('ed25519');
  const botKeyId = 'key_ep_test_bot';
  const wrapKey = crypto.randomBytes(32);
  const registry = new Map([
    ['ep_web', withKeys({ owner_id: 'usr_op', status: 'active', kind: 'human', key_id: human.key_id, public_key: crypto.createPublicKey(human.public_key_pem) })],
    [BOT_EP, withKeys({ owner_id: 'usr_op', status: 'active', kind: 'agent', key_id: botKeyId, public_key: bot.publicKey })],
    ['ep_test_bot2', withKeys({ owner_id: 'usr_op', status: 'active', kind: 'agent', key_id: 'key_ep_test_bot2', public_key: crypto.generateKeyPairSync('ed25519').publicKey })],
  ]);
  const repository = createMemoryRepository({ registry });
  await repository.insertBotSigningKey({ keyId: botKeyId, wrapped: wrapPrivateKey({ wrapKey, endpointId: BOT_EP, keyId: botKeyId, privateKey: bot.privateKey }), now: NOW });
  await repository.insertFloorWardenBot({ bot_id: BOT_ID, endpoint_id: BOT_EP, display_name: 'Test Bot', status: 'active', created_at: NOW });
  await repository.insertFloorWardenBot({ bot_id: 'bot_test_disabled', endpoint_id: 'ep_test_bot2', display_name: 'Off Bot', status: 'disabled', created_at: NOW });
  await repository.createRoom({ conversationId: ROOM, workspaceId: 'ws_usr_op', name: ROOM, createdByHumanId: 'usr_op', ownerEndpointId: 'ep_web', now: NOW });
  await repository.addRoomMember({ conversationId: ROOM, endpointId: BOT_EP, role: 'member', responseMode: 'mentions_only', addedByHumanId: 'usr_op', now: NOW });
  await repository.addRoomMember({ conversationId: ROOM, endpointId: 'ep_test_bot2', role: 'member', responseMode: 'mentions_only', addedByHumanId: 'usr_op', now: NOW });
  const systemIdentity = createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' });
  await repository.ensureRoomSystemEndpoint({ identity: systemIdentity, now: NOW });
  const frames = [];
  const stream = { notify() {}, notifyReceipt() {}, notifyRoom: (id, frame) => { frames.push([id, frame]); return true; } };
  const botSigner = injectedSigner ?? createRoomBotSigner({ repository, wrapKey: noWrapKey ? undefined : (signerWrapKey ?? wrapKey) });
  const floorWardenReplies = { tokens: loadReplyTokens({ FWT: REPLY }, 'FWT'), botSigner, ...(handler ? { handler } : {}) };
  const logs = [];
  const capture = (level) => (...args) => { logs.push([level, ...args]); };
  const logger = { info: capture('info'), warn: capture('warn'), error: capture('error'), debug: capture('debug') };
  const server = createRelayServer({
    registry, repository: wrapRepository(repository), stream, now: () => NOW, roomSystemIdentity: systemIdentity, floorWardenReplies, logger,
    humanSigner: createRoomHumanSigner({ identity: human, repository }),
    authenticate: async (request) => (request.headers.authorization === 'Bearer web' ? { endpoint_id: 'ep_web', owner_id: 'usr_op', human_id: 'usr_op' } : null),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const say = async (text, extra = {}) => {
    const res = await post(port, `/v1/rooms/${ROOM}/messages`, 'Bearer web', { text, idempotency_key: crypto.randomUUID(), ...extra });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.message_id;
  };
  const reply = (fields = {}, { path = `/v1/rooms/${ROOM}/replies`, raw } = {}) => post(port, path, `Bearer ${REPLY}`, raw ?? { room_id: ROOM, target_bot_id: BOT_ID, sender: BOT_EP, text: 'bot answer', idempotency_key: `k_${crypto.randomUUID()}`, ...fields });
  try { await fn({ port, repository, registry, frames, say, reply, logs, botPublicKey: bot.publicKey }); } finally { await new Promise((r) => server.close(r)); }
}

const invoked = async (w) => w.say('hi bot', { mentions: [BOT_EP] });
const running = async (w) => (await w.repository.listRoomInvocations(ROOM, { endpointId: BOT_EP, status: 'running' }))[0] ?? null;

test('400 INVALID_REQUEST for every malformed body', async () => {
  await withWorld(async (w) => {
    const trigger = await invoked(w);
    const base = { room_id: ROOM, target_bot_id: BOT_ID, sender: BOT_EP, in_reply_to: trigger, text: 'ok', idempotency_key: 'k1' };
    const without = (field) => { const copy = { ...base }; delete copy[field]; return copy; };
    const cases = [
      { ...base, extra: 1 },
      { ...base, room_id: 'room_other' },
      without('target_bot_id'), without('sender'), without('in_reply_to'), without('idempotency_key'), without('text'), without('room_id'),
      { ...base, text: '   \n ' },
      { ...base, text: 'x'.repeat(16001) },
      { ...base, idempotency_key: '' },
      { ...base, idempotency_key: 'k'.repeat(129) },
      { ...base, sender: 5 },
      [base],
    ];
    for (const body of cases) {
      const res = await w.reply({}, { raw: JSON.stringify(body) });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 120));
      assert.equal(res.body.code, 'INVALID_REQUEST');
      assert.ok(res.body.request_id);
    }
    for (const raw of ['{not json', '', JSON.stringify({ ...base, text: 'y'.repeat(97 * 1024) })]) {
      const res = await w.reply({}, { raw });
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'INVALID_REQUEST');
    }
    assert.ok(await running(w), 'nothing was accepted');
  });
});

test('text of exactly 16000 characters and a 128 character key are accepted', async () => {
  await withWorld(async (w) => {
    const trigger = await invoked(w);
    const res = await w.reply({ in_reply_to: trigger, text: 'z'.repeat(16000), idempotency_key: 'k'.repeat(128) });
    assert.equal(res.status, 202, JSON.stringify(res.body));
  });
});

test('403 BOT_NOT_ON_ROSTER for unknown, disabled, and mismatched senders', async () => {
  await withWorld(async (w) => {
    const trigger = await invoked(w);
    for (const fields of [{ target_bot_id: 'bot_nobody' }, { target_bot_id: 'bot_test_disabled', sender: 'ep_test_bot2' }, { sender: 'ep_web' }, { sender: 'ep_test_bot2' }]) {
      const res = await w.reply({ in_reply_to: trigger, ...fields });
      assert.equal(res.status, 403, JSON.stringify(fields));
      assert.equal(res.body.code, 'BOT_NOT_ON_ROSTER');
    }
  });
});

test('the roster check runs before the room check, so an unknown bot cannot probe rooms', async () => {
  await withWorld(async (w) => {
    const res = await w.reply({ room_id: 'room_missing', target_bot_id: 'bot_nobody', in_reply_to: 'msg_x' }, { path: '/v1/rooms/room_missing/replies' });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'BOT_NOT_ON_ROSTER');
  });
});

test('404 ROOM_NOT_FOUND and 403 BOT_NOT_A_MEMBER', async () => {
  await withWorld(async (w) => {
    const trigger = await invoked(w);
    const missing = await w.reply({ room_id: 'room_missing', in_reply_to: trigger }, { path: '/v1/rooms/room_missing/replies' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'ROOM_NOT_FOUND');
    await w.repository.removeRoomMember({ conversationId: ROOM, endpointId: BOT_EP, now: NOW });
    const removed = await w.reply({ in_reply_to: trigger });
    assert.equal(removed.status, 403);
    assert.equal(removed.body.code, 'BOT_NOT_A_MEMBER');
  });
});

test('404 MESSAGE_NOT_FOUND for an unknown in_reply_to', async () => {
  await withWorld(async (w) => {
    await invoked(w);
    const res = await w.reply({ in_reply_to: 'msg_unknown' });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'MESSAGE_NOT_FOUND');
  });
});

test('403 ROOM_NOT_INVOKED without a running invocation, or for a different trigger in the same thread', async () => {
  await withWorld(async (w) => {
    const plain = await w.say('no mention');
    const none = await w.reply({ in_reply_to: plain });
    assert.equal(none.status, 403);
    assert.equal(none.body.code, 'ROOM_NOT_INVOKED');

    const first = await invoked(w);
    assert.equal((await w.reply({ in_reply_to: first })).status, 202);
    const second = await w.say('again', { mentions: [BOT_EP], thread_root_id: first });
    assert.equal((await running(w)).trigger_message_id, second);
    const stale = await w.reply({ in_reply_to: first });
    assert.equal(stale.status, 403);
    assert.equal(stale.body.code, 'ROOM_NOT_INVOKED');
    assert.equal((await running(w)).trigger_message_id, second, 'the newer invocation is untouched');
  });
});

for (const code of ['NO_SIGNING_KEY', 'KEY_MISMATCH', 'WRAP_KEY_UNAVAILABLE']) {
  test(`503 BOT_SIGNING_UNAVAILABLE when the signer throws ${code}`, async () => {
    const botSigner = { signForBot: async () => { throw Object.assign(new Error(`signer failed for ${BOT_EP}`), { code }); } };
    await withWorld(async (w) => {
      const res = await w.reply({ in_reply_to: await invoked(w) });
      assert.equal(res.status, 503);
      assert.equal(res.body.code, 'BOT_SIGNING_UNAVAILABLE');
      assert.ok(await running(w));
    }, { botSigner });
  });
}

test('403 ENDPOINT_REVOKED for a revoked bot endpoint', async () => {
  await withWorld(async (w) => {
    const trigger = await invoked(w);
    w.registry.get(BOT_EP).status = 'revoked';
    const res = await w.reply({ in_reply_to: trigger });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'ENDPOINT_REVOKED');
  });
});

test('500 INTERNAL when accept answers 401 INVALID_SIGNATURE', async () => {
  const stray = crypto.generateKeyPairSync('ed25519').privateKey;
  const botSigner = { signForBot: async (id) => ({ privateKey: stray, endpoint: { owner_id: 'usr_op', endpoint_id: id, key_id: 'key_ep_test_bot', kind: 'agent' } }) };
  await withWorld(async (w) => {
    const res = await w.reply({ in_reply_to: await invoked(w) });
    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'INTERNAL');
  }, { botSigner });
});

test('a throwing handler answers 503 DATABASE_UNAVAILABLE with no error text in the body or the logs', async () => {
  await withWorld(async (w) => {
    const res = await w.reply({ in_reply_to: 'msg_x' });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'DATABASE_UNAVAILABLE');
    assert.equal(JSON.stringify(res.body).includes('boom-secret'), false);
    assert.ok(w.logs.length > 0, 'the failure is logged');
    assert.equal(JSON.stringify(w.logs).includes('boom-secret'), false);
  }, { handler: async () => { throw new Error('boom-secret'); } });
});

test('an audit insert that fails after commit answers 503, and the retry answers duplicate and writes the row', async () => {
  let failAudit = true;
  const wrapRepository = (repo) => new Proxy(repo, {
    get(target, prop) {
      if (prop === 'recordAuditEvent') {
        return async (...args) => {
          if (failAudit) { failAudit = false; throw new Error('audit store down boom-secret'); }
          return target.recordAuditEvent(...args);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await withWorld(async (w) => {
    const trigger = await invoked(w);
    const first = await w.reply({ in_reply_to: trigger, idempotency_key: 'k_audit_down' });
    assert.equal(first.status, 503);
    assert.equal(first.body.code, 'DATABASE_UNAVAILABLE');
    assert.equal(JSON.stringify(w.logs).includes('boom-secret'), false);
    const stored = await roomMessages(w);
    assert.equal(stored.length, 1, 'the reply committed before the audit insert failed');
    assert.equal(replyAudits(w).length, 0);

    const retry = await w.reply({ in_reply_to: trigger, idempotency_key: 'k_audit_down' });
    assert.equal(retry.status, 202, JSON.stringify(retry.body));
    assert.deepEqual([retry.body.message_id, retry.body.duplicate], [stored[0].message_id, true]);
    const rows = replyAudits(w);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].outcome, rows[0].object_id], ['duplicate', stored[0].message_id]);
  }, { wrapRepository });
});

test('success: 202, signed agent message from the bot, invocation completed, queue promoted, humans notified', async () => {
  await withWorld(async (w) => {
    const trigger = await invoked(w);
    const queuedTrigger = await w.say('next one', { mentions: [BOT_EP] });
    const inv = await running(w);
    assert.equal(inv.trigger_message_id, trigger);
    w.frames.length = 0;

    const res = await w.reply({ in_reply_to: trigger, text: '  the answer  ' });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.ok(res.body.request_id);
    assert.ok(res.body.message_id);
    assert.equal(res.body.duplicate, false);
    const row = await w.repository.lookupRoomMessage(ROOM, res.body.message_id);
    assert.equal(String(res.body.room_seq), row.room_seq);
    const env = row.envelope;
    assert.equal(env.message_type, 'room.message');
    assert.equal(env.sender.endpoint_id, BOT_EP);
    assert.equal(env.sender.kind, 'agent');
    assert.deepEqual(env.body, { text: 'the answer', thread_root_id: trigger, mentions: [] });
    assert.equal(env.correlation_id, trigger);
    assert.equal(crypto.verify(null, signedBytes(env), w.botPublicKey, Buffer.from(env.signature.value, 'base64url')), true);

    const done = (await w.repository.listRoomInvocations(ROOM, { endpointId: BOT_EP })).find((r) => r.invocation_id === inv.invocation_id);
    assert.equal(done.status, 'completed');
    assert.equal(done.reply_message_id, res.body.message_id);
    assert.equal((await running(w)).trigger_message_id, queuedTrigger, 'next queued invocation promoted');
    assert.ok(w.frames.some(([id, frame]) => id === 'ep_web' && frame.room_id === ROOM && frame.changed === 'messages'), JSON.stringify(w.frames));
    assert.equal(JSON.stringify(res.body).includes(REPLY), false);
  });
});

test('a reply to a trigger that is itself a thread reply lands in the original thread root', async () => {
  await withWorld(async (w) => {
    const root = await w.say('root');
    const trigger = await w.say('in thread', { mentions: [BOT_EP], thread_root_id: root });
    const res = await w.reply({ in_reply_to: trigger });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    const env = (await w.repository.lookupRoomMessage(ROOM, res.body.message_id)).envelope;
    assert.equal(env.body.thread_root_id, root);
    assert.equal(env.correlation_id, trigger);
  });
});

test('a configured route whose signer has no wrap key answers 503 BOT_SIGNING_UNAVAILABLE', async () => {
  await withWorld(async (w) => {
    const res = await w.reply({ in_reply_to: await invoked(w) });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'BOT_SIGNING_UNAVAILABLE');
  }, { noWrapKey: true });
});

test('a wrong bot wrap key answers 503 BOT_SIGNING_UNAVAILABLE, not DATABASE_UNAVAILABLE', async () => {
  await withWorld(async (w) => {
    const res = await w.reply({ in_reply_to: await invoked(w) });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'BOT_SIGNING_UNAVAILABLE');
    assert.ok(await running(w));
  }, { signerWrapKey: crypto.randomBytes(32) });
});

// ---- Idempotency, single-shot completion, and audit (spec "Reply route" step 7, "Idempotency") ----

const roomMessages = async (w, roomId = ROOM) => (await w.repository.listRoomMessages(roomId)).filter((m) => m.envelope?.sender?.endpoint_id === BOT_EP);
const replyAudits = (w) => w.repository._debugGetAuditEvents().filter((e) => e.event_type === 'room.floor_warden_reply');

test('a replay of the same key returns the first result with duplicate true and needs no running invocation', async () => {
  await withWorld(async (w) => {
    const trigger = await invoked(w);
    const first = await w.reply({ in_reply_to: trigger, idempotency_key: 'k_same' });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    assert.equal(first.body.duplicate, false);
    assert.equal(await running(w), null, 'the first reply completed the invocation');

    const again = await w.reply({ in_reply_to: trigger, idempotency_key: 'k_same' });
    assert.equal(again.status, 202, JSON.stringify(again.body));
    assert.deepEqual({ message_id: again.body.message_id, room_seq: again.body.room_seq, duplicate: again.body.duplicate }, { message_id: first.body.message_id, room_seq: first.body.room_seq, duplicate: true });
    assert.equal((await roomMessages(w)).length, 1, 'no second envelope');
  });
});

test('a replay with different text still returns the first result', async () => {
  await withWorld(async (w) => {
    const trigger = await invoked(w);
    const first = await w.reply({ in_reply_to: trigger, idempotency_key: 'k_text', text: 'first text' });
    const changed = await w.reply({ in_reply_to: trigger, idempotency_key: 'k_text', text: 'second text' });
    assert.equal(changed.status, 202, JSON.stringify(changed.body));
    assert.equal(changed.body.message_id, first.body.message_id);
    assert.equal(changed.body.duplicate, true);
    const stored = await roomMessages(w);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].envelope.body.text, 'first text');
  });
});

test('the same key in two rooms does not collide', async () => {
  await withWorld(async (w) => {
    const ROOM2 = 'room_2';
    await w.repository.createRoom({ conversationId: ROOM2, workspaceId: 'ws_usr_op', name: ROOM2, createdByHumanId: 'usr_op', ownerEndpointId: 'ep_web', now: NOW });
    await w.repository.addRoomMember({ conversationId: ROOM2, endpointId: BOT_EP, role: 'member', responseMode: 'mentions_only', addedByHumanId: 'usr_op', now: NOW });
    const t1 = await invoked(w);
    const said = await post(w.port, `/v1/rooms/${ROOM2}/messages`, 'Bearer web', { text: 'hi bot 2', mentions: [BOT_EP], idempotency_key: crypto.randomUUID() });
    assert.equal(said.status, 201, JSON.stringify(said.body));
    const a = await w.reply({ in_reply_to: t1, idempotency_key: 'k_shared' });
    const b = await w.reply({ room_id: ROOM2, in_reply_to: said.body.message_id, idempotency_key: 'k_shared' }, { path: `/v1/rooms/${ROOM2}/replies` });
    assert.equal(a.status, 202, JSON.stringify(a.body));
    assert.equal(b.status, 202, JSON.stringify(b.body));
    assert.equal(b.body.duplicate, false);
    assert.notEqual(a.body.message_id, b.body.message_id);
    assert.equal((await roomMessages(w, ROOM2)).length, 1);
  });
});

test('a second reply under a new key after completion answers 403 ROOM_NOT_INVOKED', async () => {
  await withWorld(async (w) => {
    const trigger = await invoked(w);
    assert.equal((await w.reply({ in_reply_to: trigger, idempotency_key: 'k_one' })).status, 202);
    const second = await w.reply({ in_reply_to: trigger, idempotency_key: 'k_two' });
    assert.equal(second.status, 403);
    assert.equal(second.body.code, 'ROOM_NOT_INVOKED');
    assert.equal((await roomMessages(w)).length, 1);
  });
});

test('a late reply whose pre-check saw the old invocation cannot complete the promoted one', async () => {
  // Simulates the race: the handler's unlocked step 8 read still sees invocation A
  // running, but by the time accept runs, A is completed and B (same thread) runs.
  let staleNext = null;
  const wrapRepository = (repo) => new Proxy(repo, {
    get(target, prop) {
      if (prop === 'lookupRunningInvocation') {
        return async (...args) => {
          if (staleNext) { const row = staleNext; staleNext = null; return row; }
          return target.lookupRunningInvocation(...args);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await withWorld(async (w) => {
    const triggerA = await invoked(w);
    const triggerB = await w.say('follow up', { mentions: [BOT_EP], thread_root_id: triggerA });
    const invA = await running(w);
    assert.equal(invA.trigger_message_id, triggerA);
    assert.equal((await w.reply({ in_reply_to: triggerA, idempotency_key: 'k_a1' })).status, 202);
    const invB = await running(w);
    assert.equal(invB.trigger_message_id, triggerB);

    staleNext = invA;
    const late = await w.reply({ in_reply_to: triggerA, idempotency_key: 'k_a2', text: 'late answer to A' });
    assert.equal(late.status, 403, JSON.stringify(late.body));
    assert.equal(late.body.code, 'ROOM_NOT_INVOKED');
    const stillB = await running(w);
    assert.equal(stillB?.invocation_id, invB.invocation_id, 'B is still running');
    assert.equal((await roomMessages(w)).length, 1);
  }, { wrapRepository });
});

test('every accepted or refused call writes one room.floor_warden_reply audit row without token or text', async () => {
  await withWorld(async (w) => {
    const trigger = await invoked(w);
    const SECRET_TEXT = 'very private reply body 7f3a';
    const ok = await w.reply({ in_reply_to: trigger, idempotency_key: 'k_audit', text: SECRET_TEXT });
    const dup = await w.reply({ in_reply_to: trigger, idempotency_key: 'k_audit', text: SECRET_TEXT });
    const notInvoked = await w.reply({ in_reply_to: trigger, idempotency_key: 'k_audit2', text: SECRET_TEXT });
    const notRostered = await w.reply({ in_reply_to: trigger, target_bot_id: 'bot_nobody', text: SECRET_TEXT });
    const bad = await w.reply({}, { raw: JSON.stringify({ text: SECRET_TEXT }) });
    assert.deepEqual([ok.status, dup.status, notInvoked.status, notRostered.status, bad.status], [202, 202, 403, 403, 400]);

    const rows = replyAudits(w);
    assert.equal(rows.length, 5, JSON.stringify(rows));
    const [r1, r2, r3, r4, r5] = rows;
    assert.deepEqual([r1.subject_id, r1.endpoint_id, r1.conversation_id, r1.object_id, r1.outcome], [BOT_ID, BOT_EP, ROOM, ok.body.message_id, 'accepted']);
    assert.deepEqual([r2.object_id, r2.outcome], [ok.body.message_id, 'duplicate']);
    assert.deepEqual([r3.subject_id, r3.endpoint_id, r3.conversation_id, r3.outcome, r3.reason], [BOT_ID, BOT_EP, ROOM, 'refused', 'ROOM_NOT_INVOKED']);
    assert.deepEqual([r4.outcome, r4.reason, r4.conversation_id], ['refused', 'BOT_NOT_ON_ROSTER', null]);
    assert.deepEqual([r5.outcome, r5.reason], ['refused', 'INVALID_REQUEST']);

    const dump = JSON.stringify(w.repository._debugGetAuditEvents()) + JSON.stringify(w.logs.map((l) => l.map((x) => (x instanceof Error ? { message: x.message, stack: x.stack } : x))));
    assert.equal(dump.includes(REPLY), false, 'no token in audit or logs');
    assert.equal(dump.includes(SECRET_TEXT), false, 'no reply text in audit or logs');
  });
});

test('the unknown-field message truncates a long field name', async () => {
  await withWorld(async (w) => {
    const res = await w.reply({}, { raw: JSON.stringify({ ['f'.repeat(500)]: 1 }) });
    assert.equal(res.status, 400);
    assert.ok(res.body.message.length < 200, res.body.message);
  });
});

test('a late reply for an invocation that Stop cancelled answers 403 ROOM_NOT_INVOKED', async () => {
  await withWorld(async (w) => {
    const trigger = await invoked(w);
    assert.ok(await running(w));
    const stopped = await post(w.port, `/v1/rooms/${ROOM}/stop`, 'Bearer web', {});
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.equal(stopped.body.cancelled, 1);
    const late = await w.reply({ in_reply_to: trigger });
    assert.equal(late.status, 403);
    assert.equal(late.body.code, 'ROOM_NOT_INVOKED');
    const row = (await w.repository.listRoomInvocations(ROOM, { endpointId: BOT_EP }))[0];
    assert.equal(row.status, 'cancelled', 'the late reply does not revive the invocation');
  });
});

test('a throw inside the reply handler still writes one refused audit row', async () => {
  const botSigner = { signForBot: async () => { throw new Error('signer boom-secret'); } };
  await withWorld(async (w) => {
    const res = await w.reply({ in_reply_to: await invoked(w) });
    assert.equal(res.status, 503);
    const rows = replyAudits(w);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.deepEqual([rows[0].subject_id, rows[0].outcome, rows[0].reason], [BOT_ID, 'refused', 'DATABASE_UNAVAILABLE']);
    assert.equal(JSON.stringify(w.repository._debugGetAuditEvents()).includes('boom-secret'), false);
  }, { botSigner });
});
