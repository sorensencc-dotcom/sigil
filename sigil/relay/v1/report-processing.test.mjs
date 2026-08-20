import test from 'node:test';
import assert from 'node:assert/strict';
import { reportProcessing } from './report-processing.mjs';

test('reports processing start with durable transition', () => {
  const writes = [];
  const response = reportProcessing({ delivery_id: 'del_1', state: 'acknowledged', attempts: 0 }, { state: 'processing' }, { persist: (row) => writes.push(row), now: '2026-08-12T12:00:00Z' });
  assert.equal(response.status, 204);
  assert.equal(response.delivery.state, 'processing');
  assert.equal(writes.length, 1);
});

test('reports processing failure with reason', () => {
  const response = reportProcessing({ delivery_id: 'del_1', state: 'processing', attempts: 1 }, { state: 'processing_failed', reason: 'Claude runtime exited' });
  assert.equal(response.status, 204);
  assert.equal(response.delivery.failure_reason, 'Claude runtime exited');
});

test('rejects invalid report state without persistence', () => {
  let writes = 0;
  const response = reportProcessing({ delivery_id: 'del_1', state: 'acknowledged', attempts: 0 }, { state: 'invalid_status' }, { persist: () => writes++ });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'INVALID_ENVELOPE');
  assert.equal(writes, 0);
});

test('rejects report that violates delivery lifecycle', () => {
  const response = reportProcessing({ delivery_id: 'del_1', state: 'queued', attempts: 0 }, { state: 'processing' });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'DELIVERY_UNAVAILABLE');
});
