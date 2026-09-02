import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signedBytes } from './validate-envelope.mjs';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';

// Task 11: origin relay in `sync` federation mode forwards a foreign-domain
// envelope to its pinned peer instead of rejecting it with RECIPIENT_NOT_LOCAL.

const senderKeys = crypto.generateKeyPairSync('ed25519');
const relayIdentityKeys = crypto.generateKeyPairSync('ed25519');
const federationIdentity = {
  private_key_pem: relayIdentityKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  key_id: 'relay-a-key-1',
};

const PEER_B = { domain: 'b.example', relayUrl: 'https://relay.b.example', wsUrl: null, keys: [], trustMode: 'pinned' };

function makeEnvelope({ senderEndpointId = 'ep_codex@a.example', recipientEndpointId = 'ep_claude@b.example' } = {}) {
  const envelope = {
    protocol: 'sigil/1',
    message_id: `msg_${crypto.randomUUID()}`,
    conversation_id: 'conv_fed_1',
    message_type: 'chat.message',
    sender: { endpoint_id: senderEndpointId, owner_id: 'usr_codex_owner' },
    recipient: { endpoint_id: recipientEndpointId, owner_id: 'usr_remote_owner' },
    body: { text: 'hello across the relay boundary' },
    context_refs: [],
    capabilities: [],
    correlation_id: null,
    idempotency_key: `send_${crypto.randomUUID()}`,
    created_at: '2026-08-30T12:00:00Z',
    expires_at: '2026-08-30T13:00:00Z',
    signature: { algorithm: 'Ed25519', key_id: 'key_codex', value: '' },
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), senderKeys.privateKey).toString('base64url');
  return envelope;
}

function fakeRepo({ withSenderKey = true, priorMessage = null } = {}) {
  const envelopes = new Map();
  const audits = [];
  return {
    envelopes,
    audits,
    persistCalled: false,
    withTransactionCallCount: 0,
    async withTransaction(fn) { this.withTransactionCallCount++; return fn({ id: 'client-1' }); },
    async lookupAcceptedMessageId() { return priorMessage; },
    async getPeerByDomain(domain) { return domain === 'b.example' ? PEER_B : null; },
    async lookupRecipientEndpoint() { return null; },
    async recordAuditEvent(event) { audits.push(event); },
    async persistAcceptedEnvelope(row) { this.persistCalled = true; envelopes.set(row.envelope.message_id, row); return { message_id: row.envelope.message_id, duplicate: false }; },
    _debugGetEnvelope(id) { return envelopes.get(id) ?? null; },
  };
}

const baseOptions = () => ({
  relayDomain: 'a.example',
  federationMode: 'sync',
  federationIdentity,
  now: new Date('2026-08-30T12:00:30Z'),
  request_id: 'req_fwd_1',
  registered: new Map([['ep_codex@a.example', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_codex', public_key: senderKeys.publicKey }]]),
});


test('sync mode: peer accepts the forward -> 202 forwarded, nothing persisted locally', async () => {
  const repository = fakeRepo();
  const envelope = makeEnvelope();
  const result = await acceptEnvelopeAsync(envelope, {
    ...baseOptions(),
    repository,
    postForwardImpl: async () => ({ ok: true, status: 202 }),
  });
  assert.equal(result.status, 202);
  assert.equal(result.body.code, 'ACCEPTED');
  assert.equal(result.body.forwarded, true);
  assert.equal(result.body.forwarded_to, 'b.example');
  assert.equal(result.body.request_id, 'req_fwd_1');
  assert.equal(repository.persistCalled, false);
  assert.equal(repository._debugGetEnvelope(envelope.message_id), null);
  assert.equal(repository.audits.at(-1).eventType, 'federation.forwarded');
  assert.equal(repository.withTransactionCallCount, 0, 'sync forward must not open a Postgres transaction');
});

test('sync mode: peer rejects the forward -> 502 FORWARD_REJECTED with peer status/code', async () => {
  const repository = fakeRepo();
  const result = await acceptEnvelopeAsync(makeEnvelope(), {
    ...baseOptions(),
    repository,
    postForwardImpl: async () => ({ ok: false, status: 403, peerCode: 'DIRECTORY_LINK_REQUIRED' }),
  });
  assert.equal(result.status, 502);
  assert.equal(result.body.code, 'FORWARD_REJECTED');
  assert.equal(result.body.details.peerStatus, 403);
  assert.equal(result.body.details.peerCode, 'DIRECTORY_LINK_REQUIRED');
  assert.equal(repository.persistCalled, false);
  assert.equal(repository.audits.at(-1).eventType, 'federation.forward_rejected');
  assert.equal(repository.withTransactionCallCount, 0, 'sync forward must not open a Postgres transaction');
});

test('sync mode: transport failure -> 504 FORWARD_UNAVAILABLE', async () => {
  const repository = fakeRepo();
  const result = await acceptEnvelopeAsync(makeEnvelope(), {
    ...baseOptions(),
    repository,
    postForwardImpl: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'FORWARD_TRANSPORT_FAILED' }); },
  });
  assert.equal(result.status, 504);
  assert.equal(result.body.code, 'FORWARD_UNAVAILABLE');
  assert.equal(result.body.details.recipientDomain, 'b.example');
  assert.equal(repository.persistCalled, false);
  assert.equal(repository.audits.at(-1).eventType, 'federation.forward_unavailable');
  assert.equal(repository.withTransactionCallCount, 0, 'sync forward must not open a Postgres transaction');
});

test('sync mode: authenticated local sender with no registered key -> 500 FORWARD_MISCONFIGURED', async () => {
  const repository = fakeRepo();
  let posted = false;
  const result = await acceptEnvelopeAsync(makeEnvelope(), {
    ...baseOptions(),
    repository,
    registered: new Map(),
    postForwardImpl: async () => { posted = true; return { ok: true, status: 202 }; },
  });
  assert.equal(result.status, 500);
  assert.equal(result.body.code, 'FORWARD_MISCONFIGURED');
  assert.equal(posted, false);
  assert.equal(repository.persistCalled, false);
  assert.equal(repository.withTransactionCallCount, 0, 'sync forward must not open a Postgres transaction');
});

test('sync mode: sender absent from registered does not call lookupRecipientEndpoint with a null client (S1)', async () => {
  // postgres-repository.lookupRecipientEndpoint hard-throws a bare Error when
  // called without a transaction client. On the Phase 1 sync-forward path the
  // client is null, so forwardEnvelope must not fall back to it; an
  // unresolvable sender should surface as 500 FORWARD_MISCONFIGURED, not a
  // codeless Error mapped to 400 INVALID_ENVELOPE.
  const repository = fakeRepo();
  let lookupClientArg = 'not-called';
  repository.lookupRecipientEndpoint = async (_id, client) => {
    lookupClientArg = client;
    if (!client) throw new Error('Recipient lookup requires a transaction client');
    return null;
  };
  const result = await acceptEnvelopeAsync(makeEnvelope(), {
    ...baseOptions(),
    repository,
    registered: new Map(), // sender not resolvable from the trusted directory
    postForwardImpl: async () => ({ ok: true, status: 202 }),
  });
  assert.equal(result.status, 500);
  assert.equal(result.body.code, 'FORWARD_MISCONFIGURED');
  assert.equal(lookupClientArg, 'not-called', 'lookupRecipientEndpoint must not be invoked on the null-client sync path');
  assert.equal(repository.withTransactionCallCount, 0, 'sync forward must not open a Postgres transaction');
});

test('sync mode: REPLAY_DETECTED for a reused message_id on a foreign recipient, no transaction opened', async () => {
  // Seed lookupAcceptedMessageId to return a prior accepted record under a
  // *different* idempotency_key -- simulates a local sender that previously
  // sent this message_id to a local recipient and now retries to a foreign one.
  const envelope = makeEnvelope();
  const priorMessage = { message_id: envelope.message_id, idempotency_key: 'idem_prior_different' };
  const repository = fakeRepo({ priorMessage });
  const result = await acceptEnvelopeAsync(envelope, {
    ...baseOptions(),
    repository,
    postForwardImpl: async () => { throw new Error('should not be called'); },
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'REPLAY_DETECTED');
  assert.equal(repository.withTransactionCallCount, 0, 'replay rejection on sync forward path must not open a transaction');
  // REPLAY_DETECTED is an AUDITED_REJECTION_CODE: the sync forward path must
  // still emit the rejection audit, matching the local and queue paths.
  const auditEvent = repository.audits.at(-1);
  assert.equal(auditEvent?.eventType, 'envelope.rejected.replay_detected');
  assert.equal(auditEvent?.outcome, 'rejected');
  assert.equal(auditEvent?.subjectId, envelope.message_id);
});

test('sync mode: reject route (PEER_NOT_PINNED) takes priority over replay check when decideRoute returns reject', async () => {
  // Behavior locked by I1 refactor: decideRoute now runs before lookupAcceptedMessageId
  // in the reject-route short-circuit. An envelope bound for an unpinned peer that also
  // has a reused message_id returns PEER_NOT_PINNED (400), not REPLAY_DETECTED (409).
  // Pre-refactor this returned REPLAY_DETECTED because lookupAcceptedMessageId ran first.
  // The new ordering is more correct (route validity gates replay detection), but it is
  // a visible status change from the prior behavior.
  const envelope = makeEnvelope({ recipientEndpointId: 'ep_claude@c.example' }); // c.example not in peers
  const priorMessage = { message_id: envelope.message_id, idempotency_key: 'idem_prior_different' };
  const repository = fakeRepo({ priorMessage });
  const result = await acceptEnvelopeAsync(envelope, {
    ...baseOptions(),
    repository,
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'PEER_NOT_PINNED');
  assert.equal(repository.withTransactionCallCount, 0, 'reject route must not open a transaction');
});
