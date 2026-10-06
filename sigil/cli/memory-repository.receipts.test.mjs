import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

function row(messageId, roomFanout) {
  return {
    message_id: messageId,
    envelope: { message_id: messageId, sender: { endpoint_id: 'ep_sender' }, idempotency_key: `k_${messageId}`, recipient: null },
    canonical_hash: 'h',
    roomFanout,
  };
}

test('in-memory repository reports its initial delivery state', () => {
  assert.equal(createMemoryRepository().initialDeliveryState, 'delivered');
});

test('listReceiptsForMessage returns one row per delivery, ordered by queued_at then recipient', async () => {
  const repository = createMemoryRepository();
  await repository.persistAcceptedEnvelope(row('msg_a', ['ep_z', 'ep_b', 'ep_m']));
  await repository.persistAcceptedEnvelope(row('msg_other', ['ep_x']));
  const rows = await repository.listReceiptsForMessage('msg_a');
  assert.deepEqual(rows.map((r) => r.recipient_endpoint_id).sort(), ['ep_b', 'ep_m', 'ep_z']);
  for (let i = 1; i < rows.length; i += 1) {
    const [prev, next] = [rows[i - 1], rows[i]];
    assert.ok(prev.queued_at < next.queued_at || (prev.queued_at === next.queued_at && prev.recipient_endpoint_id < next.recipient_endpoint_id), 'rows must be ordered');
  }
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.message_id === 'msg_a'));
});

test('listReceiptsForMessage returns an empty list for a message with no deliveries', async () => {
  const repository = createMemoryRepository();
  assert.deepEqual(await repository.listReceiptsForMessage('msg_missing'), []);
});
