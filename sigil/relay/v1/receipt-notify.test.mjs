import test from 'node:test';
import assert from 'node:assert/strict';
import { sendReceiptFrame } from './receipt-notify.mjs';

function setup(overrides = {}) {
  const frames = [];
  const stream = { notifyReceipt: (endpointId, frame) => { frames.push({ endpointId, frame }); return true; } };
  const repository = {
    async lookupMessageSender(id) { return id === 'msg_1' ? { endpoint_id: 'ep_sender' } : null; },
    async lookupEnvelopeStreamSequence() { return 7n; },
    ...overrides,
  };
  const logged = [];
  return { frames, stream, repository, logger: { error: (...args) => logged.push(args) }, logged };
}

const INPUT = { message_id: 'msg_1', delivery_id: 'del_1', recipient_endpoint_id: 'ep_r', state: 'acknowledged', at: '2026-10-06T00:00:00.000Z' };

test('sends a frame naming the recipient with the mapped state to the sender', async () => {
  const { frames, stream, repository, logger } = setup();
  assert.equal(await sendReceiptFrame({ stream, repository, logger }, INPUT), true);
  assert.deepEqual(frames, [{ endpointId: 'ep_sender', frame: { message_id: 'msg_1', delivery_id: 'del_1', recipient_endpoint_id: 'ep_r', state: 'acknowledged', mapped_state: 'read', at: INPUT.at, streamSeq: 7n } }]);
});

test('returns false and sends nothing when the sender is unknown', async () => {
  const { frames, stream, repository, logger } = setup();
  assert.equal(await sendReceiptFrame({ stream, repository, logger }, { ...INPUT, message_id: 'msg_other' }), false);
  assert.equal(frames.length, 0);
});

test('a failing lookup is logged and never thrown', async () => {
  const { frames, stream, repository, logger, logged } = setup({ async lookupMessageSender() { throw new Error('lookup failed'); } });
  assert.equal(await sendReceiptFrame({ stream, repository, logger }, INPUT), false);
  assert.equal(frames.length, 0);
  assert.equal(logged.length, 1);
});

test('returns false without a stream or without notifyReceipt', async () => {
  const { repository, logger } = setup();
  assert.equal(await sendReceiptFrame({ stream: null, repository, logger }, INPUT), false);
  assert.equal(await sendReceiptFrame({ stream: {}, repository, logger }, INPUT), false);
});
