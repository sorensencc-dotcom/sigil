import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, identityKeys } from '../../cli/identity.mjs';
import { validateEnvelope } from '../../relay/v1/validate-envelope.mjs';
import { buildTaskRequest, signTaskRequest } from './build-task-request.mjs';

const identity = createIdentity({ ownerId: 'usr_operator', endpointId: 'ep_ingress', kind: 'agent' });
const keys = identityKeys(identity);
const ingressEndpoint = {
  owner_id: identity.owner_id,
  endpoint_id: identity.endpoint_id,
  key_id: identity.key_id,
};
const provenance = {
  provider_event_id: 'evt_1',
  provider_message_id: 'msg_1',
  inbox_id: 'inbox_a',
  verified_sender: 'operator@example.test',
  workflow: 'trm',
  classification: 'internal',
  attachment_hashes: [],
  received_at: '2026-09-14T12:00:00Z',
};

function build(overrides = {}) {
  return buildTaskRequest({
    ingressEndpoint,
    ownerId: 'usr_operator',
    recipientEndpoint: { owner_id: 'usr_operator', endpoint_id: 'ep_triage' },
    taskId: 'task_1',
    conversationId: 'conv_1',
    instruction: 'Review the synthetic report.',
    contextRefs: [{ scope: 'scope:conversation/conv_1', sha256: 'a'.repeat(64) }],
    capabilities: [],
    provenance,
    idempotencyKey: 'agentmail:' + 'b'.repeat(64),
    createdAt: '2026-09-14T12:00:00Z',
    expiresAt: '2026-09-14T12:10:00Z',
    signer: { ...keys, keyId: identity.key_id },
    ...overrides,
  });
}

test('buildTaskRequest creates an ordinary signed Sigil task.request', () => {
  const envelope = build();
  assert.equal(envelope.protocol, 'sigil/1');
  assert.equal(envelope.message_type, 'task.request');
  assert.equal(envelope.sender.endpoint_id, 'ep_ingress');
  assert.equal(envelope.sender.owner_id, 'usr_operator');
  assert.equal(envelope.recipient.endpoint_id, 'ep_triage');
  assert.equal(envelope.body.task_id, 'task_1');
  assert.equal(envelope.body.instruction, 'Review the synthetic report.');
  assert.deepEqual(envelope.context_refs, [{ scope: 'scope:conversation/conv_1', sha256: 'a'.repeat(64) }]);
  assert.deepEqual(envelope.capabilities, []);
  assert.match(envelope.idempotency_key, /^agentmail:/);
  assert.deepEqual(envelope.signature.algorithm, 'Ed25519');
  assert.equal(envelope.signature.key_id, identity.key_id);
  const result = validateEnvelope(envelope, {
    now: new Date('2026-09-14T12:01:00Z'),
    registered: new Map([['ep_ingress', { ...ingressEndpoint, status: 'active', public_key: keys.publicKey }]]),
    capabilityGrants: [],
  });
  assert.equal(result.accepted, true);
});

test('signTaskRequest uses the existing unsigned-envelope signing convention', () => {
  const unsigned = build();
  delete unsigned.signature;
  const signed = signTaskRequest(unsigned, { ...keys, keyId: identity.key_id });
  assert.equal(signed.signature.algorithm, 'Ed25519');
  assert.equal(crypto.verify(null, Buffer.from(JSON.stringify({})), keys.publicKey, Buffer.alloc(0)), false);
  assert.equal(validateEnvelope(signed, {
    now: new Date('2026-09-14T12:01:00Z'),
    registered: new Map([['ep_ingress', { ...ingressEndpoint, status: 'active', public_key: keys.publicKey }]]),
  }).accepted, true);
});

test('builder rejects raw-body insertion and endpoint spoofing', () => {
  assert.throws(() => build({ rawBody: 'untrusted email body' }), { code: 'RAW_CONTENT_FORBIDDEN' });
  assert.throws(() => build({ ingressEndpoint: { ...ingressEndpoint, endpoint_id: 'ep_triage' } }), { code: 'ENDPOINT_SPOOFING' });
});

test('builder rejects missing recipient, blank instruction, and unsupported capabilities', () => {
  assert.throws(() => build({ recipientEndpoint: undefined }), { code: 'INVALID_ENVELOPE' });
  assert.throws(() => build({ instruction: '   ' }), { code: 'INVALID_ENVELOPE' });
  assert.throws(() => build({ capabilities: ['frontier.invoke'] }), { code: 'INVALID_ENVELOPE' });
  assert.throws(() => build({ recipientEndpoint: { owner_id: 'usr_operator', endpoint_id: 'ep_a' }, broadcastScope: {} }), { code: 'INVALID_ENVELOPE' });
});

test('builder rejects secret or raw content provenance fields', () => {
  assert.throws(() => build({ provenance: { ...provenance, raw_body: 'secret' } }), { code: 'RAW_CONTENT_FORBIDDEN' });
  assert.throws(() => build({ provenance: { ...provenance, forwarding_token: 'token' } }), { code: 'RAW_CONTENT_FORBIDDEN' });
});
