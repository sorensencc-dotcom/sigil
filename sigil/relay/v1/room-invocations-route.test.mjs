// sigil/relay/v1/room-invocations-route.test.mjs
// Rooms phase 3: POST /v1/rooms/{room_id}/invocations (the router's pick).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRelayServer } from './http-server.mjs';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { dispatchToTarget } from './room-dispatch.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createIdentity } from '../../cli/identity.mjs';

const NOW = new Date('2026-10-02T12:01:00.000Z');
const ROOM = 'room_1';
const IDS = ['ep_web', 'ep_claude', 'ep_codex', 'ep_router', 'ep_stranger'];
const principals = {
  'Bearer web': { endpoint_id: 'ep_web', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer claude': { endpoint_id: 'ep_claude', owner_id: 'usr_chris' },
  'Bearer codex': { endpoint_id: 'ep_codex', owner_id: 'usr_chris' },
  'Bearer router': { endpoint_id: 'ep_router', owner_id: 'usr_chris' },
  'Bearer stranger': { endpoint_id: 'ep_stranger', owner_id: 'usr_other', human_id: 'usr_other' },
};

function call(port, method, path, authorization, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(authorization ? { authorization } : {}) } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function withWorld(fn, { withSystem = true, stream } = {}) {
  const keys = Object.fromEntries(IDS.map((id) => [id, crypto.generateKeyPairSync('ed25519')]));
  const registry = new Map(IDS.map((id) => [id, { owner_id: id === 'ep_stranger' ? 'usr_other' : 'usr_chris', status: 'active', kind: id === 'ep_web' || id === 'ep_stranger' ? 'human' : 'agent', key_id: `key_${id}`, public_key: keys[id].publicKey }]));
  const repository = createMemoryRepository({ registry });
  await repository.createRoom({ conversationId: ROOM, workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
  for (const [endpointId, responseMode] of [['ep_claude', 'joins'], ['ep_codex', 'mentions_only'], ['ep_router', 'router']]) {
    await repository.addRoomMember({ conversationId: ROOM, endpointId, role: 'member', responseMode, addedByHumanId: 'usr_chris', now: NOW });
  }
  const systemIdentity = createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' });
  await repository.ensureRoomSystemEndpoint({ identity: systemIdentity, now: NOW });
  const server = createRelayServer({ registry, repository, authenticate: async (request) => principals[request.headers.authorization] ?? null, ...(withSystem ? { roomSystemIdentity: systemIdentity } : {}), ...(stream ? { stream } : {}) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const world = { keys, registry, repository, port: server.address().port };
  try { await fn(world); } finally { await new Promise((resolve) => server.close(resolve)); }
}

// Posts a room.message through the real accept pipeline and returns its id.
async function post(w, senderId, body) {
  const envelope = {
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: ROOM, message_type: 'room.message',
    sender: { endpoint_id: senderId, owner_id: 'usr_chris' }, broadcast_scope: { conversation_id: ROOM },
    body, context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: `idem_${crypto.randomUUID()}`, created_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-02T13:00:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: `key_${senderId}`, value: '' },
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), w.keys[senderId].privateKey).toString('base64url');
  const result = await acceptEnvelopeAsync(envelope, { repository: w.repository, registered: w.registry, now: NOW });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  return envelope.message_id;
}

const humanMessage = (w, text, mentions = []) => post(w, 'ep_web', { text, mentions });
const pick = (w, body, token = 'Bearer router') => call(w.port, 'POST', `/v1/rooms/${ROOM}/invocations`, token, body);
const events = async (w) => (await w.repository.listRoomMessages(ROOM, 0n, 200)).filter((item) => item.envelope.message_type === 'room.event');

test('the router picks a joined agent: invocation runs and a router_decision event appears', async () => {
  await withWorld(async (w) => {
    const triggerId = await humanMessage(w, 'who can review this?');
    const res = await pick(w, { trigger_message_id: triggerId, invoke: ['ep_claude'], reason: 'claude reviews' });
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 'OK');
    assert.equal(res.body.duplicate, false);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].status, 'running');
    assert.equal(res.body.items[0].decided_by, 'router');
    assert.equal(res.body.items[0].endpoint_id, 'ep_claude');
    assert.ok(res.body.items[0].delivery_id);
    const evts = await events(w);
    assert.equal(evts.length, 1);
    assert.equal(evts[0].envelope.body.kind, 'router_decision');
    assert.deepEqual(evts[0].envelope.body.endpoint_ids, ['ep_claude']);
    assert.equal(evts[0].envelope.body.reason, 'claude reviews');
    assert.equal((await w.repository.listInbox('ep_claude')).length, 1, 'the picked agent gets the trigger delivery');
  });
});

test('a mentions_only agent is refused with not_eligible and an invocation_refused event', async () => {
  await withWorld(async (w) => {
    const triggerId = await humanMessage(w, 'anyone?');
    const res = await pick(w, { trigger_message_id: triggerId, invoke: ['ep_codex'] });
    assert.equal(res.status, 200);
    assert.equal(res.body.items[0].status, 'refused');
    assert.equal(res.body.items[0].reason, 'not_eligible');
    assert.equal(res.body.items[0].decided_by, 'router');
    const evts = await events(w);
    const refused = evts.filter((e) => e.envelope.body.kind === 'invocation_refused');
    assert.equal(refused.length, 1);
    assert.deepEqual(refused[0].envelope.body.endpoint_ids, ['ep_codex']);
    assert.equal(refused[0].envelope.body.invocation_id, res.body.items[0].invocation_id);
    assert.equal(refused[0].envelope.body.reason, 'not_eligible');
    const decision = evts.find((e) => e.envelope.body.kind === 'router_decision');
    assert.deepEqual(decision.envelope.body.endpoint_ids, [], 'a refused endpoint is not listed as accepted');
    assert.equal((await w.repository.listInbox('ep_codex')).length, 0);
  });
});

test('a non-member, a human, and the router itself are refused', async () => {
  await withWorld(async (w) => {
    const triggerId = await humanMessage(w, 'hello');
    const res = await pick(w, { trigger_message_id: triggerId, invoke: ['ep_stranger', 'ep_web', 'ep_router'] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((i) => [i.endpoint_id, i.status, i.reason]), [
      ['ep_stranger', 'refused', 'not_eligible'], ['ep_web', 'refused', 'not_eligible'], ['ep_router', 'refused', 'not_eligible'],
    ]);
    const evts = await events(w);
    assert.equal(evts.filter((e) => e.envelope.body.kind === 'invocation_refused').length, 3);
    assert.deepEqual(evts.find((e) => e.envelope.body.kind === 'router_decision').envelope.body.endpoint_ids, []);
  });
});

test('an empty pick records a router_decision event with no endpoints', async () => {
  await withWorld(async (w) => {
    const triggerId = await humanMessage(w, 'just chatting');
    const res = await pick(w, { trigger_message_id: triggerId, invoke: [] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, []);
    assert.equal(res.body.duplicate, false);
    const evts = await events(w);
    assert.equal(evts.length, 1);
    assert.equal(evts[0].envelope.body.kind, 'router_decision');
    assert.deepEqual(evts[0].envelope.body.endpoint_ids, []);
    assert.deepEqual(await w.repository.listRoomInvocations(ROOM), []);
  });
});

test('failed:true emits router_failed and refuses a non-empty invoke', async () => {
  await withWorld(async (w) => {
    const triggerId = await humanMessage(w, 'hello');
    const bad = await pick(w, { trigger_message_id: triggerId, invoke: ['ep_claude'], failed: true });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_REQUEST');
    assert.deepEqual(await w.repository.listRoomInvocations(ROOM), []);
    assert.equal((await events(w)).length, 0);
    const ok = await pick(w, { trigger_message_id: triggerId, invoke: [], failed: true, reason: 'model timed out' });
    assert.equal(ok.status, 200);
    const evts = await events(w);
    assert.equal(evts.length, 1);
    assert.equal(evts[0].envelope.body.kind, 'router_failed');
    assert.deepEqual(evts[0].envelope.body.endpoint_ids, []);
    assert.equal(evts[0].envelope.body.reason, 'model timed out');
  });
});

test('only a router member may call the route', async () => {
  await withWorld(async (w) => {
    const triggerId = await humanMessage(w, 'hello');
    const body = { trigger_message_id: triggerId, invoke: ['ep_claude'] };
    assert.equal((await pick(w, body, 'Bearer claude')).status, 403);
    assert.equal((await pick(w, body, 'Bearer claude')).body.code, 'ROUTE_NOT_AUTHORIZED');
    assert.equal((await pick(w, body, 'Bearer web')).status, 403);
    assert.equal((await pick(w, body, 'Bearer codex')).status, 403);
    const stranger = await pick(w, body, 'Bearer stranger');
    assert.equal(stranger.status, 404);
    assert.equal(stranger.body.code, 'ROOM_NOT_FOUND');
    assert.equal((await call(w.port, 'POST', '/v1/rooms/room_missing/invocations', 'Bearer router', body)).status, 404);
    assert.deepEqual(await w.repository.listRoomInvocations(ROOM), []);
    assert.equal((await events(w)).length, 0);
  });
});

test('a trigger that is an agent message, carries a mention, or is not a room.message is refused with 422', async () => {
  await withWorld(async (w) => {
    // Agent message: ep_claude is invoked by a mention, then replies.
    const rootId = await humanMessage(w, '@ep_claude go', ['ep_claude']);
    const agentMessageId = await post(w, 'ep_claude', { text: 'done', thread_root_id: rootId });
    const agentRes = await pick(w, { trigger_message_id: agentMessageId, invoke: ['ep_codex'] });
    assert.equal(agentRes.status, 422);
    assert.equal(agentRes.body.code, 'INVALID_REQUEST');

    // Mention: a mention already decided who runs.
    const mentionId = await humanMessage(w, '@ep_codex hi', ['ep_codex']);
    const mentionRes = await pick(w, { trigger_message_id: mentionId, invoke: ['ep_claude'] });
    assert.equal(mentionRes.status, 422);

    // Not a room.message: use a room.event id, after a legitimate decision created one.
    const plainId = await humanMessage(w, 'plain');
    assert.equal((await pick(w, { trigger_message_id: plainId, invoke: [] })).status, 200);
    const eventId = (await events(w))[0].message_id;
    assert.equal((await pick(w, { trigger_message_id: eventId, invoke: [] })).status, 422);

    // Unknown trigger.
    assert.equal((await pick(w, { trigger_message_id: 'msg_missing', invoke: [] })).status, 422);
    assert.equal((await w.repository.listRoomInvocations(ROOM)).filter((r) => r.decided_by === 'router').length, 0);
  });
});

test('a repeat call for the same trigger returns the original result without new rows or events', async () => {
  await withWorld(async (w) => {
    const triggerId = await humanMessage(w, 'hello');
    const first = await pick(w, { trigger_message_id: triggerId, invoke: ['ep_claude'] });
    assert.equal(first.body.duplicate, false);
    const second = await pick(w, { trigger_message_id: triggerId, invoke: ['ep_claude'] });
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.deepEqual(second.body.items.map((i) => i.invocation_id), first.body.items.map((i) => i.invocation_id));
    assert.equal((await w.repository.listRoomInvocations(ROOM)).length, 1);
    assert.equal((await events(w)).filter((e) => e.envelope.body.kind === 'router_decision').length, 1);
    assert.equal((await w.repository.listInbox('ep_claude')).length, 1);
  });
});

test('a repeated empty pick is also a duplicate and writes no second event', async () => {
  await withWorld(async (w) => {
    const triggerId = await humanMessage(w, 'hello');
    assert.equal((await pick(w, { trigger_message_id: triggerId, invoke: [] })).body.duplicate, false);
    const again = await pick(w, { trigger_message_id: triggerId, invoke: ['ep_claude'] });
    assert.equal(again.body.duplicate, true);
    assert.deepEqual(again.body.items, []);
    assert.equal((await events(w)).length, 1);
    assert.deepEqual(await w.repository.listRoomInvocations(ROOM), []);
  });
});

test('the relay answers 503 when it has no room system identity', async () => {
  await withWorld(async (w) => {
    const triggerId = await humanMessage(w, 'hello');
    const res = await pick(w, { trigger_message_id: triggerId, invoke: ['ep_claude'] });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'ROOM_EVENTS_UNAVAILABLE');
    assert.deepEqual(await w.repository.listRoomInvocations(ROOM), []);
  }, { withSystem: false });
});

test('request bodies are validated', async () => {
  await withWorld(async (w) => {
    const triggerId = await humanMessage(w, 'hello');
    assert.equal((await pick(w, { invoke: [] })).status, 400);
    assert.equal((await pick(w, { trigger_message_id: triggerId })).status, 400);
    assert.equal((await pick(w, { trigger_message_id: triggerId, invoke: 'ep_claude' })).status, 400);
    assert.equal((await pick(w, { trigger_message_id: triggerId, invoke: [1] })).status, 400);
    assert.equal((await pick(w, { trigger_message_id: triggerId, invoke: Array.from({ length: 11 }, (_, i) => `ep_${i}`) })).status, 400);
  });
});

test('a busy agent queues the router pick; a pick with a long reason is clamped', async () => {
  await withWorld(async (w) => {
    await humanMessage(w, '@ep_claude start', ['ep_claude']);
    const triggerId = await humanMessage(w, 'second');
    const res = await pick(w, { trigger_message_id: triggerId, invoke: ['ep_claude'], reason: `x${'y'.repeat(500)}\u0007` });
    assert.equal(res.status, 200);
    assert.equal(res.body.items[0].status, 'queued');
    assert.equal(res.body.items[0].reason.length, 280, 'the stored reason is clamped');
    assert.ok(!res.body.items[0].reason.includes(''));
    const decision = (await events(w)).find((e) => e.envelope.body.kind === 'router_decision');
    assert.deepEqual(decision.envelope.body.endpoint_ids, ['ep_claude'], 'queued counts as accepted');
    assert.equal(decision.envelope.body.reason.length, 280);
  });
});

test('hop budget applies to router picks (dispatchToTarget)', async () => {
  await withWorld(async (w) => {
    const triggerId = await humanMessage(w, 'hello');
    const room = await w.repository.lookupRoom(ROOM);
    for (let i = 0; i < room.max_agent_turns; i += 1) {
      assert.equal((await w.repository.reserveAgentTurn(ROOM, triggerId, room.max_agent_turns, { now: NOW })).allowed, true);
    }
    const { invocation, roomDelivery } = await dispatchToTarget({ room, triggerMessageId: triggerId, threadRootId: triggerId, endpointId: 'ep_claude', decidedBy: 'router', repository: w.repository, client: null, now: NOW, inboxDepthLimit: 100, registered: w.registry });
    assert.equal(invocation.status, 'refused');
    assert.equal(invocation.reason, 'hop_budget');
    assert.equal(invocation.decided_by, 'router');
    assert.equal(roomDelivery, null);
  });
});

function recordingStream() {
  const calls = [];
  return { calls, notify: (...args) => { calls.push(args); }, notifyReceipt() {} };
}

// Persists an envelope straight into the repository, bypassing the accept pipeline,
// so a trigger can have a type the pipeline would never store as a human message.
async function persistRaw(w, messageType, body) {
  const messageId = `msg_raw_${crypto.randomUUID()}`;
  const envelope = {
    protocol: 'sigil/1', message_id: messageId, conversation_id: ROOM, message_type: messageType,
    sender: { endpoint_id: 'ep_web', owner_id: 'usr_chris' }, broadcast_scope: { conversation_id: ROOM },
    body, context_refs: [], capabilities: [], idempotency_key: `idem_${messageId}`,
    created_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-02T13:00:00.000Z',
  };
  await w.repository.persistAcceptedEnvelope({ envelope, message_id: messageId, canonical_hash: 'h', canonical_bytes: Buffer.from('raw'), streamSeq: null, roomSeq: await w.repository.assignRoomSequence(null, ROOM), roomFanout: [] });
  return messageId;
}

test('a human member message of another type is refused with 422 (message_type branch only)', async () => {
  await withWorld(async (w) => {
    const otherId = await persistRaw(w, 'task.request', { text: 'do a thing', mentions: [] });
    const res = await pick(w, { trigger_message_id: otherId, invoke: ['ep_claude'] });
    assert.deepEqual([res.status, res.body.code], [422, 'INVALID_REQUEST']);
    assert.deepEqual(await w.repository.listRoomInvocations(ROOM), []);
    assert.equal((await events(w)).length, 0);
    // Control: the identical shape as a room.message is accepted, so only the type differed.
    const okId = await persistRaw(w, 'room.message', { text: 'do a thing', mentions: [] });
    assert.equal((await pick(w, { trigger_message_id: okId, invoke: ['ep_claude'] })).status, 200);
  });
});

test('stream.notify fires once per running pick after commit, never on duplicate or invalid', async () => {
  const stream = recordingStream();
  await withWorld(async (w) => {
    const triggerId = await humanMessage(w, 'hello');
    // Invalid trigger: nothing notified.
    assert.equal((await pick(w, { trigger_message_id: 'msg_missing', invoke: ['ep_claude'] })).status, 422);
    assert.equal(stream.calls.length, 0);
    // Not eligible (mentions_only): refused, no delivery, nothing notified.
    assert.equal((await pick(w, { trigger_message_id: triggerId, invoke: ['ep_codex'] })).status, 200);
    assert.equal(stream.calls.length, 0);

    const second = await humanMessage(w, 'second');
    const first = await pick(w, { trigger_message_id: second, invoke: ['ep_claude'] });
    assert.equal(first.status, 200);
    assert.equal(stream.calls.length, 1);
    const running = await w.repository.lookupRunningInvocation(ROOM, 'ep_claude');
    assert.deepEqual(stream.calls[0], ['ep_claude', running.delivery_id]);

    const repeat = await pick(w, { trigger_message_id: second, invoke: ['ep_claude'] });
    assert.equal(repeat.body.duplicate, true);
    assert.equal(stream.calls.length, 1, 'a duplicate call notifies nothing');
  }, { stream });
});

test('stream.notify never fires when the pick transaction fails', async () => {
  const stream = recordingStream();
  await withWorld(async (w) => {
    const triggerId = await humanMessage(w, 'hello');
    w.repository.persistAcceptedEnvelope = async () => { throw new Error('boom'); };
    const res = await pick(w, { trigger_message_id: triggerId, invoke: ['ep_claude'] });
    assert.ok(res.status >= 400, `status ${res.status}`);
    assert.equal(stream.calls.length, 0);
    assert.deepEqual(await w.repository.listRoomInvocations(ROOM), [], 'the rolled-back pick leaves no invocation row');
    assert.equal((await w.repository.listInbox('ep_claude')).length, 0, 'the rolled-back pick leaves no delivery');
  }, { stream });
});

test('failed must be a boolean when present; absent means false', async () => {
  await withWorld(async (w) => {
    const triggerId = await humanMessage(w, 'hello');
    for (const bad of ['true', 1, null, {}]) {
      const res = await pick(w, { trigger_message_id: triggerId, invoke: [], failed: bad });
      assert.deepEqual([res.status, res.body.code], [400, 'INVALID_REQUEST'], JSON.stringify(bad));
    }
    assert.equal((await events(w)).length, 0);
    assert.equal((await pick(w, { trigger_message_id: triggerId, invoke: [] })).status, 200);
    assert.equal((await events(w))[0].envelope.body.kind, 'router_decision', 'absent failed is false');
  });
});

function receiptStream() {
  const frames = [];
  return { frames, notify() {}, notifyReceipt: (to, frame) => { frames.push({ to, ...frame }); } };
}

test('a router pick sends one receipt frame to the trigger sender after commit', async () => {
  const stream = receiptStream();
  await withWorld(async (w) => {
    const triggerId = await humanMessage(w, 'hello');
    assert.equal((await pick(w, { trigger_message_id: triggerId, invoke: ['ep_claude'] })).status, 200);
    const running = await w.repository.lookupRunningInvocation(ROOM, 'ep_claude');
    assert.equal(stream.frames.length, 1);
    const [frame] = stream.frames;
    assert.equal(frame.to, 'ep_web');
    assert.equal(frame.message_id, triggerId);
    assert.equal(frame.delivery_id, running.delivery_id);
    assert.equal(frame.recipient_endpoint_id, 'ep_claude');
    assert.equal(frame.state, w.repository.initialDeliveryState ?? 'delivered');
    const repeat = await pick(w, { trigger_message_id: triggerId, invoke: ['ep_claude'] });
    assert.equal(repeat.body.duplicate, true);
    assert.equal(stream.frames.length, 1, 'a duplicate pick sends no second frame');
  }, { stream });
});

test('a promoted queued invocation sends one receipt frame to its trigger sender', async () => {
  const stream = receiptStream();
  await withWorld(async (w) => {
    const first = await humanMessage(w, 'first');
    const second = await humanMessage(w, 'second');
    assert.equal((await pick(w, { trigger_message_id: first, invoke: ['ep_claude'] })).status, 200);
    assert.equal((await pick(w, { trigger_message_id: second, invoke: ['ep_claude'] })).status, 200);
    stream.frames.length = 0;
    const failed = await call(w.port, 'POST', `/v1/rooms/${ROOM}/invocations/fail`, 'Bearer claude', { reason: 'cli exited 1' });
    assert.equal(failed.status, 200);
    const running = await w.repository.lookupRunningInvocation(ROOM, 'ep_claude');
    assert.equal(running.trigger_message_id, second);
    assert.equal(stream.frames.length, 1);
    const [frame] = stream.frames;
    assert.equal(frame.to, 'ep_web');
    assert.equal(frame.message_id, second);
    assert.equal(frame.delivery_id, running.delivery_id);
    assert.equal(frame.recipient_endpoint_id, 'ep_claude');
    assert.equal(frame.state, w.repository.initialDeliveryState ?? 'delivered');
  }, { stream });
});
