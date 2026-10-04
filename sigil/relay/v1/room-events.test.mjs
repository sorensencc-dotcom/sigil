// sigil/relay/v1/room-events.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createIdentity, identityKeys } from '../../cli/identity.mjs';
import { emitRoomEvent } from './room-events.mjs';
import { signedBytes } from './validate-envelope.mjs';

const NOW = new Date('2026-10-04T12:00:00.000Z');

async function world() {
  const system = createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' });
  const keys = { ep_web: crypto.generateKeyPairSync('ed25519'), ep_claude: crypto.generateKeyPairSync('ed25519') };
  const registered = new Map([
    ['ep_web', { owner_id: 'usr_chris', status: 'active', kind: 'human', key_id: 'key_web', public_key: keys.ep_web.publicKey }],
    ['ep_claude', { owner_id: 'usr_chris', status: 'active', kind: 'agent', key_id: 'key_claude', public_key: keys.ep_claude.publicKey }],
  ]);
  const repository = createMemoryRepository({ registry: registered });
  await repository.ensureRoomSystemEndpoint({ identity: system, now: NOW });
  await repository.createRoom({ conversationId: 'room_1', workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_chris', now: NOW });
  const room = await repository.lookupRoom('room_1');
  return { system, repository, registered, room };
}

test('emits a signed room.event with a room_seq, fanned out to humans only', async () => {
  const { system, repository, registered, room } = await world();
  const body = { kind: 'router_decision', endpoint_ids: ['ep_claude'], reason: 'asks about code' };
  const result = await emitRoomEvent({ identity: system, repository, client: null, room, body, idempotencyKey: 'evt_1', now: NOW, inboxDepthLimit: 100, registered });
  assert.deepEqual(result.fanout.map((d) => d.endpoint_id), ['ep_web']);
  const [item] = await repository.listRoomMessages('room_1', 0n, 10);
  assert.equal(item.envelope.message_type, 'room.event');
  assert.equal(item.envelope.sender.endpoint_id, 'ep_relay_system');
  assert.equal(item.room_seq, '1');
  assert.equal(crypto.verify(null, signedBytes(item.envelope), identityKeys(system).publicKey, Buffer.from(item.envelope.signature.value, 'base64url')), true);
});

test('a repeat call with the same idempotency key writes nothing', async () => {
  const { system, repository, registered, room } = await world();
  const args = { identity: system, repository, client: null, room, body: { kind: 'router_failed', endpoint_ids: [] }, idempotencyKey: 'evt_2', now: NOW, inboxDepthLimit: 100, registered };
  const first = await emitRoomEvent(args);
  const second = await emitRoomEvent(args);
  assert.equal(second.message_id, first.message_id);
  assert.equal((await repository.listRoomMessages('room_1', 0n, 10)).length, 1);
});

test('an invalid body is refused before anything is written', async () => {
  const { system, repository, registered, room } = await world();
  await assert.rejects(emitRoomEvent({ identity: system, repository, client: null, room, body: { kind: 'bogus', endpoint_ids: [] }, idempotencyKey: 'evt_3', now: NOW, inboxDepthLimit: 100, registered }), { code: 'INVALID_ENVELOPE' });
  assert.equal((await repository.listRoomMessages('room_1', 0n, 10)).length, 0);
});
