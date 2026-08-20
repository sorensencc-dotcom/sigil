import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

const row = (i) => ({
  message_id: `msg_stress_${i}`,
  envelope: {
    message_id: `msg_stress_${i}`,
    conversation_id: 'conv_stress',
    sender: { endpoint_id: 'ep_codex', owner_id: 'usr_soren' },
    recipient: { endpoint_id: 'ep_claude' },
    idempotency_key: `idem_stress_${i}`,
  },
  canonical_hash: `sha256:stress_${i}`,
});

test('memory repository sustains concurrent acceptance and acknowledgement without loss', async () => {
  const repository = createMemoryRepository();
  const rows = Array.from({ length: 100 }, (_, i) => row(i));
  const accepted = await Promise.all(rows.map((value) => repository.persistAcceptedEnvelope(value)));
  assert.equal(accepted.length, 100);
  assert.equal(new Set(accepted.map((value) => value.message_id)).size, 100);

  const inbox = await repository.listInbox('ep_claude');
  assert.equal(inbox.length, 100);
  const acknowledgements = await Promise.all(inbox.map((delivery) => repository.acknowledgeDelivery({
    deliveryId: delivery.delivery_id,
    endpointId: 'ep_claude',
    now: new Date('2026-08-20T00:00:00Z'),
  })));
  assert.equal(acknowledgements.length, 100);
  assert.equal((await repository.listInbox('ep_claude')).length, 0);
});

test('memory repository concurrent duplicate acknowledgement is idempotent', async () => {
  const repository = createMemoryRepository();
  await repository.persistAcceptedEnvelope(row(101));
  const [{ delivery_id: deliveryId }] = await repository.listInbox('ep_claude');
  const results = await Promise.all(Array.from({ length: 50 }, () => repository.acknowledgeDelivery({
    deliveryId,
    endpointId: 'ep_claude',
    now: new Date('2026-08-20T00:00:00Z'),
  })));
  assert.equal(results.filter((value) => value.duplicate).length, 49);
  assert.equal(results.filter((value) => !value.duplicate).length, 1);
});
