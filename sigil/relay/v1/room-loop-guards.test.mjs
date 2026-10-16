// sigil/relay/v1/room-loop-guards.test.mjs
// Rooms phase 6: loop-guard outcomes are visible in the room. A hop-budget
// refusal posts one agent_cap_reached per cap epoch, Stop and member removal
// post one room_halted, a bridge failure posts invocation_failed, and an agent
// message without a mention never reaches the router or starts a run.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRelayServer } from './http-server.mjs';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { dispatchToTarget, emitRefusal, emitRoomHalted } from './room-dispatch.mjs';
import { ROOM_EVENT_KINDS, ROOM_EVENT_REASON_MAX, clampReason, validateRoomEventBody } from '../../contracts/v1/room-event-schema.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createIdentity } from '../../cli/identity.mjs';
import { entryFromRegistryRow } from './trusted-endpoint.mjs';

const withKeys = (row) => ({ ...row, keys: entryFromRegistryRow(row).keys });
const NOW = new Date('2026-10-16T12:00:00.000Z');
const ROOM = 'room_1';
const IDS = ['ep_web', 'ep_guest', 'ep_claude', 'ep_codex', 'ep_router'];
const HUMANS = new Set(['ep_web', 'ep_guest']);
const OWNERS = { ep_guest: 'usr_guest' };
const principals = {
  'Bearer web': { endpoint_id: 'ep_web', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer claude': { endpoint_id: 'ep_claude', owner_id: 'usr_chris' },
  'Bearer codex': { endpoint_id: 'ep_codex', owner_id: 'usr_chris' },
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

async function makeWorld({ router = false } = {}) {
  const keys = Object.fromEntries(IDS.map((id) => [id, crypto.generateKeyPairSync('ed25519')]));
  const registry = new Map(IDS.map((id) => [id, withKeys({ owner_id: OWNERS[id] ?? 'usr_chris', status: 'active', kind: HUMANS.has(id) ? 'human' : 'agent', key_id: `key_${id}`, public_key: keys[id].publicKey })]));
  const repository = createMemoryRepository({ registry });
  await repository.createRoom({ conversationId: ROOM, workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
  const members = [['ep_claude', 'joins'], ['ep_codex', 'mentions_only'], ...(router ? [['ep_router', 'router']] : [])];
  for (const [endpointId, responseMode] of members) {
    await repository.addRoomMember({ conversationId: ROOM, endpointId, role: 'member', responseMode, addedByHumanId: 'usr_chris', now: NOW });
  }
  await repository.addRoomMember({ conversationId: ROOM, endpointId: 'ep_guest', role: 'member', addedByHumanId: 'usr_chris', now: NOW });
  const systemIdentity = createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' });
  await repository.ensureRoomSystemEndpoint({ identity: systemIdentity, now: NOW });
  return { keys, registry, repository, systemIdentity };
}

function envelopeFor(w, senderId, body) {
  const envelope = {
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: ROOM, message_type: 'room.message',
    sender: { endpoint_id: senderId, owner_id: OWNERS[senderId] ?? 'usr_chris' }, broadcast_scope: { conversation_id: ROOM },
    body, context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: `idem_${crypto.randomUUID()}`, created_at: '2026-10-16T11:59:00.000Z', expires_at: '2026-10-16T13:00:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: `key_${senderId}`, value: '' },
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), w.keys[senderId].privateKey).toString('base64url');
  return envelope;
}

// Accepts through the real pipeline with the relay system identity, so refusals emit events.
async function accept(w, senderId, body) {
  const envelope = envelopeFor(w, senderId, body);
  let persisted = null;
  const result = await acceptEnvelopeAsync(envelope, { repository: w.repository, registered: w.registry, now: NOW, systemIdentity: w.systemIdentity, onPersisted: async (event) => { persisted = event.persisted; } });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  return { messageId: envelope.message_id, persisted };
}

const roomEvents = async (w, kind) => (await w.repository.listRoomMessages(ROOM, 0n, 500))
  .map((item) => item.envelope).filter((e) => e.message_type === 'room.event' && (!kind || e.body.kind === kind));

// Claude and Codex hand off in one thread until the hop budget refuses a mention.
// The root mention counts as the first turn, so the sixth handoff is refused.
async function pingPongToRefusal(w, root, firstSpeaker = 'ep_claude') {
  let speaker = firstSpeaker;
  for (let turn = 1; turn <= 6; turn += 1) {
    const next = speaker === 'ep_claude' ? 'ep_codex' : 'ep_claude';
    await accept(w, speaker, { text: `turn ${turn}`, thread_root_id: root, mentions: [next] });
    speaker = next;
  }
}

test('schema: the three new kinds validate, unknown kinds fail, reason clamping still applies', () => {
  for (const kind of ['agent_cap_reached', 'room_halted', 'invocation_failed']) {
    assert.equal(ROOM_EVENT_KINDS.has(kind), true, kind);
    assert.doesNotThrow(() => validateRoomEventBody({ kind, endpoint_ids: ['ep_claude'], reason: 'x' }));
  }
  assert.throws(() => validateRoomEventBody({ kind: 'agent_exploded', endpoint_ids: [] }), (error) => error.code === 'INVALID_ENVELOPE');
  assert.equal(clampReason('a\u0000b'.padEnd(500, 'z')).length, ROOM_EVENT_REASON_MAX);
  assert.equal(clampReason('bad‮text'), 'bad text');
});

test('cap: the refused handoff posts exactly one agent_cap_reached naming the endpoint and the cap', async () => {
  const w = await makeWorld();
  const { messageId: root } = await accept(w, 'ep_web', { text: 'start', mentions: ['ep_claude'] });
  await pingPongToRefusal(w, root);
  const refused = (await w.repository.listRoomInvocations(ROOM)).filter((r) => r.status === 'refused');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].reason, 'hop_budget');
  const caps = await roomEvents(w, 'agent_cap_reached');
  assert.equal(caps.length, 1);
  assert.deepEqual(caps[0].body.endpoint_ids, [refused[0].endpoint_id]);
  assert.match(caps[0].body.reason, /6/, 'the reason states the cap');
  assert.equal(caps[0].sender.endpoint_id, 'ep_relay_system');
  assert.equal((await roomEvents(w, 'invocation_refused')).length, 1);
});

test('cap: a further refusal in the same epoch adds invocation_refused but no second cap event', async () => {
  const w = await makeWorld();
  const { messageId: root } = await accept(w, 'ep_web', { text: 'start', mentions: ['ep_claude'] });
  await pingPongToRefusal(w, root);
  const room = await w.repository.lookupRoom(ROOM);
  await w.repository.withTransaction(async (client) => {
    const { invocation } = await dispatchToTarget({ room, triggerMessageId: root, threadRootId: root, endpointId: 'ep_codex', decidedBy: 'mention', subjectHumanId: 'usr_chris', repository: w.repository, client, now: NOW, inboxDepthLimit: 100, registered: w.registry });
    assert.equal(invocation.reason, 'hop_budget');
    await emitRefusal({ systemIdentity: w.systemIdentity, repository: w.repository, client, room, invocation, now: NOW, inboxDepthLimit: 100, registered: w.registry });
  });
  assert.equal((await roomEvents(w, 'invocation_refused')).length, 2);
  assert.equal((await roomEvents(w, 'agent_cap_reached')).length, 1);
});

test('cap: a human post resets the budget and the next cap hit posts a new cap event', async () => {
  const w = await makeWorld();
  const { messageId: root } = await accept(w, 'ep_web', { text: 'start', mentions: ['ep_claude'] });
  await pingPongToRefusal(w, root);
  assert.equal((await roomEvents(w, 'agent_cap_reached')).length, 1);
  await accept(w, 'ep_web', { text: 'keep going', thread_root_id: root, mentions: ['ep_claude'] });
  await pingPongToRefusal(w, root);
  const caps = await roomEvents(w, 'agent_cap_reached');
  assert.equal(caps.length, 2, 'new epoch, new event');
  assert.notEqual(caps[0].message_id, caps[1].message_id);
});

test('cap: no system identity means no cap event and no failure', async () => {
  const w = await makeWorld();
  w.systemIdentity = null;
  const { messageId: root } = await accept(w, 'ep_web', { text: 'start', mentions: ['ep_claude'] });
  await pingPongToRefusal(w, root);
  assert.equal((await roomEvents(w)).length, 0);
});

test('pins: an agent room.message without mentions reaches no router and starts no run', async () => {
  const w = await makeWorld({ router: true });
  const { messageId: root } = await accept(w, 'ep_web', { text: 'start', mentions: ['ep_claude'] });
  const before = (await w.repository.listInbox('ep_router')).length;
  const { persisted } = await accept(w, 'ep_claude', { text: 'done, no handoff', thread_root_id: root, mentions: [] });
  assert.deepEqual(persisted.roomDeliveries.map((d) => d.endpoint_id), []);
  assert.equal((await w.repository.listInbox('ep_router')).length, before);
  const invocations = await w.repository.listRoomInvocations(ROOM);
  assert.equal(invocations.length, 1, 'only the original mention invocation exists');
  assert.equal(invocations[0].status, 'completed');
  assert.equal(await w.repository.lookupRunningInvocation(ROOM, 'ep_codex'), null);
});

test('pins: an agent room.message with the field omitted also reaches no router', async () => {
  const w = await makeWorld({ router: true });
  const { messageId: root } = await accept(w, 'ep_web', { text: 'start', mentions: ['ep_claude'] });
  const { persisted } = await accept(w, 'ep_claude', { text: 'done', thread_root_id: root });
  assert.deepEqual(persisted.roomDeliveries, []);
  assert.equal((await w.repository.listRoomInvocations(ROOM)).length, 1);
});

async function withServer(fn) {
  const w = await makeWorld();
  const server = createRelayServer({ registry: w.registry, repository: w.repository, authenticate: async (request) => principals[request.headers.authorization] ?? null, roomSystemIdentity: w.systemIdentity });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  w.port = server.address().port;
  try { await fn(w); } finally { await new Promise((resolve) => server.close(resolve)); }
}

async function seedRunning(w, invocationId, endpointId, subjectHumanId = 'usr_chris') {
  await w.repository.createRoomInvocation({ invocationId, roomId: ROOM, workspaceId: 'ws_usr_chris', triggerMessageId: `msg_${invocationId}`, threadRootId: 'msg_root', endpointId, decidedBy: 'mention', status: 'running', subjectHumanId, now: NOW });
}

test('halt: Stop that cancels two invocations posts two invocation_stopped and one room_halted listing both', async () => {
  await withServer(async (w) => {
    await seedRunning(w, 'inv_a', 'ep_claude');
    await seedRunning(w, 'inv_b', 'ep_codex');
    const res = await call(w.port, 'POST', `/v1/rooms/${ROOM}/stop`, 'Bearer web', {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.cancelled, 2);
    assert.equal((await roomEvents(w, 'invocation_stopped')).length, 2);
    const halts = await roomEvents(w, 'room_halted');
    assert.equal(halts.length, 1);
    assert.deepEqual([...halts[0].body.endpoint_ids].sort(), ['ep_claude', 'ep_codex']);
    assert.equal(halts[0].body.reason, 'stopped');
    assert.equal(halts[0].sender.endpoint_id, 'ep_relay_system');
  });
});

test('halt: a Stop that cancels nothing posts no room_halted', async () => {
  await withServer(async (w) => {
    const res = await call(w.port, 'POST', `/v1/rooms/${ROOM}/stop`, 'Bearer web', {});
    assert.equal(res.body.cancelled, 0);
    assert.equal((await roomEvents(w, 'room_halted')).length, 0);
  });
});

test('halt: a retried Stop over the same cancelled invocations posts no second room_halted', async () => {
  await withServer(async (w) => {
    await seedRunning(w, 'inv_a', 'ep_claude');
    await call(w.port, 'POST', `/v1/rooms/${ROOM}/stop`, 'Bearer web', {});
    // A retry that cancels the same invocation ids again must hit the same idempotency key.
    const room = await w.repository.lookupRoom(ROOM);
    await w.repository.withTransaction((client) => emitRoomHalted({
      systemIdentity: w.systemIdentity, repository: w.repository, client, room, rows: [{ invocation_id: 'inv_a', endpoint_id: 'ep_claude' }], reason: 'stopped', now: NOW, inboxDepthLimit: 100, registered: w.registry,
    }));
    assert.equal((await roomEvents(w, 'room_halted')).length, 1);
  });
});

test('halt: removing a human who started running work posts room_halted with reason left', async () => {
  await withServer(async (w) => {
    await seedRunning(w, 'inv_g', 'ep_claude', 'usr_guest');
    const res = await call(w.port, 'POST', `/v1/rooms/${ROOM}/members/ep_guest/remove`, 'Bearer web');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await roomEvents(w, 'invocation_stopped')).length, 1);
    const halts = await roomEvents(w, 'room_halted');
    assert.equal(halts.length, 1);
    assert.deepEqual(halts[0].body.endpoint_ids, ['ep_claude']);
    assert.equal(halts[0].body.reason, 'left');
  });
});

test('halt: removing a human with nothing to cancel posts no room_halted', async () => {
  await withServer(async (w) => {
    const res = await call(w.port, 'POST', `/v1/rooms/${ROOM}/members/ep_guest/remove`, 'Bearer web');
    assert.equal(res.status, 200);
    assert.equal((await roomEvents(w, 'room_halted')).length, 0);
  });
});

test('failure: invocations/fail posts invocation_failed with the clamped reason', async () => {
  await withServer(async (w) => {
    await seedRunning(w, 'inv_f', 'ep_claude');
    const res = await call(w.port, 'POST', `/v1/rooms/${ROOM}/invocations/fail`, 'Bearer claude', { invocation_id: 'inv_f', reason: `boom‮${'x'.repeat(400)}` });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const events = await roomEvents(w, 'invocation_failed');
    assert.equal(events.length, 1);
    assert.equal(events[0].body.invocation_id, 'inv_f');
    assert.deepEqual(events[0].body.endpoint_ids, ['ep_claude']);
    assert.equal(events[0].body.reason.length, ROOM_EVENT_REASON_MAX);
    assert.equal(events[0].body.reason.startsWith('boom '), true);
  });
});

test('failure: a stale invocation_id that matches nothing posts nothing', async () => {
  await withServer(async (w) => {
    await seedRunning(w, 'inv_f', 'ep_claude');
    const res = await call(w.port, 'POST', `/v1/rooms/${ROOM}/invocations/fail`, 'Bearer claude', { invocation_id: 'inv_old', reason: 'late' });
    assert.equal(res.status, 404);
    assert.equal((await roomEvents(w, 'invocation_failed')).length, 0);
  });
});
