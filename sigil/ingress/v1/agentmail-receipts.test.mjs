import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, identityKeys } from '../../cli/identity.mjs';
import { emitIngressReceipt } from './agentmail-receipts.mjs';
import { canonicalJsonBytes } from '../../relay/v1/jcs.mjs';

test('emitIngressReceipt creates a signed, redacted receipt', () => {
  const identity = createIdentity({ ownerId: 'usr_operator', endpointId: 'ep_ingress', kind: 'agent' });
  const keys = identityKeys(identity);
  const receipt = emitIngressReceipt({
    event: { eventId: 'evt_1', correlationId: 'corr_evt_1' },
    outcome: { state: 'rejected', rejectionCode: 'FINANCIAL_APPROVAL_REQUIRED' },
    signer: { ...keys, keyId: identity.key_id },
    createdAt: '2026-09-14T12:00:00Z',
  });
  assert.equal(receipt.protocol, 'sigil/1');
  assert.equal(receipt.correlation_id, 'corr_evt_1');
  assert.equal(receipt.rejection_code, 'FINANCIAL_APPROVAL_REQUIRED');
  assert.equal('body' in receipt, false);
  assert.equal(crypto.verify(null, canonicalJsonBytes({ ...receipt, signature: undefined }), keys.publicKey, Buffer.alloc(0)), false);
  assert.equal(receipt.signature.algorithm, 'Ed25519');
});
