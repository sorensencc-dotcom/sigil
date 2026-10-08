import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnPersisted } from './http-server.mjs';

test('room fan-out notifies every recipient stream', async () => {
  const notified = [];
  const receipts = [];
  const stream = {
    notify: (endpointId, deliveryId, streamSeq) => notified.push([endpointId, deliveryId, streamSeq]),
    notifyReceipt: (endpointId, receipt) => receipts.push({ endpointId, receipt }),
  };
  await createOnPersisted(stream)({
    envelope: { sender: { endpoint_id: 'ep_web' }, broadcast_scope: { conversation_id: 'room_1' }, created_at: '2026-10-02T12:00:00.000Z' },
    persisted: { message_id: 'msg_1', duplicate: false, streamSeq: 3n, delivery_id: 'del_sender', fanout: [{ endpoint_id: 'ep_claude', delivery_id: 'del_a' }, { endpoint_id: 'ep_codex', delivery_id: 'del_b' }] },
  });
  // Room recipients (fanout) get no streamSeq
  assert.deepEqual(notified, [['ep_claude', 'del_a', undefined], ['ep_codex', 'del_b', undefined]]);
  // One frame per fan-out target, same accept so same streamSeq
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts.map((r) => r.endpointId), ['ep_web', 'ep_web']);
  assert.deepEqual(receipts.map((r) => r.receipt.delivery_id), ['del_a', 'del_b']);
  assert.deepEqual(receipts.map((r) => r.receipt.recipient_endpoint_id), ['ep_claude', 'ep_codex']);
  assert.ok(receipts.every((r) => r.receipt.streamSeq === 3n), 'fan-out frames carry streamSeq');
});

test('duplicates notify nobody', async () => {
  const notified = [];
  await createOnPersisted({ notify: (...args) => notified.push(args) })({
    envelope: { sender: { endpoint_id: 'ep_web' } },
    persisted: { message_id: 'msg_1', duplicate: true, fanout: [{ endpoint_id: 'ep_claude', delivery_id: 'del_a' }] },
  });
  assert.deepEqual(notified, []);
});
