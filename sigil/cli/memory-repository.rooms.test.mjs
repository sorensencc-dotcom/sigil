import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

const NOW = new Date('2026-10-02T12:00:00.000Z');

function makeRoom(repository, overrides = {}) {
  return repository.createRoom({
    conversationId: 'room_1', workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris',
    ownerEndpointId: 'ep_chris_web', now: NOW, ...overrides,
  });
}

test('createRoom registers the room and makes the creator its owner', async () => {
  const repository = createMemoryRepository();
  const room = await makeRoom(repository);
  assert.equal(room.conversation_id, 'room_1');
  assert.deepEqual(await repository.lookupRoom('room_1'), room);
  const owner = await repository.lookupRoomMember('room_1', 'ep_chris_web');
  assert.equal(owner.role, 'owner');
  assert.equal(owner.response_mode, null);
});

test('createRoom rejects a duplicate name in the same workspace', async () => {
  const repository = createMemoryRepository();
  await makeRoom(repository);
  await assert.rejects(makeRoom(repository, { conversationId: 'room_2' }), { code: 'ROOM_NAME_TAKEN' });
});

test('addRoomMember, listRoomMembers, and removeRoomMember manage the roster', async () => {
  const repository = createMemoryRepository();
  await makeRoom(repository);
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_chris', now: NOW });
  await assert.rejects(repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', role: 'member', addedByHumanId: 'usr_chris', now: NOW }), { code: 'ROOM_MEMBER_EXISTS' });
  assert.deepEqual((await repository.listRoomMembers('room_1')).map((m) => m.endpoint_id), ['ep_chris_web', 'ep_claude']);
  assert.equal(await repository.removeRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', now: NOW }), true);
  assert.equal(await repository.lookupRoomMember('room_1', 'ep_claude'), null);
  assert.equal(await repository.removeRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', now: NOW }), false);
  assert.deepEqual((await repository.listRoomsForEndpoint('ep_chris_web')).map((r) => r.conversation_id), ['room_1']);
  assert.deepEqual(await repository.listRoomsForEndpoint('ep_claude'), []);
});

test('assignRoomSequence counts up from 1 per room', async () => {
  const repository = createMemoryRepository();
  await makeRoom(repository);
  assert.equal(await repository.assignRoomSequence(null, 'room_1'), 1n);
  assert.equal(await repository.assignRoomSequence(null, 'room_1'), 2n);
});

test('persistAcceptedEnvelope fans a room message out and lists it by room_seq', async () => {
  const repository = createMemoryRepository();
  await makeRoom(repository);
  const envelope = {
    message_id: 'msg_1', conversation_id: 'room_1', message_type: 'room.message',
    sender: { endpoint_id: 'ep_chris_web', owner_id: 'usr_chris' }, broadcast_scope: { conversation_id: 'room_1' },
    body: { text: 'hi' }, idempotency_key: 'idem_1', created_at: NOW.toISOString(), expires_at: '2026-10-02T13:00:00.000Z',
  };
  const persisted = await repository.persistAcceptedEnvelope({ envelope, message_id: 'msg_1', canonical_hash: 'h', roomSeq: 1n, roomFanout: ['ep_claude', 'ep_codex'] });
  assert.deepEqual(persisted.fanout.map((f) => f.endpoint_id), ['ep_claude', 'ep_codex']);
  assert.equal((await repository.listInbox('ep_claude')).length, 1);
  assert.equal((await repository.listInbox('ep_chris_web')).length, 0);
  const messages = await repository.listRoomMessages('room_1', 0n, 100);
  assert.deepEqual(messages.map((m) => [m.room_seq, m.message_id]), [['1', 'msg_1']]);
  assert.deepEqual(await repository.listRoomMessages('room_1', 1n, 100), []);
});
