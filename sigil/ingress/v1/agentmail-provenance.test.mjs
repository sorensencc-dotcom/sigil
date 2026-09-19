import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIngressProvenance, deriveIngressIdempotencyKey } from './agentmail-provenance.mjs';

test('deriveIngressIdempotencyKey is stable and nonblank', () => {
  const input = { providerEventId: 'evt_1', providerMessageId: 'msg_1', inboxId: 'inbox_a' };
  assert.equal(deriveIngressIdempotencyKey(input), deriveIngressIdempotencyKey({ ...input }));
  assert.match(deriveIngressIdempotencyKey(input), /^agentmail:[a-f0-9]{64}$/);
  assert.notEqual(deriveIngressIdempotencyKey(input), deriveIngressIdempotencyKey({ ...input, inboxId: 'inbox_b' }));
});

test('buildIngressProvenance keeps approved metadata and redacts bodies and credentials', () => {
  const provenance = buildIngressProvenance({
    providerEventId: 'evt_1',
    providerMessageId: 'msg_1',
    inboxId: 'inbox_a',
    verifiedSender: 'operator@example.test',
    workflow: 'trm',
    classification: 'internal',
    attachmentHashes: [{ sha256: 'a'.repeat(64), mediaType: 'text/plain', byteLength: 12 }],
    receivedAt: '2026-09-14T12:00:00Z',
    body: 'do not persist this body',
    apiKey: 'do not persist this key',
    forwardingToken: 'do not persist this token',
  });

  assert.deepEqual(provenance, {
    provider_event_id: 'evt_1',
    provider_message_id: 'msg_1',
    inbox_id: 'inbox_a',
    verified_sender: 'operator@example.test',
    workflow: 'trm',
    classification: 'internal',
    attachment_hashes: [{ sha256: 'a'.repeat(64), media_type: 'text/plain', byte_length: 12 }],
    received_at: '2026-09-14T12:00:00Z',
  });
  assert.equal('body' in provenance, false);
  assert.equal('apiKey' in provenance, false);
});

test('buildIngressProvenance rejects invalid attachment hashes', () => {
  assert.throws(() => buildIngressProvenance({
    providerEventId: 'evt_1',
    providerMessageId: 'msg_1',
    inboxId: 'inbox_a',
    verifiedSender: 'operator@example.test',
    workflow: 'trm',
    classification: 'internal',
    attachmentHashes: [{ sha256: 'not-a-hash', mediaType: 'text/plain', byteLength: 1 }],
    receivedAt: '2026-09-14T12:00:00Z',
  }), { code: 'INVALID_PROVENANCE' });
});
