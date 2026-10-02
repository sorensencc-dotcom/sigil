import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnPersisted } from './http-server.mjs';

test('room fan-out notifies every recipient stream', async () => {
  const notified = [];
  const stream = { notify: (endpointId, deliveryId, streamSeq) => notified.push([endpointId, deliveryId, streamSeq]) };
  await createOnPersisted(stream)({
    envelope: { sender: { endpoint_id: 'ep_web' }, broadcast_scope: { conversation_id: 'room_1' }, created_at: '2026-10-02T12:00:00.000Z' },
    persisted: { message_id: 'msg_1', duplicate: false, streamSeq: 3n, fanout: [{ endpoint_id: 'ep_claude', delivery_id: 'del_a' }, { endpoint_id: 'ep_codex', delivery_id: 'del_b' }] },
  });
  assert.deepEqual(notified, [['ep_claude', 'del_a', 3n], ['ep_codex', 'del_b', 3n]]);
});

test('duplicates notify nobody', async () => {
  const notified = [];
  await createOnPersisted({ notify: (...args) => notified.push(args) })({
    envelope: { sender: { endpoint_id: 'ep_web' } },
    persisted: { message_id: 'msg_1', duplicate: true, fanout: [{ endpoint_id: 'ep_claude', delivery_id: 'del_a' }] },
  });
  assert.deepEqual(notified, []);
});
