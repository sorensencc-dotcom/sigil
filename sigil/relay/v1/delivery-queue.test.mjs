import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryQueue } from './delivery-queue.mjs';

test('queues and transitions delivery records', () => {
  const queue = new DeliveryQueue();
  queue.enqueue({ delivery_id: 'del_1', message_id: 'msg_1', attempts: 0 });
  assert.equal(queue.queued().length, 1);
  queue.transition('del_1', 'delivered');
  queue.transition('del_1', 'acknowledged');
  assert.equal(queue.get('del_1').state, 'acknowledged');
});

test('missing delivery returns stable unavailable error', () => {
  assert.throws(() => new DeliveryQueue().transition('missing', 'delivered'), { code: 'DELIVERY_UNAVAILABLE' });
});
