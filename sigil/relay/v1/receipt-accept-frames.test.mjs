import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnPersisted } from './http-server.mjs';

function setup(repository = null) {
  const frames = []; const notified = [];
  const stream = {
    notify: (endpointId, deliveryId) => { notified.push({ endpointId, deliveryId }); return true; },
    notifyReceipt: (endpointId, frame) => { frames.push({ endpointId, frame }); return true; },
  };
  return { frames, notified, onPersisted: createOnPersisted(stream, { repository, logger: { error() {} } }) };
}

const ENVELOPE = { sender: { endpoint_id: 'ep_sender' }, created_at: '2026-10-06T00:00:00.000Z' };

test('a direct message sends one frame naming the recipient, with the repository state', async () => {
  const { frames, onPersisted } = setup();
  await onPersisted({ envelope: { ...ENVELOPE, recipient: { endpoint_id: 'ep_r' } }, persisted: { message_id: 'msg_1', delivery_id: 'del_1', duplicate: false, streamSeq: 3n, deliveryState: 'queued' } });
  assert.deepEqual(frames, [{ endpointId: 'ep_sender', frame: { message_id: 'msg_1', delivery_id: 'del_1', recipient_endpoint_id: 'ep_r', state: 'queued', mapped_state: 'queued', at: ENVELOPE.created_at, streamSeq: 3n } }]);
});

test('without a deliveryState the frame keeps the old delivered default', async () => {
  const { frames, onPersisted } = setup();
  await onPersisted({ envelope: { ...ENVELOPE, recipient: { endpoint_id: 'ep_r' } }, persisted: { message_id: 'msg_1', duplicate: false, streamSeq: null } });
  assert.equal(frames[0].frame.state, 'delivered');
  assert.equal(frames[0].frame.delivery_id, 'del_msg_1');
});

test('a room message sends one frame per fan-out target with a real delivery id', async () => {
  const { frames, onPersisted } = setup();
  await onPersisted({
    envelope: ENVELOPE,
    persisted: {
      message_id: 'msg_room', duplicate: false, streamSeq: 5n, deliveryState: 'queued',
      fanout: [{ endpoint_id: 'ep_h2', delivery_id: 'del_h2' }],
      roomDeliveries: [{ endpoint_id: 'ep_agent', delivery_id: 'del_agent', message_id: 'msg_room' }],
    },
  });
  assert.deepEqual(frames.map((f) => [f.endpointId, f.frame.delivery_id, f.frame.recipient_endpoint_id]), [
    ['ep_sender', 'del_h2', 'ep_h2'],
    ['ep_sender', 'del_agent', 'ep_agent'],
  ]);
  assert.ok(frames.every((f) => f.frame.delivery_id !== 'del_msg_room'), 'no invented delivery id');
  assert.ok(frames.every((f) => f.frame.streamSeq === 5n), 'same-accept frames carry the accept streamSeq');
});

test('a promoted agent delivery goes to the trigger message sender, not the reply sender', async () => {
  const repository = { async lookupMessageSender(id) { return id === 'msg_trigger' ? { endpoint_id: 'ep_human' } : null; } };
  const { frames, onPersisted } = setup(repository);
  await onPersisted({
    envelope: { sender: { endpoint_id: 'ep_agent_a' }, created_at: ENVELOPE.created_at },
    persisted: { message_id: 'msg_reply', duplicate: false, streamSeq: 9n, deliveryState: 'queued', roomDeliveries: [{ endpoint_id: 'ep_agent_b', delivery_id: 'del_promoted', message_id: 'msg_trigger' }] },
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].endpointId, 'ep_human');
  assert.equal(frames[0].frame.message_id, 'msg_trigger');
  assert.equal(frames[0].frame.recipient_endpoint_id, 'ep_agent_b');
  assert.equal(frames[0].frame.streamSeq, null, "the reply's stream sequence does not belong to the trigger message");
});

test('a duplicate accept sends no frames', async () => {
  const { frames, notified, onPersisted } = setup();
  await onPersisted({ envelope: { ...ENVELOPE, recipient: { endpoint_id: 'ep_r' } }, persisted: { message_id: 'msg_1', duplicate: true } });
  assert.equal(frames.length, 0);
  assert.equal(notified.length, 0);
});

test('recipient and fan-out notify frames are unchanged', async () => {
  const { notified, onPersisted } = setup();
  await onPersisted({ envelope: { ...ENVELOPE, recipient: { endpoint_id: 'ep_r' } }, persisted: { message_id: 'msg_1', delivery_id: 'del_1', duplicate: false, fanout: [{ endpoint_id: 'ep_h2', delivery_id: 'del_h2' }] } });
  assert.deepEqual(notified, [{ endpointId: 'ep_r', deliveryId: 'msg_1' }, { endpointId: 'ep_h2', deliveryId: 'del_h2' }]);
});
