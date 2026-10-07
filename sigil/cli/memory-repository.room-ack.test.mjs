import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

const NOW = new Date('2026-10-02T12:00:00.000Z');

async function seed() {
  const repository = createMemoryRepository();
  for (const [id, name] of [['room_1', 'build'], ['room_2', 'other']]) {
    await repository.createRoom({ conversationId: id, workspaceId: 'ws_usr_chris', name, createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
  }
  const post = async (roomId, n, roomSeq) => {
    const messageId = `msg_${roomId}_${n}`;
    const envelope = {
      message_id: messageId, conversation_id: roomId, message_type: 'room.message',
      sender: { endpoint_id: 'ep_web', owner_id: 'usr_chris' }, broadcast_scope: { conversation_id: roomId },
      body: { text: 'hi' }, idempotency_key: `idem_${messageId}`, created_at: NOW.toISOString(), expires_at: '2026-10-02T13:00:00.000Z',
    };
    await repository.persistAcceptedEnvelope({ envelope, message_id: messageId, canonical_hash: 'h', canonical_bytes: Buffer.from('b'), roomSeq: BigInt(roomSeq), roomFanout: ['ep_claude', 'ep_codex'] });
    return messageId;
  };
  return { repository, post };
}

const deliveryId = (messageId, endpointId) => `del_${messageId}_${endpointId}`;
const stateOf = async (repository, messageId, endpointId) => (await repository.getDelivery(deliveryId(messageId, endpointId), endpointId)).state;
const ack = (repository, over = {}) => repository.acknowledgeRoomDeliveries({ conversationId: 'room_1', endpointId: 'ep_claude', upToRoomSeq: 2n, now: NOW, ...over });

test('queued and delivered rows up to the bound move to acknowledged', async () => {
  const { repository, post } = await seed();
  const m1 = await post('room_1', 1, 1);
  const m2 = await post('room_1', 2, 2);
  await repository.transitionDelivery(deliveryId(m2, 'ep_claude'), 'ep_claude', 'queued', { next: { ...(await repository.getDelivery(deliveryId(m2, 'ep_claude'), 'ep_claude')), state: 'queued' } });
  const moved = await ack(repository);
  assert.deepEqual(moved.map((r) => [r.message_id, r.sender_endpoint_id, r.state]).sort(), [[m1, 'ep_web', 'acknowledged'], [m2, 'ep_web', 'acknowledged']]);
  assert.equal(await stateOf(repository, m1, 'ep_claude'), 'acknowledged');
  assert.equal(await stateOf(repository, m2, 'ep_claude'), 'acknowledged');
});

test('a delivery above the bound is untouched', async () => {
  const { repository, post } = await seed();
  await post('room_1', 1, 1);
  const m3 = await post('room_1', 3, 3);
  await ack(repository);
  assert.equal(await stateOf(repository, m3, 'ep_claude'), 'delivered');
});

test('acknowledged, processing, and processed deliveries are left alone', async () => {
  const { repository, post } = await seed();
  const ids = [await post('room_1', 1, 1), await post('room_1', 2, 2)];
  const m0 = await post('room_1', 0, 1);
  const set = async (messageId, state) => {
    const id = deliveryId(messageId, 'ep_claude');
    await repository.transitionDelivery(id, 'ep_claude', state, { next: { ...(await repository.getDelivery(id, 'ep_claude')), state } });
  };
  await set(ids[0], 'processing');
  await set(ids[1], 'processed');
  await set(m0, 'acknowledged');
  assert.deepEqual(await ack(repository), []);
  assert.equal(await stateOf(repository, ids[0], 'ep_claude'), 'processing');
  assert.equal(await stateOf(repository, ids[1], 'ep_claude'), 'processed');
});

test("another endpoint's deliveries on the same messages are untouched", async () => {
  const { repository, post } = await seed();
  const m1 = await post('room_1', 1, 1);
  await ack(repository);
  assert.equal(await stateOf(repository, m1, 'ep_codex'), 'delivered');
});

test('the return value lists only moved rows and a repeat call returns nothing', async () => {
  const { repository, post } = await seed();
  await post('room_1', 1, 1);
  assert.equal((await ack(repository)).length, 1);
  assert.deepEqual(await ack(repository), []);
});

test("a different room's deliveries are untouched", async () => {
  const { repository, post } = await seed();
  const other = await post('room_2', 1, 1);
  assert.deepEqual(await ack(repository), []);
  assert.equal(await stateOf(repository, other, 'ep_claude'), 'delivered');
});
