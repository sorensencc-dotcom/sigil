import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

function envelopeFixture(overrides = {}) {
  return {
    protocol: 'sigil/1', message_id: 'msg_hop_1', conversation_id: 'conv_1', message_type: 'chat.message',
    sender: { owner_id: 'usr_chris@primary.example', endpoint_id: 'ep_codex@a.example', kind: 'agent' },
    recipient: { owner_id: 'usr_chris@primary.example', endpoint_id: 'ep_claude@b.example', kind: 'agent' },
    body: { text: 'hi' }, context_refs: [], capabilities: [], idempotency_key: 'idem_1',
    created_at: '2026-08-30T12:00:00.000Z', expires_at: '2026-08-30T12:10:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: 'key_ep_codex@a.example', value: 'AA' },
    ...overrides,
  };
}

test('persistAcceptedEnvelope stores federation_hop on the envelope record and delivery rows', async () => {
  const repo = createMemoryRepository({ registry: new Map() });
  const envelope = envelopeFixture();
  await repo.persistAcceptedEnvelope({ envelope, canonical_hash: 'h', message_id: envelope.message_id, federation_hop: true });
  const inbox = await repo.listInbox('ep_claude@b.example', '');
  assert.equal(inbox.length, 1);
  const stored = repo._debugGetEnvelope ? repo._debugGetEnvelope(envelope.message_id) : null;
  if (stored) assert.equal(stored.federation_hop, true);
});

test('persistAcceptedEnvelope defaults federation_hop to false', async () => {
  const repo = createMemoryRepository({ registry: new Map() });
  const envelope = envelopeFixture({ message_id: 'msg_hop_2', idempotency_key: 'idem_2' });
  const stored = await repo.persistAcceptedEnvelope({ envelope, canonical_hash: 'h', message_id: envelope.message_id });
  assert.equal(stored.duplicate, false);
});
