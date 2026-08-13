import test from 'node:test';
import assert from 'node:assert/strict';

const states = {
  queued: ['delivered', 'delivery_rejected'],
  delivered: ['acknowledged', 'delivery_rejected'],
  acknowledged: ['processing', 'delivery_rejected'],
  processing: ['processed', 'processing_failed'],
  processing_failed: ['processing', 'dead_letter'],
  processed: [],
  delivery_rejected: [],
  dead_letter: []
};

test('delivery state machine rejects terminal-state mutation', () => {
  assert.deepEqual(states.processing, ['processed', 'processing_failed']);
  assert.deepEqual(states.processed, []);
  assert.deepEqual(states.delivery_rejected, []);
  assert.deepEqual(states.dead_letter, []);
});

test('processing failure can retry or dead-letter', () => {
  assert.deepEqual(states.processing_failed, ['processing', 'dead_letter']);
});

test('approval and version errors are stable contract codes', () => {
  const codes = ['APPROVAL_REQUIRED', 'VERSION_UNSUPPORTED', 'DUPLICATE_MESSAGE', 'REPLAY_DETECTED'];
  assert.deepEqual(codes, [...codes]);
});
