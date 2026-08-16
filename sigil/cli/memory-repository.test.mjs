import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryRepository } from './memory-repository.mjs';

test('memory relay does not redeliver acknowledged messages and replays acknowledgements', async () => {
  const repository = createMemoryRepository();
  await repository.persistAcceptedEnvelope({ message_id: 'msg_1', canonical_hash: 'sha256:abc', envelope: { sender: { endpoint_id: 'ep_codex' }, recipient: { endpoint_id: 'ep_claude' }, idempotency_key: 'send_1' } });
  const first = await repository.listInbox('ep_claude');
  assert.equal(first.length, 1);
  const acknowledged = await repository.acknowledgeDelivery({ deliveryId: first[0].delivery_id, endpointId: 'ep_claude' });
  assert.equal(acknowledged.state, 'acknowledged');
  assert.deepEqual(await repository.listInbox('ep_claude'), []);
  assert.equal((await repository.acknowledgeDelivery({ deliveryId: first[0].delivery_id, endpointId: 'ep_claude' })).duplicate, true);
});

test('memory relay withTransaction runs the callback with a null client and returns its result', async () => {
  const repository = createMemoryRepository();
  const result = await repository.withTransaction(async (client) => { assert.equal(client, null); return 'ok'; });
  assert.equal(result, 'ok');
});

test('memory relay lookupTaskRequest finds an accepted task.request by conversation and task_id', async () => {
  const repository = createMemoryRepository();
  await repository.persistAcceptedEnvelope({
    message_id: 'msg_req_1', canonical_hash: 'sha256:abc',
    envelope: { message_id: 'msg_req_1', sender: { endpoint_id: 'ep_claude' }, message_type: 'task.request', conversation_id: 'conv_1', body: { task_id: 'task_1' }, idempotency_key: 'send_1' }
  });
  const found = await repository.lookupTaskRequest('task_1', 'conv_1');
  assert.deepEqual(found, { message_id: 'msg_req_1' });
  assert.equal(await repository.lookupTaskRequest('task_missing', 'conv_1'), null);
});

test('memory relay lookupIdempotency returns the stored canonical hash for a prior acceptance', async () => {
  const repository = createMemoryRepository();
  await repository.persistAcceptedEnvelope({
    message_id: 'msg_1', canonical_hash: 'sha256:abc',
    envelope: { sender: { endpoint_id: 'ep_codex' }, idempotency_key: 'send_1' }
  });
  assert.deepEqual(await repository.lookupIdempotency('ep_codex', 'send_1'), { message_id: 'msg_1', canonical_hash: 'sha256:abc' });
  assert.equal(await repository.lookupIdempotency('ep_codex', 'send_missing'), null);
});
