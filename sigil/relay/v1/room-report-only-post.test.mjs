// Task 10: report_only post path — marker, refusals, rate cap, isolation, receipts.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { entryFromRegistryRow } from './trusted-endpoint.mjs';
import { createRelayServer } from './http-server.mjs';
import { REPORT_RATE_LIMIT, REPORT_TEXT_MAX, REPORT_RATE_WINDOW_MS } from './room-dispatch.mjs';

const withKeys = (row) => ({ ...row, keys: entryFromRegistryRow(row).keys });
const BASE = new Date('2026-10-02T12:01:00.000Z');
const CREATED = '2026-10-02T12:00:00.000Z';
const EXPIRES = '2026-10-02T13:00:00.000Z';

function world() {
  const ids = ['ep_web', 'ep_web2', 'ep_reporter_a', 'ep_reporter_b', 'ep_claude', 'ep_router'];
  const keys = Object.fromEntries(ids.map((id) => [id, crypto.generateKeyPairSync('ed25519')]));
  const registered = new Map(Object.entries(keys).map(([id, pair]) => {
    const kind = id.startsWith('ep_web') ? 'human' : 'agent';
    return [id, withKeys({ owner_id: 'usr_chris', status: 'active', kind, key_id: `key_${id}`, public_key: pair.publicKey })];
  }));
  const repository = createMemoryRepository({ registry: registered });
  return { keys, registered, repository };
}

function roomEnvelope(keys, senderId, overrides = {}) {
  const { body: bodyOverride, created_at, expires_at, ...rest } = overrides;
  const envelope = {
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: 'room_1', message_type: 'room.message',
    sender: { endpoint_id: senderId, owner_id: 'usr_chris' }, broadcast_scope: { conversation_id: 'room_1' },
    body: { text: 'hello report', ...(bodyOverride ?? {}) }, context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: `idem_${crypto.randomUUID()}`,
    created_at: created_at ?? CREATED, expires_at: expires_at ?? EXPIRES,
    signature: { algorithm: 'Ed25519', key_id: `key_${senderId}`, value: '' },
    ...rest,
  };
  if (bodyOverride) envelope.body = { text: 'hello report', ...bodyOverride };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys[senderId].privateKey).toString('base64url');
  return envelope;
}

async function setupRoom(repository, { withRouter = false, withClaude = true } = {}) {
  await repository.createRoom({ conversationId: 'room_1', workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: BASE });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_web2', role: 'member', responseMode: null, addedByHumanId: 'usr_chris', now: BASE });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_reporter_a', role: 'member', responseMode: 'report_only', addedByHumanId: 'usr_chris', now: BASE });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_reporter_b', role: 'member', responseMode: 'report_only', addedByHumanId: 'usr_chris', now: BASE });
  if (withClaude) await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_chris', now: BASE });
  if (withRouter) await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_router', role: 'member', responseMode: 'router', addedByHumanId: 'usr_chris', now: BASE });
}

function isoAt(ms) { return new Date(ms).toISOString(); }

async function postReport(keys, repository, registered, senderId, { now = BASE, text = 'r', idempotency_key, created_at, expires_at, ...extra } = {}) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const created = created_at ?? isoAt(nowMs - 60_000);
  const expires = expires_at ?? isoAt(nowMs + 3_600_000);
  const envelope = roomEnvelope(keys, senderId, {
    body: { text },
    created_at: created,
    expires_at: expires,
    ...(idempotency_key ? { idempotency_key } : {}),
    ...extra,
  });
  return { envelope, result: await acceptEnvelopeAsync(envelope, { repository, registered, now }) };
}

test('report_only top-level room.message is accepted with report_post and no invocation', async () => {
  const { keys, registered, repository } = world();
  await setupRoom(repository);
  const { envelope, result } = await postReport(keys, repository, registered, 'ep_reporter_a', { text: 'x'.repeat(100) });
  assert.equal(result.status, 202);
  assert.equal(result.body.code, 'ACCEPTED');
  const row = await repository.lookupRoomMessage('room_1', envelope.message_id);
  assert.equal(row.report_post, true);
  assert.deepEqual(await repository.listRoomInvocations('room_1'), []);
  assert.equal(await repository.countRecentReports({ conversationId: 'room_1', sinceMs: BASE.getTime() - REPORT_RATE_WINDOW_MS, now: BASE }), 1);
});

test('report_only refusals: mentions, thread, message types, text length', async () => {
  const { keys, registered, repository } = world();
  await setupRoom(repository);
  const cases = [
    [{ body: { text: 'hi', mentions: ['ep_claude'] } }, 'REPORT_MENTIONS_FORBIDDEN'],
    [{ body: { text: 'hi', thread_root_id: 'msg_root' } }, 'REPORT_THREAD_FORBIDDEN'],
    [{ message_type: 'task.request', body: { task_id: 'task_1', instruction: 'do', assignee: 'ep_claude' } }, 'REPORT_MESSAGE_TYPE_FORBIDDEN'],
    [{ message_type: 'task.result', body: { task_id: 'task_1', status: 'completed', summary: 'done' } }, 'REPORT_MESSAGE_TYPE_FORBIDDEN'],
    [{ body: { text: 'x'.repeat(REPORT_TEXT_MAX + 1) } }, 'REPORT_TEXT_TOO_LONG'],
  ];
  for (const [overrides, code] of cases) {
    const envelope = roomEnvelope(keys, 'ep_reporter_a', overrides);
    const result = await acceptEnvelopeAsync(envelope, { repository, registered, now: BASE });
    assert.equal(result.body.code, code, code);
    assert.equal(result.status, 400, code);
  }
  assert.deepEqual(await repository.listRoomMessages('room_1', 0n, 100), []);
});

test('joins agent and human messages keep report_post false; body report_post is rejected', async () => {
  const { keys, registered, repository } = world();
  await setupRoom(repository);
  const human = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_web', { body: { text: 'human', mentions: ['ep_claude'] } }), { repository, registered, now: BASE });
  assert.equal(human.status, 202);
  assert.equal((await repository.lookupRoomMessage('room_1', human.body.message_id)).report_post, false);
  const reply = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_claude', { body: { text: 'reply', thread_root_id: human.body.message_id } }), { repository, registered, now: BASE });
  assert.equal(reply.status, 202);
  assert.equal((await repository.lookupRoomMessage('room_1', reply.body.message_id)).report_post, false);
  const forged = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_web', { body: { text: 'nope', report_post: true } }), { repository, registered, now: BASE });
  assert.equal(forged.body.code, 'INVALID_ENVELOPE');
});

test('room-wide rate cap of 30; duplicate at cap is 202; window pass accepts', async () => {
  const { keys, registered, repository } = world();
  await setupRoom(repository, { withClaude: false });
  const now = BASE;
  const held = [];
  for (let i = 0; i < 15; i++) {
    const a = await postReport(keys, repository, registered, 'ep_reporter_a', { now, text: `a${i}` });
    assert.equal(a.result.status, 202, `a${i}`);
    held.push(a);
    const b = await postReport(keys, repository, registered, 'ep_reporter_b', { now, text: `b${i}` });
    assert.equal(b.result.status, 202, `b${i}`);
    held.push(b);
  }
  assert.equal(await repository.countRecentReports({ conversationId: 'room_1', sinceMs: now.getTime() - REPORT_RATE_WINDOW_MS, now }), REPORT_RATE_LIMIT);
  const limited = await postReport(keys, repository, registered, 'ep_reporter_a', { now, text: 'over' });
  assert.equal(limited.result.status, 429);
  assert.equal(limited.result.body.code, 'REPORT_RATE_LIMITED');
  const dup = await acceptEnvelopeAsync(held[0].envelope, { repository, registered, now });
  assert.equal(dup.status, 202);
  assert.equal(dup.body.duplicate, true);
  const later = new Date(now.getTime() + REPORT_RATE_WINDOW_MS + 1000);
  const after = await postReport(keys, repository, registered, 'ep_reporter_b', { now: later, text: 'after-window' });
  assert.equal(after.result.status, 202);
});

test('report creates no invocation, does not refill hop budget, router gets no delivery, mention of reporter is ignored', async () => {
  const { keys, registered, repository } = world();
  await setupRoom(repository, { withRouter: true });

  const human = await acceptEnvelopeAsync(
    roomEnvelope(keys, 'ep_web', { body: { text: 'hi claude', mentions: ['ep_claude'] } }),
    { repository, registered, now: BASE },
  );
  assert.equal(human.status, 202);
  assert.equal(repository._debugGetAgentTurns('room_1', human.body.message_id), 1);
  const reply = await acceptEnvelopeAsync(
    roomEnvelope(keys, 'ep_claude', { body: { text: 'ok', thread_root_id: human.body.message_id } }),
    { repository, registered, now: BASE },
  );
  assert.equal(reply.status, 202);
  assert.equal(repository._debugGetAgentTurns('room_1', human.body.message_id), 1);

  const beforeInv = (await repository.listRoomInvocations('room_1')).length;
  const beforeRouter = (await repository.listInbox('ep_router')).length;
  const report = await postReport(keys, repository, registered, 'ep_reporter_a', { now: BASE, text: 'fleet report' });
  assert.equal(report.result.status, 202);
  assert.equal((await repository.listRoomInvocations('room_1')).length, beforeInv);
  assert.equal(repository._debugGetAgentTurns('room_1', human.body.message_id), 1);
  assert.equal((await repository.listInbox('ep_router')).length, beforeRouter);

  const mentionReporter = await acceptEnvelopeAsync(
    roomEnvelope(keys, 'ep_web', { body: { text: 'hey reporter', mentions: ['ep_reporter_a'] } }),
    { repository, registered, now: BASE },
  );
  assert.equal(mentionReporter.status, 202);
  assert.equal((await repository.listRoomInvocations('room_1')).filter((r) => r.endpoint_id === 'ep_reporter_a').length, 0);
});

test('membership-change: removed reporter rows still occupy the cap', async () => {
  const { keys, registered, repository } = world();
  await setupRoom(repository, { withClaude: false });
  for (let i = 0; i < 30; i++) {
    const r = await postReport(keys, repository, registered, 'ep_reporter_a', { now: BASE, text: `fill${i}` });
    assert.equal(r.result.status, 202);
  }
  await repository.removeRoomMember({ conversationId: 'room_1', endpointId: 'ep_reporter_a' });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_reporter_a', role: 'member', responseMode: 'mentions_only', addedByHumanId: 'usr_chris', now: BASE });
  const limited = await postReport(keys, repository, registered, 'ep_reporter_b', { now: BASE, text: 'should-429' });
  assert.equal(limited.result.status, 429);
  assert.equal(limited.result.body.code, 'REPORT_RATE_LIMITED');

  await repository.removeRoomMember({ conversationId: 'room_1', endpointId: 'ep_reporter_a' });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_reporter_a', role: 'member', responseMode: 'report_only', addedByHumanId: 'usr_chris', now: BASE });
  const limited2 = await postReport(keys, repository, registered, 'ep_reporter_b', { now: BASE, text: 'still-429' });
  assert.equal(limited2.result.status, 429);

  await repository.removeRoomMember({ conversationId: 'room_1', endpointId: 'ep_reporter_a' });
  const limited3 = await postReport(keys, repository, registered, 'ep_reporter_b', { now: BASE, text: 'still-429-removed' });
  assert.equal(limited3.result.status, 429);

  const later = new Date(BASE.getTime() + REPORT_RATE_WINDOW_MS + 1000);
  const ok = await postReport(keys, repository, registered, 'ep_reporter_b', { now: later, text: 'window-passed' });
  assert.equal(ok.result.status, 202);
});

test('receipts route answers 200 for a real report_only sender and 404 for others', async () => {
  const { keys, registered, repository } = world();
  await setupRoom(repository, { withClaude: false });
  const { envelope, result } = await postReport(keys, repository, registered, 'ep_reporter_a', { text: 'receipts check' });
  assert.equal(result.status, 202);
  const principals = {
    'Bearer reporter': { endpoint_id: 'ep_reporter_a', owner_id: 'usr_chris' },
    'Bearer other': { endpoint_id: 'ep_web', owner_id: 'usr_chris' },
  };
  const server = createRelayServer({
    registry: registered, repository, now: () => BASE,
    authenticate: async (request) => principals[request.headers.authorization] ?? null,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const get = (auth, messageId) => new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: `/v1/messages/${messageId}/receipts`, headers: { authorization: auth } }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      }).on('error', reject);
    });
    const asSender = await get('Bearer reporter', envelope.message_id);
    assert.equal(asSender.status, 200);
    assert.equal(asSender.body.message_id, envelope.message_id);
    assert.ok(Array.isArray(asSender.body.receipts));
    const asOther = await get('Bearer other', envelope.message_id);
    assert.equal(asOther.status, 404);
    assert.equal(asOther.body.code, 'MESSAGE_NOT_FOUND');
    const unknown = await get('Bearer reporter', 'msg_missing');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, 'MESSAGE_NOT_FOUND');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
