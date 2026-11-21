import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { entryFromRegistryRow } from './trusted-endpoint.mjs';

const withKeys = (row) => ({ ...row, keys: entryFromRegistryRow(row).keys });
const NOW = new Date('2026-10-02T12:01:00.000Z');

// Statechart path (docs/specs/2026-11-21-sigil-ag-ui-projection-design.md §4):
// approve -> accept -> connection drops -> client retries the same envelope.
// A retry with the same idempotency_key and bytes must return the original
// acceptance, not APPROVAL_REQUIRED, because the approval was already used for it.
// Fails on main today (retry gets 403 APPROVAL_REQUIRED): the risk gate consumes
// the approval before the idempotency lookup can return the duplicate. Marked todo
// until spec step 1 lands; remove the todo flag in that change.
test('retrying an accepted high-risk envelope returns the original acceptance', { todo: 'spec step 1: idempotent high-risk retry' }, async () => {
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
  await repository.recordApprovalDecision({
    endpointId: 'ep_codex',
    actionHash: crypto.createHash('sha256').update(signedBytes(envelope)).digest('hex'),
    expiresAt: '2026-10-02T14:00:00.000Z',
    now: NOW,
  });
  const options = { repository, registered, now: NOW };

  const first = await acceptEnvelopeAsync(envelope, options);
  assert.equal(first.status, 202, JSON.stringify(first.body));

  const retry = await acceptEnvelopeAsync(envelope, options);
  assert.equal(retry.status, 202, `retry got ${retry.status} ${retry.body?.code}`);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.message_id, first.body.message_id);
});
