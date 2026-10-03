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
  assert.deepEqual((await authorizeRoomEnvelope(base, room, repository, null, { inboxDepthLimit: 10 })).fanout, ['ep_web2']);
});

for (const [name, envelope] of [
  ['a direct recipient', { ...base, broadcast_scope: undefined, recipient: { endpoint_id: 'ep_claude' } }],
  ['a broadcast scope naming another conversation', { ...base, broadcast_scope: { conversation_id: 'room_2' } }],
  ['a non-member sender', { ...base, sender: { endpoint_id: 'ep_stranger' } }],
  ['a message type not allowed in rooms', { ...base, message_type: 'chat.message' }],
  ['a task.request in a room (no assignee binding in phase 1)', { ...base, message_type: 'task.request' }],
  ['a task.result in a room (no assignee binding in phase 1)', { ...base, message_type: 'task.result' }],
]) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(authorizeRoomEnvelope(envelope, room, repository, null), { code: 'ROUTE_NOT_AUTHORIZED' });
  });
}

test('room.* message types are rejected outside a room', () => {
  assert.throws(() => assertRoomTypeHasRoom({ message_type: 'room.message' }, null), { code: 'INVALID_ENVELOPE' });
  assert.doesNotThrow(() => assertRoomTypeHasRoom({ message_type: 'chat.message' }, null));
  assert.doesNotThrow(() => assertRoomTypeHasRoom({ message_type: 'room.message' }, room));
});
