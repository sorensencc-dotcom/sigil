// Rooms phase 4a: room.updated frames fire after commit only, to humans only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { createRelayServer } from './http-server.mjs';
import { emitRoomEvent } from './room-events.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createIdentity } from '../../cli/identity.mjs';

const NOW = new Date('2026-10-02T12:01:00.000Z');

async function world() {
  const system = createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' });
  const ids = ['ep_web', 'ep_web2', 'ep_claude'];
  const keys = Object.fromEntries(ids.map((id) => [id, crypto.generateKeyPairSync('ed25519')]));
  const registered = new Map(ids.map((id) => [id, { owner_id: 'usr_chris', status: 'active', kind: id === 'ep_claude' ? 'agent' : 'human', key_id: `key_${id}`, public_key: keys[id].publicKey }]));
  const repository = createMemoryRepository({ registry: registered });
  await repository.ensureRoomSystemEndpoint({ identity: system, now: NOW });
  await repository.createRoom({ conversationId: 'room_1', workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_web2', role: 'member', responseMode: null, addedByHumanId: 'usr_chris', now: NOW });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_chris', now: NOW });
  const frames = [];
  const stream = { notify() {}, notifyReceipt() {}, notifyRoom: (id, frame) => { frames.push([id, frame]); return true; } };
  return { system, keys, registered, repository, frames, stream, room: await repository.lookupRoom('room_1') };
}

function roomMessage(keys, senderId) {
  const envelope = {
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: 'room_1', message_type: 'room.message',
    sender: { endpoint_id: senderId, owner_id: 'usr_chris' }, broadcast_scope: { conversation_id: 'room_1' },
    body: { text: 'hello room' }, context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: `idem_${crypto.randomUUID()}`, created_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-02T13:00:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: `key_${senderId}`, value: '' },
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys[senderId].privateKey).toString('base64url');
  return envelope;
}

const byEndpoint = (frames) => frames.map(([id]) => id).sort();

test('a room message sends one room.updated per human member, sender included, none to agents', async () => {
  const w = await world();
  const result = await acceptEnvelopeAsync(roomMessage(w.keys, 'ep_web'), { repository: w.repository, registered: w.registered, now: NOW, stream: w.stream });
  assert.equal(result.status, 202);
  assert.deepEqual(byEndpoint(w.frames), ['ep_web', 'ep_web2']);
  for (const [, frame] of w.frames) assert.deepEqual(frame, { room_id: 'room_1', room_seq: 1, changed: 'messages' });
});

test('a duplicate accept sends no second frame', async () => {
  const w = await world();
  const envelope = roomMessage(w.keys, 'ep_web');
  await acceptEnvelopeAsync(envelope, { repository: w.repository, registered: w.registered, now: NOW, stream: w.stream });
  w.frames.length = 0;
  await acceptEnvelopeAsync(envelope, { repository: w.repository, registered: w.registered, now: NOW, stream: w.stream });
  assert.equal(w.frames.length, 0);
});

test('a rollback after the notify point sends nothing', async () => {
  const w = await world();
  w.repository.resetAgentTurns = async () => { throw new Error('boom'); };
  const result = await acceptEnvelopeAsync(roomMessage(w.keys, 'ep_web'), { repository: w.repository, registered: w.registered, now: NOW, stream: w.stream });
  assert.notEqual(result.status, 202);
  assert.equal(w.frames.length, 0);
});

test('emitRoomEvent sends after its transaction commits and nothing when it rolls back', async () => {
  const w = await world();
  const args = { identity: w.system, repository: w.repository, room: w.room, body: { kind: 'router_decision', endpoint_ids: ['ep_claude'], reason: 'r' }, now: NOW, inboxDepthLimit: 100, registered: w.registered, stream: w.stream };
  await w.repository.withTransaction(async (client) => {
    await emitRoomEvent({ ...args, client, idempotencyKey: 'evt_a' });
    assert.equal(w.frames.length, 0, 'nothing is sent inside the transaction');
  });
  assert.deepEqual(byEndpoint(w.frames), ['ep_web', 'ep_web2']);
  w.frames.length = 0;
  await assert.rejects(w.repository.withTransaction(async (client) => {
    await emitRoomEvent({ ...args, client, idempotencyKey: 'evt_b' });
    throw new Error('rollback');
  }));
  assert.equal(w.frames.length, 0);
});

test('adding and removing a member sends a members frame without room_seq', async () => {
  const w = await world();
  w.registered.set('ep_web3', { owner_id: 'usr_chris', status: 'active', kind: 'human' });
  const principals = { 'Bearer web': { endpoint_id: 'ep_web', owner_id: 'usr_chris', human_id: 'usr_chris' } };
  const server = createRelayServer({ registry: w.registered, repository: w.repository, stream: w.stream, authenticate: async (request) => principals[request.headers.authorization] ?? null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const post = (path, body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: 'Bearer web' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(payload);
  });
  try {
    assert.equal(await post('/v1/rooms/room_1/members', { endpoint_id: 'ep_web3' }), 201);
    assert.deepEqual(byEndpoint(w.frames), ['ep_web', 'ep_web2', 'ep_web3']);
    for (const [, frame] of w.frames) assert.deepEqual(frame, { room_id: 'room_1', changed: 'members' });
    w.frames.length = 0;
    assert.equal(await post('/v1/rooms/room_1/members/ep_web3/remove'), 200);
    assert.deepEqual(byEndpoint(w.frames), ['ep_web', 'ep_web2']);
    for (const [, frame] of w.frames) assert.deepEqual(frame, { room_id: 'room_1', changed: 'members' });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
