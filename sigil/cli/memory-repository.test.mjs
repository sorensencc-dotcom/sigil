import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryRepository } from './memory-repository.mjs';

test('memory relay does not redeliver acknowledged messages and replays acknowledgements', async () => {
  const repository = createMemoryRepository();
  await repository.persistAcceptedEnvelope({ message_id: 'msg_1', envelope: { recipient: { endpoint_id: 'ep_claude' } } });
  const first = await repository.listInbox('ep_claude');
  assert.equal(first.length, 1);
  const acknowledged = await repository.acknowledgeDelivery({ deliveryId: first[0].delivery_id, endpointId: 'ep_claude' });
  assert.equal(acknowledged.state, 'acknowledged');
  assert.deepEqual(await repository.listInbox('ep_claude'), []);
  assert.equal((await repository.acknowledgeDelivery({ deliveryId: first[0].delivery_id, endpointId: 'ep_claude' })).duplicate, true);
});
