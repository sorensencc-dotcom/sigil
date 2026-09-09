import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';

const NOW = new Date('2026-09-09T12:01:00.000Z');

function makeEnvelope(privateKey, body = {}) {
  const envelope = {
    protocol: 'sigil/1',
    message_id: `msg_${crypto.randomUUID()}`,
    conversation_id: 'conv_resend',
    message_type: 'session.resend_request',
    sender: { endpoint_id: 'ep_requester', owner_id: 'usr_requester', kind: 'agent' },
    recipient: { endpoint_id: 'ep_requester', owner_id: 'usr_requester', kind: 'agent' },
    body: {
      target_sender_endpoint_id: 'ep_sender',
      conversation_id: 'conv_resend',
      begin_seq: 3,
      end_seq: 0,
      ...body,
    },
    context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: `resend_${crypto.randomUUID()}`,
    created_at: '2026-09-09T12:00:00.000Z',
    expires_at: '2026-09-09T13:00:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: 'key_requester', value: '' },
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  return envelope;
}

function resendRepository({ member = true, highWater = 7n, priorMessage = null } = {}) {
  const calls = { audit: [], enqueue: [], rate: [], persisted: 0, membership: 0 };
  return {
    calls,
    async withTransaction(fn) { return fn({ id: 'resend-client' }); },
    async lookupAcceptedMessageId() { return priorMessage; },
    async lookupRecipientEndpoint() { return { status: 'active', owner_id: 'usr_requester' }; },
    async lookupActiveCapabilityGrants() { return []; },
    async lookupCapabilityRegistration() { return null; },
    async reserveRateLimit(scopeKind, scopeId) { calls.rate.push({ scopeKind, scopeId }); return { count: 1, allowed: true }; },
    async countOpenDeliveries() { throw new Error('resend request must not inspect inbox delivery depth'); },
    async isConversationMember() { calls.membership += 1; return member; },
    async lookupStreamHighWater() { return highWater; },
    async enqueueRelayJob(jobType, row) { calls.enqueue.push({ jobType, row }); return { inserted: true, row: { id: 'job_resend_1' } }; },
    async recordAuditEvent(event) { calls.audit.push(event); return event; },
    async persistAcceptedEnvelope() { calls.persisted += 1; throw new Error('resend request must not create an envelope or delivery'); },
  };
}

function options(keys, repository) {
  return {
    repository,
    registered: new Map([['ep_requester', {
      endpoint_id: 'ep_requester', owner_id: 'usr_requester', status: 'active',
      key_id: 'key_requester', public_key: keys.publicKey,
    }]]),
    now: NOW,
  };
}

test('accepts a signed active-member resend request as one bounded async job without delivery or fan-out', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const repository = resendRepository({ highWater: 7n });
  const envelope = makeEnvelope(keys.privateKey);

  const result = await acceptEnvelopeAsync(envelope, options(keys, repository));

  assert.equal(result.status, 202);
  assert.equal(repository.calls.membership, 1);
  assert.deepEqual(repository.calls.rate.map((entry) => entry.scopeKind), ['endpoint', 'owner', 'conversation']);
  assert.equal(repository.calls.enqueue.length, 1);
  assert.equal(repository.calls.enqueue[0].jobType, 'resend');
  assert.deepEqual(repository.calls.enqueue[0].row.payload, {
    requester_endpoint_id: 'ep_requester', target_sender_endpoint_id: 'ep_sender',
    conversation_id: 'conv_resend', begin_seq: 3, end_seq: 7,
  });
  assert.equal(repository.calls.persisted, 0);
  assert.equal(repository.calls.audit[0].eventType, 'session.resend_request');
  assert.equal(repository.calls.audit[0].conversationId, 'conv_resend');
});

test('rejects a signed request from an inactive conversation member without queueing', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const repository = resendRepository({ member: false });
  const result = await acceptEnvelopeAsync(makeEnvelope(keys.privateKey, { end_seq: 3 }), options(keys, repository));
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'CAPABILITY_DENIED');
  assert.equal(repository.calls.enqueue.length, 0);
});

test('rejects a resend range above the 500-message cap without queueing', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const repository = resendRepository({ highWater: 1_000n });
  const result = await acceptEnvelopeAsync(makeEnvelope(keys.privateKey, { begin_seq: 1, end_seq: 501 }), options(keys, repository));
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'INVALID_ENVELOPE');
  assert.deepEqual(result.body.details, { field: 'end_seq', reason: 'range too wide' });
  assert.equal(repository.calls.enqueue.length, 0);
});

test('rejects a resend body scoped to a different conversation without queueing', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const repository = resendRepository();
  const result = await acceptEnvelopeAsync(makeEnvelope(keys.privateKey, { conversation_id: 'conv_other', end_seq: 3 }), options(keys, repository));
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'INVALID_ENVELOPE');
  assert.deepEqual(result.body.details, { field: 'conversation_id', reason: 'must match envelope conversation_id' });
  assert.equal(repository.calls.enqueue.length, 0);
});

test('rejects an invalid resend signature before membership or queue side effects', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const repository = resendRepository();
  const envelope = makeEnvelope(keys.privateKey);
  envelope.body.begin_seq = 4;
  const result = await acceptEnvelopeAsync(envelope, options(keys, repository));
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'INVALID_SIGNATURE');
  assert.equal(repository.calls.membership, 0);
  assert.equal(repository.calls.enqueue.length, 0);
});

test('rejects an expired resend request before membership or queue side effects', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const repository = resendRepository();
  const envelope = makeEnvelope(keys.privateKey);
  envelope.expires_at = '2026-09-09T12:00:30.000Z';
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.privateKey).toString('base64url');

  const result = await acceptEnvelopeAsync(envelope, options(keys, repository));

  assert.equal(result.status, 422);
  assert.equal(result.body.code, 'MESSAGE_EXPIRED');
  assert.equal(repository.calls.membership, 0);
  assert.equal(repository.calls.enqueue.length, 0);
});

test('rejects a resend request reusing a message id under a different idempotency key', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const repository = resendRepository({ priorMessage: { idempotency_key: 'resend_original' } });
  const result = await acceptEnvelopeAsync(makeEnvelope(keys.privateKey), options(keys, repository));

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'REPLAY_DETECTED');
  assert.equal(repository.calls.membership, 0);
  assert.equal(repository.calls.enqueue.length, 0);
});
