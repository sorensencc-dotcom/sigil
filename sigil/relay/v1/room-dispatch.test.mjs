import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { applyRoomDispatch } from './room-dispatch.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createIdentity } from '../../cli/identity.mjs';

const NOW = new Date('2026-10-02T12:01:00.000Z');

function world({ maxTurns } = {}) {
  const ids = ['ep_web', 'ep_claude', 'ep_codex', 'ep_bot', 'ep_router'];
  const keys = Object.fromEntries(ids.map((id) => [id, crypto.generateKeyPairSync('ed25519')]));
  const registered = new Map(ids.map((id) => [id, { owner_id: 'usr_chris', status: 'active', kind: id === 'ep_web' ? 'human' : 'agent', key_id: `key_${id}`, public_key: keys[id].publicKey }]));
  const repository = createMemoryRepository({ registry: registered });
  return { keys, registered, repository, maxTurns };
}

async function room(repository) {
  await repository.createRoom({ conversationId: 'room_1', workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_chris', now: NOW });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_codex', role: 'member', responseMode: 'mentions_only', addedByHumanId: 'usr_chris', now: NOW });
}

function post({ keys }, senderId, body, overrides = {}) {
  const envelope = {
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: 'room_1', message_type: 'room.message',
    sender: { endpoint_id: senderId, owner_id: 'usr_chris' }, broadcast_scope: { conversation_id: 'room_1' },
    body, context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: `idem_${crypto.randomUUID()}`, created_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-02T13:00:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: `key_${senderId}`, value: '' }, ...overrides,
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys[senderId].privateKey).toString('base64url');
  return envelope;
}

async function accept(w, envelope, extra = {}) {
  let persisted = null;
  const result = await acceptEnvelopeAsync(envelope, { repository: w.repository, registered: w.registered, now: NOW, onPersisted: async (event) => { persisted = event.persisted; }, ...extra });
  return { result, persisted };
}

test('a human message reaches humans only; a mention starts a running invocation with a delivery', async () => {
  const w = world();
  await room(w.repository);
  const root = post(w, 'ep_web', { text: 'hi @ep_claude', mentions: ['ep_claude'] });
  const { result, persisted } = await accept(w, root);
  assert.equal(result.status, 202);
  assert.deepEqual(persisted.fanout, [], 'no other human in the room; agents get no fan-out');
  assert.deepEqual(persisted.roomDeliveries.map((d) => d.endpoint_id), ['ep_claude']);
  const [inv] = await w.repository.listRoomInvocations('room_1');
  assert.equal(inv.status, 'running');
  assert.equal(inv.thread_root_id, root.message_id);
  assert.equal((await w.repository.listInbox('ep_codex')).length, 0);
  const mentions = await w.repository.listMentionsForEndpoint('ep_claude');
  assert.deepEqual(mentions.map((item) => item.message_id), [root.message_id]);
  assert.deepEqual(await w.repository.listMentionsForEndpoint('ep_codex'), []);
});

test('a room task.request names an assignee and only that assignee can file the result', async () => {
  const w = world();
  await room(w.repository);
  const request = post(w, 'ep_web', { task_id: 'task_1', instruction: 'review the diff', assignee: 'ep_codex' }, { message_type: 'task.request' });
  const { result, persisted } = await accept(w, request);
  assert.equal(result.status, 202);
  assert.deepEqual(persisted.roomDeliveries.map((d) => d.endpoint_id), ['ep_codex']);
  const [inv] = await w.repository.listRoomInvocations('room_1');
  assert.equal(inv.decided_by, 'assignee');
  assert.equal(inv.endpoint_id, 'ep_codex');
  assert.equal(inv.status, 'running');

  const humanResult = await accept(w, post(w, 'ep_web', { task_id: 'task_1', status: 'completed', summary: 'done' }, { message_type: 'task.result' }));
  assert.equal(humanResult.result.body.code, 'TASK_ASSIGNEE_MISMATCH');

  const filed = await accept(w, post(w, 'ep_codex', { task_id: 'task_1', status: 'completed', summary: 'done', thread_root_id: request.message_id }, { message_type: 'task.result' }));
  assert.equal(filed.result.status, 202);
});

test('an agent without a running invocation cannot post', async () => {
  const w = world();
  await room(w.repository);
  const { result } = await accept(w, post(w, 'ep_claude', { text: 'unprompted' }));
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'ROOM_NOT_INVOKED');
});

test('an agent reply must stay in its invocation thread', async () => {
  const w = world();
  await room(w.repository);
  await accept(w, post(w, 'ep_web', { text: '@ep_claude', mentions: ['ep_claude'] }));
  const { result } = await accept(w, post(w, 'ep_claude', { text: 'elsewhere', thread_root_id: 'msg_other' }));
  assert.equal(result.body.code, 'ROUTE_NOT_AUTHORIZED');
});

test('an agent reply completes its invocation and its mention invokes the next agent', async () => {
  const w = world();
  await room(w.repository);
  const root = post(w, 'ep_web', { text: '@ep_claude', mentions: ['ep_claude'] });
  await accept(w, root);
  const reply = post(w, 'ep_claude', { text: 'over to @ep_codex', thread_root_id: root.message_id, mentions: ['ep_codex'] });
  const { result, persisted } = await accept(w, reply);
  assert.equal(result.status, 202);
  assert.deepEqual(persisted.fanout.map((f) => f.endpoint_id), ['ep_web']);
  assert.deepEqual(persisted.roomDeliveries.map((d) => d.endpoint_id), ['ep_codex']);
  const rows = await w.repository.listRoomInvocations('room_1');
  assert.deepEqual(rows.map((r) => [r.endpoint_id, r.status]).sort(), [['ep_claude', 'completed'], ['ep_codex', 'running']]);
  assert.equal(rows.find((r) => r.endpoint_id === 'ep_claude').reply_message_id, reply.message_id);
});

test('a second mention of a busy agent queues, and its reply promotes the queued one', async () => {
  const w = world();
  await room(w.repository);
  const first = post(w, 'ep_web', { text: '@ep_claude one', mentions: ['ep_claude'] });
  const second = post(w, 'ep_web', { text: '@ep_claude two', mentions: ['ep_claude'] });
  await accept(w, first);
  const queued = await accept(w, second);
  assert.deepEqual(queued.persisted.roomDeliveries, []);
  const reply = post(w, 'ep_claude', { text: 'done one', thread_root_id: first.message_id });
  const { persisted } = await accept(w, reply);
  assert.deepEqual(persisted.roomDeliveries.map((d) => d.endpoint_id), ['ep_claude'], 'the queued invocation was promoted');
  const running = await w.repository.lookupRunningInvocation('room_1', 'ep_claude');
  assert.equal(running.trigger_message_id, second.message_id);
});

test('the hop budget refuses the invocation past max_agent_turns', async () => {
  const w = world();
  await room(w.repository);
  const root = post(w, 'ep_web', { text: '@ep_claude', mentions: ['ep_claude'] });
  await accept(w, root);
  let speaker = 'ep_claude';
  for (let turn = 1; turn <= 6; turn += 1) {
    const next = speaker === 'ep_claude' ? 'ep_codex' : 'ep_claude';
    const { result } = await accept(w, post(w, speaker, { text: `turn ${turn} @${next}`, thread_root_id: root.message_id, mentions: [next] }));
    assert.equal(result.status, 202, `turn ${turn}`);
    speaker = next;
  }
  const rows = await w.repository.listRoomInvocations('room_1');
  assert.equal(rows.filter((r) => r.status === 'completed').length, 6);
  const refused = rows.filter((r) => r.status === 'refused');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].reason, 'hop_budget');
  assert.equal(rows.filter((r) => r.status === 'running' || r.status === 'queued').length, 0);
});

test('a human message in the thread resets the hop budget', async () => {
  const w = world();
  await room(w.repository);
  const root = post(w, 'ep_web', { text: '@ep_claude', mentions: ['ep_claude'] });
  await accept(w, root);
  await accept(w, post(w, 'ep_claude', { text: 'one', thread_root_id: root.message_id }));
  assert.deepEqual(await w.repository.reserveAgentTurn('room_1', root.message_id, 6, { now: NOW }), { allowed: true, agent_turns: 2 });
  await accept(w, post(w, 'ep_web', { text: 'again @ep_claude', thread_root_id: root.message_id, mentions: ['ep_claude'] }));
  assert.equal((await w.repository.reserveAgentTurn('room_1', root.message_id, 6, { now: NOW })).agent_turns, 2, 'reset to 0, then 1 for the new invocation, then this reserve');
});

test('a revoked agent is refused, not delivered to', async () => {
  const w = world();
  await room(w.repository);
  w.registered.get('ep_claude').status = 'revoked';
  const { persisted } = await accept(w, post(w, 'ep_web', { text: '@ep_claude', mentions: ['ep_claude'] }));
  assert.deepEqual(persisted.roomDeliveries, []);
  const [inv] = await w.repository.listRoomInvocations('room_1');
  assert.deepEqual([inv.status, inv.reason], ['refused', 'endpoint_inactive']);
});

test('an agent whose inbox is full is refused with inbox_full', async () => {
  const w = world();
  await room(w.repository);
  await w.repository.createRoomDelivery({ messageId: 'msg_old', endpointId: 'ep_claude', now: NOW });
  const { persisted } = await accept(w, post(w, 'ep_web', { text: '@ep_claude', mentions: ['ep_claude'] }), { inboxDepthLimit: 1 });
  assert.deepEqual(persisted.roomDeliveries, []);
  const [inv] = await w.repository.listRoomInvocations('room_1');
  assert.deepEqual([inv.status, inv.reason], ['refused', 'inbox_full']);
});

test('mentions of non-members, humans, and the sender invoke nothing', async () => {
  const w = world();
  await room(w.repository);
  await accept(w, post(w, 'ep_web', { text: 'x', mentions: ['ep_web', 'ep_nobody'] }));
  assert.deepEqual(await w.repository.listRoomInvocations('room_1'), []);
});

test('an invoked agent posts a room task.request only with an assignee and inside its thread', async () => {
  const w = world();
  await room(w.repository);
  const root = post(w, 'ep_web', { text: '@ep_claude', mentions: ['ep_claude'] });
  await accept(w, root);
  const missing = await accept(w, post(w, 'ep_claude', { task_id: 'task_1', instruction: 'x', thread_root_id: root.message_id }, { message_type: 'task.request' }));
  assert.equal(missing.result.status, 400);
  assert.equal(missing.result.body.code, 'INVALID_ENVELOPE');
  const offThread = await accept(w, post(w, 'ep_claude', { task_id: 'task_1', instruction: 'x', assignee: 'ep_codex' }, { message_type: 'task.request' }));
  assert.equal(offThread.result.body.code, 'ROUTE_NOT_AUTHORIZED');
  const filed = await accept(w, post(w, 'ep_claude', { task_id: 'task_1', instruction: 'x', assignee: 'ep_codex', thread_root_id: root.message_id }, { message_type: 'task.request' }));
  assert.equal(filed.result.status, 202);
  const assigned = (await w.repository.listRoomInvocations('room_1')).find((row) => row.decided_by === 'assignee');
  assert.equal(assigned.endpoint_id, 'ep_codex');
});

test('a retried agent reply is a duplicate, not ROOM_NOT_INVOKED', async () => {
  const w = world();
  await room(w.repository);
  const root = post(w, 'ep_web', { text: '@ep_claude', mentions: ['ep_claude'] });
  await accept(w, root);
  const reply = post(w, 'ep_claude', { text: 'done', thread_root_id: root.message_id });
  await accept(w, reply);
  const { result } = await accept(w, reply);
  assert.deepEqual([result.status, result.body.duplicate], [202, true]);
});

test('a stale completing invocation is refused (race between two agent replies)', async () => {
  // The memory repository has no real transactions, so the race is simulated by
  // handing applyRoomDispatch a `completing` row that another reply already finished.
  const w = world();
  await room(w.repository);
  const root = post(w, 'ep_web', { text: '@ep_claude', mentions: ['ep_claude'] });
  await accept(w, root);
  const running = await w.repository.lookupRunningInvocation('room_1', 'ep_claude');
  await accept(w, post(w, 'ep_claude', { text: 'first', thread_root_id: root.message_id }));
  const second = post(w, 'ep_claude', { text: 'second', thread_root_id: root.message_id });
  const roomRow = await w.repository.lookupRoom('room_1');
  const plan = { senderMember: { response_mode: 'joins' }, agentMembers: [] };
  await assert.rejects(
    applyRoomDispatch({ envelope: second, room: roomRow, plan, completing: running, repository: w.repository, now: NOW, inboxDepthLimit: 100, registered: w.registered }),
    { code: 'ROOM_NOT_INVOKED' },
  );
  const rows = await w.repository.listRoomInvocations('room_1');
  assert.equal(rows.filter((r) => r.status === 'completed').length, 1);
});

// Phase 1 rooms can hold agent endpoints with response_mode null (added
// without a mode, or an agent that created the room). The registry kind
// still makes them agents.
async function roomWithModelessAgent(repository) {
  await room(repository);
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_bot', role: 'member', responseMode: null, addedByHumanId: 'usr_chris', now: NOW });
}

test('an agent-kind member with response_mode null gets no human fan-out', async () => {
  const w = world();
  await roomWithModelessAgent(w.repository);
  const { result, persisted } = await accept(w, post(w, 'ep_web', { text: 'hello room' }));
  assert.equal(result.status, 202);
  assert.deepEqual(persisted.fanout, []);
  assert.equal((await w.repository.listInbox('ep_bot')).length, 0);
});

test('an agent-kind member with response_mode null is invoked by a mention (as mentions_only)', async () => {
  const w = world();
  await roomWithModelessAgent(w.repository);
  const root = post(w, 'ep_web', { text: 'hi @ep_bot', mentions: ['ep_bot'] });
  const { persisted } = await accept(w, root);
  assert.deepEqual(persisted.roomDeliveries.map((d) => d.endpoint_id), ['ep_bot']);
  const [inv] = await w.repository.listRoomInvocations('room_1', { endpointId: 'ep_bot' });
  assert.equal(inv.status, 'running');
});

test('an agent-kind member with response_mode null cannot post without a running invocation', async () => {
  const w = world();
  await roomWithModelessAgent(w.repository);
  const { result } = await accept(w, post(w, 'ep_bot', { text: 'unprompted' }));
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'ROOM_NOT_INVOKED');
});

test('an agent-kind member with response_mode null completes its invocation and does not reset the hop budget', async () => {
  const w = world();
  await roomWithModelessAgent(w.repository);
  const root = post(w, 'ep_web', { text: '@ep_bot', mentions: ['ep_bot'] });
  await accept(w, root);
  const { result } = await accept(w, post(w, 'ep_bot', { text: 'done', thread_root_id: root.message_id }));
  assert.equal(result.status, 202);
  const [inv] = await w.repository.listRoomInvocations('room_1', { endpointId: 'ep_bot' });
  assert.equal(inv.status, 'completed');
  assert.equal((await w.repository.reserveAgentTurn('room_1', root.message_id, 6, { now: NOW })).agent_turns, 2, 'the agent reply did not reset the budget');
});

async function addRouter(repository) {
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_router', role: 'member', responseMode: 'router', addedByHumanId: 'usr_chris', now: NOW });
}

test('an unmentioned human message is delivered to the router member only', async () => {
  const w = world();
  await room(w.repository);
  await addRouter(w.repository);
  const sys = { systemIdentity: await withSystem(w) };
  const { persisted } = await accept(w, post(w, 'ep_web', { text: 'who can fix this?', mentions: [] }), sys);
  assert.deepEqual(persisted.roomDeliveries.map((d) => d.endpoint_id), ['ep_router']);
  assert.deepEqual(persisted.fanout, [], 'the router is an agent member, not human fan-out');
});

test('a mentioned message is never delivered to the router', async () => {
  const w = world();
  await room(w.repository);
  await addRouter(w.repository);
  const sys = { systemIdentity: await withSystem(w) };
  const { persisted } = await accept(w, post(w, 'ep_web', { text: '@ep_claude hi', mentions: ['ep_claude'] }), sys);
  assert.equal(persisted.roomDeliveries.some((d) => d.endpoint_id === 'ep_router'), false);
  assert.deepEqual(persisted.roomDeliveries.map((d) => d.endpoint_id), ['ep_claude']);
});

test('an agent message is never delivered to the router', async () => {
  const w = world();
  await room(w.repository);
  await addRouter(w.repository);
  const sys = { systemIdentity: await withSystem(w) };
  const root = post(w, 'ep_web', { text: '@ep_claude start', mentions: ['ep_claude'] });
  await accept(w, root, sys);
  const { result, persisted } = await accept(w, post(w, 'ep_claude', { text: 'done', mentions: [], thread_root_id: root.message_id }), sys);
  assert.equal(result.status, 202);
  assert.equal(persisted.roomDeliveries.some((d) => d.endpoint_id === 'ep_router'), false);
});

test('no router delivery when no joined agent exists', async () => {
  const w = world();
  await w.repository.createRoom({ conversationId: 'room_1', workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
  await w.repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_codex', role: 'member', responseMode: 'mentions_only', addedByHumanId: 'usr_chris', now: NOW });
  await addRouter(w.repository);
  const sys = { systemIdentity: await withSystem(w) };
  const { persisted } = await accept(w, post(w, 'ep_web', { text: 'anyone?', mentions: [] }), sys);
  assert.deepEqual(persisted.roomDeliveries, []);
});

test('mentioning the router member creates no invocation', async () => {
  const w = world();
  await room(w.repository);
  await addRouter(w.repository);
  const sys = { systemIdentity: await withSystem(w) };
  const { persisted } = await accept(w, post(w, 'ep_web', { text: '@ep_router hi', mentions: ['ep_router'] }), sys);
  assert.deepEqual(await w.repository.listRoomInvocations('room_1'), []);
  assert.equal(persisted.roomDeliveries.some((d) => d.endpoint_id === 'ep_router'), false, 'a mention naming an agent member is not routed');
});

async function withSystem(w) {
  const systemIdentity = createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' });
  await w.repository.ensureRoomSystemEndpoint({ identity: systemIdentity, now: NOW });
  return systemIdentity;
}

// Claude and Codex ping-pong in one thread until the hop budget refuses a mention.
async function driveToHopRefusal(w, extra) {
  const root = post(w, 'ep_web', { text: '@ep_claude', mentions: ['ep_claude'] });
  await accept(w, root, extra);
  let speaker = 'ep_claude';
  for (let turn = 1; turn <= 6; turn += 1) {
    const next = speaker === 'ep_claude' ? 'ep_codex' : 'ep_claude';
    const { result } = await accept(w, post(w, speaker, { text: `turn ${turn} @${next}`, thread_root_id: root.message_id, mentions: [next] }), extra);
    assert.equal(result.status, 202, `turn ${turn}`);
    speaker = next;
  }
}

test('a hop_budget refusal emits an invocation_refused room.event', async () => {
  const w = world();
  await room(w.repository);
  const systemIdentity = await withSystem(w);
  await driveToHopRefusal(w, { systemIdentity });
  const refused = (await w.repository.listRoomInvocations('room_1')).filter((r) => r.status === 'refused');
  assert.equal(refused.length, 1);
  const events = (await w.repository.listRoomMessages('room_1', 0n, 100)).filter((item) => item.envelope.message_type === 'room.event');
  assert.equal(events.length, 1);
  const { body } = events[0].envelope;
  assert.equal(body.kind, 'invocation_refused');
  assert.equal(body.invocation_id, refused[0].invocation_id);
  assert.deepEqual(body.endpoint_ids, [refused[0].endpoint_id]);
  assert.equal(body.reason, 'hop_budget');
});

test('no events are emitted when no system identity is configured', async () => {
  const w = world();
  await room(w.repository);
  await driveToHopRefusal(w, {});
  assert.equal((await w.repository.listRoomInvocations('room_1')).filter((r) => r.status === 'refused').length, 1);
  const items = await w.repository.listRoomMessages('room_1', 0n, 100);
  assert.ok(items.length > 0);
  assert.ok(items.every((item) => item.envelope.message_type === 'room.message'));
});

async function routerPlan(w) {
  const members = await w.repository.listRoomMembers('room_1');
  return {
    senderMember: { endpoint_id: 'ep_web', is_agent: false },
    agentMembers: members.filter((m) => m.response_mode != null).map((m) => ({ ...m, is_agent: true })),
  };
}

test('applyRoomDispatch returns the router delivery in routerDeliveries and roomDeliveries', async () => {
  const w = world();
  await room(w.repository);
  await addRouter(w.repository);
  const sys = { systemIdentity: await withSystem(w) };
  const roomRow = await w.repository.lookupRoom('room_1');
  const result = await applyRoomDispatch({ envelope: post(w, 'ep_web', { text: 'who can fix this?', mentions: [] }), room: roomRow, plan: await routerPlan(w), completing: null, repository: w.repository, now: NOW, inboxDepthLimit: 100, registered: w.registered, ...sys });
  assert.equal(result.routerDeliveries.length, 1);
  assert.equal(result.routerDeliveries[0].endpoint_id, 'ep_router');
  assert.match(result.routerDeliveries[0].delivery_id, /^del_/);
  assert.deepEqual(result.roomDeliveries, result.routerDeliveries);
  assert.deepEqual(result.invocations, []);
});

test('an inactive router is skipped: no delivery and no invocation is created', async () => {
  const w = world();
  await room(w.repository);
  await addRouter(w.repository);
  const sys = { systemIdentity: await withSystem(w) };
  w.registered.get('ep_router').status = 'revoked';
  const roomRow = await w.repository.lookupRoom('room_1');
  const result = await applyRoomDispatch({ envelope: post(w, 'ep_web', { text: 'who can fix this?', mentions: [] }), room: roomRow, plan: await routerPlan(w), completing: null, repository: w.repository, now: NOW, inboxDepthLimit: 100, registered: w.registered, ...sys });
  assert.deepEqual(result.routerDeliveries, []);
  assert.deepEqual(result.roomDeliveries, []);
  assert.deepEqual(result.invocations, []);
  assert.equal(await w.repository.countOpenDeliveries('ep_router'), 0);
  assert.deepEqual(await w.repository.listRoomInvocations('room_1'), []);
});

test('no router delivery when the only joined agent is inactive', async () => {
  const w = world();
  await room(w.repository);
  await addRouter(w.repository);
  const sys = { systemIdentity: await withSystem(w) };
  w.registered.get('ep_claude').status = 'revoked';
  const { persisted } = await accept(w, post(w, 'ep_web', { text: 'anyone?', mentions: [] }), sys);
  assert.deepEqual(persisted.roomDeliveries, []);
  assert.equal(await w.repository.countOpenDeliveries('ep_router'), 0);
});

test('no router delivery when the relay has no room system identity', async () => {
  // The invocations route answers 503 without a system identity, so a router
  // delivery could never be acked and would be retried forever.
  const w = world();
  await room(w.repository);
  await addRouter(w.repository);
  const { persisted } = await accept(w, post(w, 'ep_web', { text: 'who can fix this?', mentions: [] }));
  assert.deepEqual(persisted.roomDeliveries, []);
  assert.equal(await w.repository.countOpenDeliveries('ep_router'), 0);
});
test('a message mentioning only a non-agent is not delivered to the router', async () => {
  // The invocations route answers 422 for any trigger with mentions, so routing it would waste a model call.
  const w = world();
  await room(w.repository);
  await addRouter(w.repository);
  const sys = { systemIdentity: await withSystem(w) };
  const { persisted } = await accept(w, post(w, 'ep_web', { text: '@ep_nobody hi', mentions: ['ep_nobody'] }), sys);
  assert.equal(persisted.roomDeliveries.some((d) => d.endpoint_id === 'ep_router'), false);
  assert.equal(await w.repository.countOpenDeliveries('ep_router'), 0);
});
