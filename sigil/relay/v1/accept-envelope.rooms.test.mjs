// sigil/relay/v1/accept-envelope.rooms.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

const NOW = new Date('2026-10-02T12:01:00.000Z');

function world() {
  const keys = Object.fromEntries(['ep_web', 'ep_claude', 'ep_codex', 'ep_stranger'].map((id) => [id, crypto.generateKeyPairSync('ed25519')]));
  const registered = new Map(Object.entries(keys).map(([id, pair]) => [id, { owner_id: 'usr_chris', status: 'active', key_id: `key_${id}`, public_key: pair.publicKey }]));
  const repository = createMemoryRepository({ registry: registered });
  return { keys, registered, repository };
}

function roomEnvelope(keys, senderId, overrides = {}) {
  const envelope = {
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: 'room_1', message_type: 'room.message',
    sender: { endpoint_id: senderId, owner_id: 'usr_chris' }, broadcast_scope: { conversation_id: 'room_1' },
    body: { text: 'hello room' }, context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: `idem_${crypto.randomUUID()}`, created_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-02T13:00:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: `key_${senderId}`, value: '' },
    ...overrides,
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys[senderId].privateKey).toString('base64url');
  return envelope;
}

async function roomWithMembers(repository) {
  await repository.createRoom({ conversationId: 'room_1', workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_chris', now: NOW });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_codex', role: 'member', responseMode: 'mentions_only', addedByHumanId: 'usr_chris', now: NOW });
}

test('a member room.message is accepted, sequenced, and fanned out', async () => {
  const { keys, registered, repository } = world();
  await roomWithMembers(repository);
  let persistedEvent;
  const first = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_web'), { repository, registered, now: NOW, onPersisted: async (event) => { persistedEvent = event; } });
  assert.equal(first.status, 202);
  const second = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_claude', { body: { text: 'reply', thread_root_id: first.body.message_id } }), { repository, registered, now: NOW });
  assert.equal(second.status, 202);
  const history = await repository.listRoomMessages('room_1', 0n, 100);
  assert.deepEqual(history.map((m) => m.room_seq), ['1', '2']);
  assert.deepEqual(persistedEvent.persisted.fanout.map((f) => f.endpoint_id), ['ep_claude', 'ep_codex']);
  assert.equal((await repository.listInbox('ep_codex')).length, 2);
  assert.equal((await repository.listInbox('ep_web')).length, 1, 'the sender never receives its own message');
});

test('a non-member is refused and nothing is persisted', async () => {
  const { keys, registered, repository } = world();
  await roomWithMembers(repository);
  const result = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_stranger'), { repository, registered, now: NOW });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'ROUTE_NOT_AUTHORIZED');
  assert.deepEqual(await repository.listRoomMessages('room_1', 0n, 100), []);
});

test('a direct envelope into a room conversation is refused', async () => {
  const { keys, registered, repository } = world();
  await roomWithMembers(repository);
  const result = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_web', { broadcast_scope: undefined, recipient: { endpoint_id: 'ep_claude', owner_id: 'usr_chris' } }), { repository, registered, now: NOW });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'ROUTE_NOT_AUTHORIZED');
});

test('room.message outside a room conversation is refused', async () => {
  const { keys, registered, repository } = world();
  const result = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_web', { conversation_id: 'conv_direct', broadcast_scope: undefined, recipient: { endpoint_id: 'ep_claude', owner_id: 'usr_chris' } }), { repository, registered, now: NOW });
  assert.equal(result.body.code, 'INVALID_ENVELOPE');
});

test('a room message replayed with the same idempotency key is a duplicate, not a new room_seq', async () => {
  const { keys, registered, repository } = world();
  await roomWithMembers(repository);
  const envelope = roomEnvelope(keys, 'ep_web');
  await acceptEnvelopeAsync(envelope, { repository, registered, now: NOW });
  const replay = await acceptEnvelopeAsync(envelope, { repository, registered, now: NOW });
  assert.equal(replay.body.duplicate, true);
  assert.deepEqual((await repository.listRoomMessages('room_1', 0n, 100)).map((m) => m.room_seq), ['1']);
});
