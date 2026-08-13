import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, transitionDelivery } from './delivery-state.mjs';

const base = { delivery_id: 'del_1', state: 'queued', attempts: 0 };

test('accepts the normal delivery lifecycle', () => {
  let delivery = transitionDelivery(base, 'delivered', { now: '2026-08-12T12:00:00Z' });
  delivery = transitionDelivery(delivery, 'acknowledged', { now: '2026-08-12T12:00:01Z' });
  delivery = transitionDelivery(delivery, 'processing', { now: '2026-08-12T12:00:02Z' });
  delivery = transitionDelivery(delivery, 'processed', { now: '2026-08-12T12:00:03Z' });
  assert.equal(delivery.state, 'processed');
  assert.equal(delivery.attempts, 1);
  assert.equal(delivery.processed_at, '2026-08-12T12:00:03.000Z');
});

test('rejects acknowledgement before delivery', () => {
  assert.throws(() => transitionDelivery(base, 'acknowledged'), { code: 'INVALID_STATE_TRANSITION' });
});

test('processing failure supports retry and then dead-letter', () => {
  let delivery = { ...base, state: 'acknowledged', attempts: 1 };
  delivery = transitionDelivery(delivery, 'processing');
  delivery = transitionDelivery(delivery, 'processing_failed', { reason: 'runtime unavailable' });
  assert.equal(delivery.failure_reason, 'runtime unavailable');
  delivery = transitionDelivery(delivery, 'processing', { maxAttempts: 3 });
  assert.equal(delivery.state, 'processing');
  delivery = transitionDelivery({ ...delivery, state: 'processing_failed', attempts: 3 }, 'processing', { maxAttempts: 3 });
  assert.equal(delivery.state, 'dead_letter');
});

test('terminal states cannot be mutated', () => {
  assert.equal(canTransition('processed', 'processing'), false);
  assert.equal(canTransition('dead_letter', 'processing'), false);
});
