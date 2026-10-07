import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

test('memory repository throws IDEMPOTENCY_RACE on a duplicate key instead of overwriting', async () => {
  const repository = createMemoryRepository();
  const envelope = (messageId) => ({
    message_id: messageId, conversation_id: 'conv_1', message_type: 'chat.message',
    sender: { endpoint_id: 'ep_a', owner_id: 'own_a', kind: 'human' }, recipient: { endpoint_id: 'ep_b', owner_id: 'own_b' },
    idempotency_key: 'k1', created_at: '2026-10-06T00:00:00Z', expires_at: '2026-10-07T00:00:00Z', body: { text: 'x' },
  });
  await repository.persistAcceptedEnvelope({ envelope: envelope('msg_1'), message_id: 'msg_1', canonical_hash: 'h1' });
  await assert.rejects(
    repository.persistAcceptedEnvelope({ envelope: envelope('msg_2'), message_id: 'msg_2', canonical_hash: 'h2' }),
    (error) => error.code === 'IDEMPOTENCY_RACE',
  );
  assert.equal((await repository.lookupIdempotency('ep_a', 'k1')).message_id, 'msg_1', 'first message is kept');
});
