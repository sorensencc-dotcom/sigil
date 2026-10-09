import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

const base = { workspaceId: 'ws_a', createdByHumanId: 'usr_a', ownerEndpointId: 'ep_owner' };

function setup() {
  return createMemoryRepository({ registry: new Map() });
}

test('renameRoom changes the name and returns the visible room shape', async () => {
  const repository = setup();
  await repository.createRoom({ conversationId: 'room_1', name: 'old', ...base });
  const room = await repository.renameRoom({ conversationId: 'room_1', name: 'new' });
  assert.equal(room.conversation_id, 'room_1');
  assert.equal(room.name, 'new');
  assert.equal('next_room_seq' in room, false);
  assert.equal((await repository.lookupRoom('room_1')).name, 'new');
});

test('renameRoom rejects a name another room in the workspace holds, and leaves the name unchanged', async () => {
  const repository = setup();
  await repository.createRoom({ conversationId: 'room_1', name: 'one', ...base });
  await repository.createRoom({ conversationId: 'room_2', name: 'taken', ...base });
  await assert.rejects(repository.renameRoom({ conversationId: 'room_1', name: 'taken' }), { code: 'ROOM_NAME_TAKEN' });
  assert.equal((await repository.lookupRoom('room_1')).name, 'one');
});

test('renameRoom allows the same name in a different workspace and the room\'s own name', async () => {
  const repository = setup();
  await repository.createRoom({ conversationId: 'room_1', name: 'one', ...base });
  await repository.createRoom({ conversationId: 'room_2', name: 'shared', ...base, workspaceId: 'ws_b' });
  assert.equal((await repository.renameRoom({ conversationId: 'room_1', name: 'shared' })).name, 'shared');
  assert.equal((await repository.renameRoom({ conversationId: 'room_1', name: 'shared' })).name, 'shared');
});

test('renameRoom rejects an unknown room', async () => {
  await assert.rejects(setup().renameRoom({ conversationId: 'room_missing', name: 'x' }), { code: 'ROOM_NOT_FOUND' });
});

test('setRoomMemberResponseMode updates an active member and returns null otherwise', async () => {
  const repository = setup();
  await repository.createRoom({ conversationId: 'room_1', name: 'one', ...base });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_a' });
  const member = await repository.setRoomMemberResponseMode({ conversationId: 'room_1', endpointId: 'ep_claude', responseMode: 'mentions_only' });
  assert.deepEqual({ ...member, added_at: undefined }, { endpoint_id: 'ep_claude', role: 'member', response_mode: 'mentions_only', added_at: undefined });
  assert.equal((await repository.lookupRoomMember('room_1', 'ep_claude')).response_mode, 'mentions_only');
  assert.equal(await repository.setRoomMemberResponseMode({ conversationId: 'room_1', endpointId: 'ep_missing', responseMode: 'joins' }), null);
  await repository.removeRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude' });
  assert.equal(await repository.setRoomMemberResponseMode({ conversationId: 'room_1', endpointId: 'ep_claude', responseMode: 'joins' }), null);
});
