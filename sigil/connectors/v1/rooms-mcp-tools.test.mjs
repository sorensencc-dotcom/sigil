import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomsRuntime } from './rooms-mcp-tools.mjs';

function fakes() {
  const sent = [];
  const relay = {
    request: async (path) => {
      if (path === '/v1/rooms') return { items: [{ conversation_id: 'room_1', name: 'triage' }] };
      if (path === '/v1/mentions?limit=50') return { items: [{ conversation_id: 'room_1', message_id: 'msg_1' }] };
      throw new Error(`unexpected path ${path}`);
    },
    listRoomMessages: async (roomId, afterSeq, limit) => ({ items: [{ room_seq: '1' }], next_after_seq: '1', _args: [roomId, afterSeq, limit] }),
    sendEnvelope: async (envelope) => { sent.push(envelope); return { code: 'OK' }; },
  };
  const outbox = { queue: (envelope) => ({ envelope: { ...envelope, signature: { value: 'sig' } } }) };
  return { relay, outbox, sent };
}

test('listRooms returns relay items', async () => {
  const { relay, outbox } = fakes();
  const rooms = await createRoomsRuntime({ relay, outbox }).listRooms();
  assert.equal(rooms[0].conversation_id, 'room_1');
});

test('readRoom defaults to after_seq 0 and limit 50', async () => {
  const { relay, outbox } = fakes();
  const page = await createRoomsRuntime({ relay, outbox }).readRoom({ room_id: 'room_1' });
  assert.deepEqual(page._args, ['room_1', '0', 50]);
});

test('postMessage sends a signed room.message broadcast with a stable idempotency key', async () => {
  const { relay, outbox, sent } = fakes();
  const runtime = createRoomsRuntime({ relay, outbox, now: () => new Date('2026-10-09T12:00:00Z') });
  await runtime.postMessage({ room_id: 'room_1', text: 'hello', mentions: ['ep_codex'], idempotency_key: 'k1' });
  const envelope = sent[0];
  assert.equal(envelope.message_type, 'room.message');
  assert.equal(envelope.conversation_id, 'room_1');
  assert.deepEqual(envelope.broadcast_scope, { conversation_id: 'room_1' });
  assert.deepEqual(envelope.body, { text: 'hello', thread_root_id: null, mentions: ['ep_codex'] });
  assert.equal(envelope.idempotency_key, 'mcp_post_k1');
  assert.equal(envelope.signature.value, 'sig');
});

test('postMessage rejects empty text and text over 16000 characters', async () => {
  const { relay, outbox } = fakes();
  const runtime = createRoomsRuntime({ relay, outbox });
  await assert.rejects(runtime.postMessage({ room_id: 'room_1', text: '  ' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(runtime.postMessage({ room_id: 'room_1', text: 'x'.repeat(16001) }), { code: 'INVALID_REQUEST' });
});

test('dispatchTask sends a signed task.request broadcast bound to an assignee', async () => {
  const { relay, outbox, sent } = fakes();
  const runtime = createRoomsRuntime({ relay, outbox, now: () => new Date('2026-10-09T12:00:00Z') });
  await runtime.dispatchTask({
    room_id: 'room_1',
    task_id: 'task_1',
    instruction: 'review the diff',
    assignee: 'ep_codex',
    idempotency_key: 'k1',
    success_criteria: ['diff reviewed'],
  });
  const envelope = sent[0];
  assert.equal(envelope.message_type, 'task.request');
  assert.equal(envelope.conversation_id, 'room_1');
  assert.deepEqual(envelope.broadcast_scope, { conversation_id: 'room_1' });
  assert.deepEqual(envelope.body, {
    task_id: 'task_1',
    instruction: 'review the diff',
    assignee: 'ep_codex',
    thread_root_id: null,
    success_criteria: ['diff reviewed'],
  });
  assert.equal(envelope.idempotency_key, 'mcp_task_k1');
  assert.equal(envelope.signature.value, 'sig');
});

test('dispatchTask rejects a room task with no assignee', async () => {
  const { relay, outbox } = fakes();
  const runtime = createRoomsRuntime({ relay, outbox });
  await assert.rejects(runtime.dispatchTask({ room_id: 'room_1', task_id: 'task_1', instruction: 'review the diff' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(runtime.dispatchTask({ room_id: 'room_1', task_id: 'task_1', instruction: '  ', assignee: 'ep_codex' }), { code: 'INVALID_REQUEST' });
});

test('myMentions returns mention items for the caller', async () => {
  const { relay, outbox } = fakes();
  const items = await createRoomsRuntime({ relay, outbox }).myMentions();
  assert.deepEqual(items, [{ conversation_id: 'room_1', message_id: 'msg_1' }]);
});

test('myMentions rejects a limit outside 1 to 100', async () => {
  const { relay, outbox } = fakes();
  const runtime = createRoomsRuntime({ relay, outbox });
  await assert.rejects(runtime.myMentions({ limit: 0 }), { code: 'INVALID_REQUEST' });
  await assert.rejects(runtime.myMentions({ limit: 101 }), { code: 'INVALID_REQUEST' });
});
