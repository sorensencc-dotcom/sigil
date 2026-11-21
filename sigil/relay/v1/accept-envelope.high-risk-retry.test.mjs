import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { entryFromRegistryRow } from './trusted-endpoint.mjs';

const withKeys = (row) => ({ ...row, keys: entryFromRegistryRow(row).keys });
const NOW = new Date('2026-10-02T12:01:00.000Z');

// A worker resends an accepted high-risk envelope after a timeout. The approval is
// single-use and already consumed, so the retry must return the original acceptance
// instead of APPROVAL_REQUIRED, and must not consume anything else.
async function approvedHighRiskWorld() {
  const keys = Object.fromEntries(['ep_codex', 'ep_claude'].map((id) => [id, crypto.generateKeyPairSync('ed25519')]));
  const registered = new Map(Object.entries(keys).map(([id, pair]) => [id, withKeys({ owner_id: 'usr_chris', status: 'active', key_id: `key_${id}`, public_key: pair.publicKey })]));
  const repository = createMemoryRepository({ registry: registered });
  const envelope = {
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: 'conv_1', message_type: 'chat.message',
    sender: { endpoint_id: 'ep_codex', owner_id: 'usr_chris' }, recipient: { endpoint_id: 'ep_claude', owner_id: 'usr_chris' },
    body: { text: 'gated action' }, context_refs: [], capabilities: ['sigil.approval/request'], correlation_id: null,
    idempotency_key: `idem_${crypto.randomUUID()}`, created_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-02T13:00:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: 'key_ep_codex', value: '' },
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.ep_codex.privateKey).toString('base64url');
  await repository.createCapabilityGrant({ grantId: 'grant_1', capability: 'sigil.approval/request', scope: 'scope:conversation/conv_1', grantedTo: 'ep_codex', expiresAt: '2026-10-03T00:00:00.000Z', now: NOW });
  const decision = await repository.recordApprovalDecision({
    endpointId: 'ep_codex',
    actionHash: crypto.createHash('sha256').update(signedBytes(envelope)).digest('hex'),
    expiresAt: '2026-10-02T14:00:00.000Z',
    now: NOW,
  });
  return { envelope, decision, options: { repository, registered, now: NOW } };
}

test('retrying an accepted high-risk envelope returns the original acceptance', async () => {
  const { envelope, decision, options } = await approvedHighRiskWorld();

  const first = await acceptEnvelopeAsync(envelope, options);
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.equal(decision.status, 'consumed');

  const retry = await acceptEnvelopeAsync(envelope, options);
  assert.equal(retry.status, 202, `retry got ${retry.status} ${retry.body?.code}`);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.message_id, first.body.message_id);
});

test('a retry with a forged signature is still rejected, not answered as a duplicate', async () => {
  const { envelope, options } = await approvedHighRiskWorld();
  assert.equal((await acceptEnvelopeAsync(envelope, options)).status, 202);

  const forged = { ...envelope, signature: { ...envelope.signature, value: Buffer.alloc(64, 1).toString('base64url') } };
  const retry = await acceptEnvelopeAsync(forged, options);
  assert.notEqual(retry.status, 202, 'a forged retry must not be treated as the original');
});

test('a changed body under the same idempotency key does not reuse the consumed approval', async () => {
  const { envelope, options } = await approvedHighRiskWorld();
  assert.equal((await acceptEnvelopeAsync(envelope, options)).status, 202);

  const changed = { ...envelope, message_id: `msg_${crypto.randomUUID()}`, body: { text: 'a different gated action' } };
  const retry = await acceptEnvelopeAsync(changed, options);
  assert.equal(retry.status, 403);
});
