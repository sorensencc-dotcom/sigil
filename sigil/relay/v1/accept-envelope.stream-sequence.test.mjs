import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { acceptFederatedEnvelope } from './accept-federated-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { buildForwardRequest, signForwardRequest } from './federation-router.mjs';
import { canonicalJsonBytes } from './jcs.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

function signEnvelope(envelope, privateKey) {
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  return envelope;
}

function makeLocalEnvelope(privateKey, overrides = {}) {
  return signEnvelope({
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: 'conv_stream',
    message_type: 'chat.message', sender: { endpoint_id: 'ep_sender', owner_id: 'usr_sender' },
    recipient: { endpoint_id: 'ep_recipient', owner_id: 'usr_recipient' },
    body: { text: 'stream me' }, context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: `send_${crypto.randomUUID()}`,
    created_at: '2026-09-09T12:00:00.000Z', expires_at: '2026-09-09T13:00:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: 'key_sender', value: '' },
    ...overrides,
  }, privateKey);
}

function localRepository(sequence = 41n) {
  const persisted = [];
  const calls = [];
  return {
    persisted,
    calls,
    async withTransaction(fn) { return fn({ id: 'stream-client' }); },
    async lookupAcceptedMessageId() { return null; },
    async lookupIdempotency() { return null; },
    async lookupCapabilityRegistration(capability) { return { capability }; },
    async lookupActiveCapabilityGrants() { return []; },
    async reserveRateLimit() { return { count: 1, allowed: true }; },
    async countOpenDeliveries() { return 0; },
    async assignStreamSequence(client, senderEndpointId, conversationId) {
      calls.push({ client, senderEndpointId, conversationId });
      return sequence;
    },
    async persistAcceptedEnvelope(row) {
      persisted.push(row);
      return { message_id: row.envelope.message_id, delivery_id: 'del_stream', duplicate: false };
    },
  };
}

function localOptions(keys, repository, streamSeqEnabled) {
  return {
    repository,
    registered: new Map([['ep_sender', { owner_id: 'usr_sender', status: 'active', key_id: 'key_sender', public_key: keys.publicKey }]]),
    now: new Date('2026-09-09T12:01:00.000Z'),
    stream_seq: { enabled: streamSeqEnabled },
  };
}

test('disabled stream sequences persist NULL and skip sequence assignment', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const repository = localRepository();
  repository.assignStreamSequence = async () => { throw new Error('disabled stream sequence must not be assigned'); };
  const result = await acceptEnvelopeAsync(makeLocalEnvelope(keys.privateKey), localOptions(keys, repository, false));
  assert.equal(result.status, 202);
  assert.equal(repository.persisted.length, 1);
  assert.equal(repository.persisted[0].streamSeq, null);
});

test('enabled local conversational messages persist their transaction-assigned sequence', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const repository = localRepository(41n);
  const result = await acceptEnvelopeAsync(makeLocalEnvelope(keys.privateKey), localOptions(keys, repository, true));
  assert.equal(result.status, 202);
  assert.deepEqual(repository.calls, [{ client: { id: 'stream-client' }, senderEndpointId: 'ep_sender', conversationId: 'conv_stream' }]);
  assert.equal(repository.persisted[0].streamSeq, 41n);
});

test('enabled local broadcast messages persist their transaction-assigned sequence', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const repository = localRepository(42n);
  const envelope = makeLocalEnvelope(keys.privateKey, {
    recipient: undefined,
    broadcast_scope: { conversation_id: 'conv_stream' },
    capabilities: [],
  });
  const result = await acceptEnvelopeAsync(envelope, {
    ...localOptions(keys, repository, true),
    broadcastAuthorizer: () => true,
  });
  assert.equal(result.status, 202);
  assert.equal(repository.persisted[0].streamSeq, 42n);
});

test('enabled in-memory relay accepts messages and projects a JSON-safe inbox streamSeq', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const envelope = makeLocalEnvelope(keys.privateKey, {
    recipient: { endpoint_id: 'ep_recipient', owner_id: 'usr_sender' },
  });
  const registered = new Map([
    ['ep_sender', { owner_id: 'usr_sender', status: 'active', key_id: 'key_sender', public_key: keys.publicKey }],
    ['ep_recipient', { owner_id: 'usr_sender', status: 'active', key_id: 'key_recipient', public_key: keys.publicKey }],
  ]);
  const repository = createMemoryRepository({ registry: registered });
  const result = await acceptEnvelopeAsync(envelope, {
    repository, registered, now: new Date('2026-09-09T12:01:00.000Z'), stream_seq: { enabled: true },
  });
  assert.equal(result.status, 202);
  const [inbox] = await repository.listInbox('ep_recipient');
  assert.equal(inbox.streamSeq, '1');
});

function federatedWorld() {
  const origin = 'origin.example';
  const relay = 'receiver.example';
  const relayKeys = crypto.generateKeyPairSync('ed25519');
  const senderKeys = crypto.generateKeyPairSync('ed25519');
  const recipientKeys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([[`ep_recipient@${relay}`, {
    endpoint_id: `ep_recipient@${relay}`, owner_id: 'usr_receiver@receiver.example', key_id: 'key_recipient',
    status: 'active', public_key: recipientKeys.publicKey,
  }]]);
  const repository = createMemoryRepository({ registry: registered });
  const relayIdentity = { key_id: 'relay-origin', private_key_pem: relayKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const relayPublicKey = relayKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const senderPublicKey = senderKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  repository.upsertPeer({ domain: origin, relayUrl: 'https://origin.example/relay', keys: [{ kid: relayIdentity.key_id, alg: 'Ed25519', publicKey: relayPublicKey }], trustMode: 'tofu' });
  return { origin, relay, relayIdentity, senderKeys, senderPublicKey, repository, registered };
}

test('federated accepts persist NULL even when stream sequences are enabled', async () => {
  const world = federatedWorld();
  const envelope = signEnvelope({
    protocol: 'sigil/1', message_id: 'msg_federated_stream', conversation_id: 'conv_federated_stream', message_type: 'chat.message',
    sender: { owner_id: 'usr_sender@origin.example', endpoint_id: `ep_sender@${world.origin}`, kind: 'agent' },
    recipient: { owner_id: 'usr_receiver@receiver.example', endpoint_id: `ep_recipient@${world.relay}`, kind: 'agent' },
    body: { text: 'federated' }, context_refs: [], capabilities: [], idempotency_key: 'idem_federated_stream',
    created_at: '2026-09-09T12:00:00.000Z', expires_at: '2026-09-09T12:10:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: `key_ep_sender@${world.origin}`, value: '' },
  }, world.senderKeys.privateKey);
  const { body } = buildForwardRequest(envelope, {
    originDomain: world.origin,
    senderKey: { kid: envelope.signature.key_id, alg: 'Ed25519', publicKey: world.senderPublicKey },
    senderOwnerId: envelope.sender.owner_id,
    now: new Date('2026-09-09T12:00:05.000Z'),
    nonce: 'abcdefghijklmnopqrstuv',
  });
  const signed = signForwardRequest(canonicalJsonBytes(body), world.relayIdentity);
  const originalPersist = world.repository.persistAcceptedEnvelope.bind(world.repository);
  let persistedRow;
  world.repository.persistAcceptedEnvelope = async (row, client) => {
    persistedRow = row;
    return originalPersist(row, client);
  };
  world.repository.assignStreamSequence = async () => { throw new Error('federated envelopes must not be sequenced'); };
  await world.repository.createFederationDirectoryLink({
    linkRef: crypto.randomUUID(), localOwnerId: envelope.recipient.owner_id, localEndpointId: envelope.recipient.endpoint_id,
    remoteOwnerId: envelope.sender.owner_id, remoteEndpointId: envelope.sender.endpoint_id, remoteDomain: world.origin,
    role: 'issuer', initiatedVia: 'test', status: 'active', localConfirmedAt: new Date(), remoteConfirmedAt: new Date(),
    sourceInviteId: null, peerDomain: world.origin,
  }, null);
  const result = await acceptFederatedEnvelope(body, { 'sigil-relay-signature': signed.signature, 'sigil-relay-key-id': signed.keyId }, {
    repository: world.repository, registered: world.registered, relayDomain: world.relay, request_id: 'req_federated_stream',
    now: new Date('2026-09-09T12:00:30.000Z'), stream_seq: { enabled: true },
  });
  assert.equal(result.status, 202);
  assert.equal(persistedRow.streamSeq, null);
});
