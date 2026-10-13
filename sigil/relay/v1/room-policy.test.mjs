// sigil/relay/v1/room-policy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeRoomEnvelope, assertRoomTypeHasRoom } from './room-policy.mjs';

const room = { conversation_id: 'room_1' };
const members = [
  { endpoint_id: 'ep_web', role: 'owner', response_mode: null },
  { endpoint_id: 'ep_web2', role: 'member', response_mode: null },
  { endpoint_id: 'ep_claude', role: 'member', response_mode: 'joins' },
  { endpoint_id: 'ep_codex', role: 'member', response_mode: 'mentions_only' },
];
const repository = {
  async lookupRoomMember(_c, endpointId) { return members.find((m) => m.endpoint_id === endpointId) ?? null; },
  async listRoomMembers() { return members; },
  async countOpenDeliveries() { return 0; },
  async lookupRecipientEndpoint() { return { status: 'active' }; },
};
const base = { conversation_id: 'room_1', message_type: 'room.message', sender: { endpoint_id: 'ep_web' }, broadcast_scope: { conversation_id: 'room_1' } };

test('a member broadcast fans out to every other active human member, never to agents', async () => {
  const plan = await authorizeRoomEnvelope(base, room, repository, null, { inboxDepthLimit: 10 });
  assert.deepEqual(plan.fanout, ['ep_web2']);
  assert.deepEqual(plan.agentMembers.map((m) => m.endpoint_id), ['ep_claude', 'ep_codex']);
});

for (const [name, envelope] of [
  ['a direct recipient', { ...base, broadcast_scope: undefined, recipient: { endpoint_id: 'ep_claude' } }],
  ['a broadcast scope naming another conversation', { ...base, broadcast_scope: { conversation_id: 'room_2' } }],
  ['a non-member sender', { ...base, sender: { endpoint_id: 'ep_stranger' } }],
  ['a message type not allowed in rooms', { ...base, message_type: 'chat.message' }],
  ['a task.request assigned to a non-member', { ...base, message_type: 'task.request', body: { task_id: 'task_1', instruction: 'review', assignee: 'ep_stranger' } }],
]) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(authorizeRoomEnvelope(envelope, room, repository, null), { code: 'ROUTE_NOT_AUTHORIZED' });
  });
}

test('a task.request with no assignee is rejected', async () => {
  await assert.rejects(
    authorizeRoomEnvelope({ ...base, message_type: 'task.request', body: { task_id: 'task_1', instruction: 'review' } }, room, repository, null),
    { code: 'INVALID_ENVELOPE' },
  );
});

test('a task.request assigned to a member is allowed', async () => {
  const plan = await authorizeRoomEnvelope({ ...base, message_type: 'task.request', body: { task_id: 'task_1', instruction: 'review', assignee: 'ep_claude' } }, room, repository, null, { inboxDepthLimit: 10 });
  assert.deepEqual(plan.fanout, ['ep_web2']);
});

test('a task.result from a member is allowed', async () => {
  const plan = await authorizeRoomEnvelope({ ...base, message_type: 'task.result', body: { task_id: 'task_1', status: 'completed', summary: 'done' } }, room, repository, null, { inboxDepthLimit: 10 });
  assert.deepEqual(plan.fanout, ['ep_web2']);
});

test('room.* message types are rejected outside a room', () => {
  assert.throws(() => assertRoomTypeHasRoom({ message_type: 'room.message' }, null), { code: 'INVALID_ENVELOPE' });
  assert.doesNotThrow(() => assertRoomTypeHasRoom({ message_type: 'chat.message' }, null));
  assert.doesNotThrow(() => assertRoomTypeHasRoom({ message_type: 'room.message' }, room));
});

// Task 4 (multi-human foundation): fan-out reads trust state from the
// repository only. A stale startup-Map entry must not outvote a suspended row.
test('endpointIsActive: a suspended repository row wins over an active registered Map entry', async () => {
  const { endpointIsActive } = await import('./room-policy.mjs');
  const repo = { async lookupRecipientEndpoint() { return { endpoint_id: 'ep_x', status: 'suspended', kind: 'agent' }; } };
  const registered = new Map([['ep_x', { endpoint_id: 'ep_x', status: 'active', kind: 'agent' }]]);
  assert.equal(await endpointIsActive('ep_x', repo, null, registered), false);
  const missing = { async lookupRecipientEndpoint() { return null; } };
  assert.equal(await endpointIsActive('ep_x', missing, null, registered), false, 'no repository row means inactive, never the Map');
  assert.equal(await endpointIsActive('ep_x', {}, null, registered), true, 'memory mode without lookupRecipientEndpoint reads the Map');
});

test('kind rules: system endpoints are neither agent nor human members', async () => {
  const { isAgentMember, memberIsHuman } = await import('./room-policy.mjs');
  const byKind = (kind) => ({ async lookupRecipientEndpoint(id) { return { endpoint_id: id, status: 'active', kind }; } });
  const member = { endpoint_id: 'ep_y', response_mode: null };
  assert.equal(await isAgentMember(member, byKind('agent'), null), true);
  assert.equal(await memberIsHuman(member, byKind('agent'), null), false);
  assert.equal(await isAgentMember(member, byKind('human'), null), false);
  assert.equal(await memberIsHuman(member, byKind('human'), null), true);
  assert.equal(await isAgentMember(member, byKind('system'), null), false);
  assert.equal(await memberIsHuman(member, byKind('system'), null), false);
  // The Map does not outvote the repository row's kind in Postgres mode.
  const stale = new Map([['ep_y', { endpoint_id: 'ep_y', status: 'active', kind: 'agent' }]]);
  assert.equal(await isAgentMember(member, byKind('human'), null, stale), false);
  assert.equal(await isAgentMember({ ...member, response_mode: 'joins' }, byKind('system'), null), true);
});
