import test from 'node:test';
import assert from 'node:assert/strict';
import { mapReceiptState, receiptTimestamp, toReceiptRow } from './receipt-state.mjs';

test('mapReceiptState follows the spec States table', () => {
  assert.equal(mapReceiptState('queued'), 'queued');
  assert.equal(mapReceiptState('delivered'), 'delivered');
  assert.equal(mapReceiptState('acknowledged'), 'read');
  assert.equal(mapReceiptState('processing'), 'read');
  assert.equal(mapReceiptState('processed'), 'processed');
  for (const raw of ['delivery_rejected', 'processing_failed', 'dead_letter']) assert.equal(mapReceiptState(raw), 'failed');
  assert.equal(mapReceiptState('something_new'), 'unknown');
});

test('receiptTimestamp picks the column that matches the state and falls back to queued_at', () => {
  const base = { queued_at: '2026-10-06T00:00:00.000Z', updated_at: '2026-10-06T00:00:09.000Z' };
  assert.equal(receiptTimestamp({ ...base, state: 'queued' }), base.queued_at);
  assert.equal(receiptTimestamp({ ...base, state: 'delivered', delivered_at: '2026-10-06T00:00:01.000Z' }), '2026-10-06T00:00:01.000Z');
  assert.equal(receiptTimestamp({ ...base, state: 'delivered', delivered_at: null }), base.queued_at, 'in-memory rows have no delivered_at');
  assert.equal(receiptTimestamp({ ...base, state: 'acknowledged', acknowledged_at: '2026-10-06T00:00:02.000Z' }), '2026-10-06T00:00:02.000Z');
  assert.equal(receiptTimestamp({ ...base, state: 'processing', processing_at: '2026-10-06T00:00:03.000Z' }), '2026-10-06T00:00:03.000Z');
  assert.equal(receiptTimestamp({ ...base, state: 'processed', processed_at: '2026-10-06T00:00:04.000Z' }), '2026-10-06T00:00:04.000Z');
  assert.equal(receiptTimestamp({ ...base, state: 'processing_failed' }), base.updated_at);
  assert.equal(receiptTimestamp({ ...base, state: 'dead_letter' }), base.updated_at);
});

test('receiptTimestamp converts Date values from pg to ISO strings', () => {
  const at = new Date('2026-10-06T01:02:03.000Z');
  assert.equal(receiptTimestamp({ state: 'delivered', delivered_at: at, queued_at: at }), '2026-10-06T01:02:03.000Z');
});

test('toReceiptRow returns the mapped and raw state side by side', () => {
  const row = toReceiptRow({ recipient_endpoint_id: 'ep_a', state: 'processing_failed', queued_at: '2026-10-06T00:00:00.000Z', updated_at: '2026-10-06T00:00:05.000Z' });
  assert.deepEqual(row, { recipient_endpoint_id: 'ep_a', state: 'failed', raw_state: 'processing_failed', at: '2026-10-06T00:00:05.000Z' });
});
