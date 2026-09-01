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

function fakeRepo({ withSenderKey = true } = {}) {
  const envelopes = new Map();
  const audits = [];
  return {
    envelopes,
    audits,
    persistCalled: false,
    async withTransaction(fn) { return fn({ id: 'client-1' }); },
    async lookupAcceptedMessageId() { return null; },
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
});
