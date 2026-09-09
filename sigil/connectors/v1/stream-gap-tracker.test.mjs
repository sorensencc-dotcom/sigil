import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamGapTracker } from './stream-gap-tracker.mjs';

const envelope = (seq) => ({ conversation_id: 'conv_1', sender: { endpoint_id: 'ep_sender' }, message_id: `msg_${seq}`, stream_seq: seq });

test('advances contiguous messages, buffers one gap, and sends one debounced request', async () => {
  const delivered = [], requests = [];
  const tracker = createStreamGapTracker({ onEnvelope: (value) => delivered.push(value.message_id), sendResendRequest: (value) => requests.push(value) });
  assert.equal((await tracker.receive(envelope(1))).status, 'delivered');
  assert.equal((await tracker.receive(envelope(3))).status, 'buffered');
  assert.equal((await tracker.receive(envelope(4))).status, 'buffered');
  assert.deepEqual(delivered, ['msg_1']);
  assert.deepEqual(requests, [{ target_sender_endpoint_id: 'ep_sender', conversation_id: 'conv_1', begin_seq: 2, end_seq: 2 }]);
});

test('drops duplicates and flushes buffered messages after a reset', async () => {
  const delivered = [], events = [];
  const tracker = createStreamGapTracker({ onEnvelope: (value) => delivered.push(value.message_id), onEvent: (value) => events.push(value) });
  await tracker.receive(envelope(2));
  await tracker.receive(envelope(2));
  await tracker.receiveReset({ conversation_id: 'conv_1', target_sender_endpoint_id: 'ep_sender', new_seq: 3, reason: 'expired' });
  assert.deepEqual(delivered, ['msg_2']);
  assert.equal(events[0].type, 'sequence_reset');
  assert.equal(tracker.snapshot()[0].last_contiguous_seq, 2);
});

test('releases buffered messages and emits one event after retry exhaustion', async () => {
  const delivered = [], events = [], requests = [];
  const tracker = createStreamGapTracker({ config: { maxRetries: 2 }, onEnvelope: (value) => delivered.push(value.message_id), onEvent: (value) => events.push(value), sendResendRequest: (value) => requests.push(value) });
  await tracker.receive(envelope(3));
  await tracker.retry('conv_1', 'ep_sender');
  await tracker.retry('conv_1', 'ep_sender');
  assert.deepEqual(delivered, ['msg_3']);
  assert.equal(events.filter((event) => event.type === 'unrecoverable_gap').length, 1);
  assert.equal(requests.length, 2);
});

test('persists high-water and reloads it without requesting an earlier gap', async () => {
  let saved = 0;
  const requests = [];
  const first = createStreamGapTracker({ saveHighWater: async (_conversation, _sender, value) => { saved = value; }, sendResendRequest: (value) => requests.push(value) });
  await first.receive(envelope(1));
  assert.equal(saved, 1);
  const second = createStreamGapTracker({ loadHighWater: async () => saved, sendResendRequest: (value) => requests.push(value) });
  assert.equal((await second.receive(envelope(3))).status, 'buffered');
  assert.deepEqual(requests, [{ target_sender_endpoint_id: 'ep_sender', conversation_id: 'conv_1', begin_seq: 2, end_seq: 2 }]);
});

test('releases buffered messages when the buffer bound is hit', async () => {
  const delivered = [], events = [];
  const tracker = createStreamGapTracker({ config: { maxBuffer: 1 }, onEnvelope: (value) => delivered.push(value.message_id), onEvent: (value) => events.push(value) });
  await tracker.receive(envelope(3));
  await tracker.receive(envelope(4));
  assert.deepEqual(delivered, ['msg_3', 'msg_4']);
  assert.equal(events.filter((event) => event.type === 'unrecoverable_gap').length, 1);
});

test('delivers NULL-sequence envelopes without creating gap state', async () => {
  const delivered = [];
  const tracker = createStreamGapTracker({ onEnvelope: (value) => delivered.push(value.message_id) });
  const value = { ...envelope(1), stream_seq: null };
  assert.equal((await tracker.receive(value)).status, 'unsequenced');
  assert.deepEqual(delivered, ['msg_1']);
  assert.deepEqual(tracker.snapshot(), []);
});
