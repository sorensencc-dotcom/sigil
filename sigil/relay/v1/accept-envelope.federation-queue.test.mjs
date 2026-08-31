import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signedBytes } from './validate-envelope.mjs';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { PostgresRepository } from './postgres-repository.mjs';

// Task 14: origin relay in `queue` federation mode enqueues a foreign-domain
// envelope to federation_outbox instead of forwarding synchronously.

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

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

const baseOptions = () => ({
  relayDomain: 'a.example',
  federationMode: 'queue',
  federationIdentity,
  now: new Date('2026-08-30T12:00:30Z'),
  request_id: 'req_fwd_1',
  registered: new Map([['ep_codex@a.example', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_codex', public_key: senderKeys.publicKey }]]),
});

test('queue mode with live database', { skip: !connectionString }, async (t) => {
  const repository = new PostgresRepository({ connectionString });

  try {
    // Test: first accept -> 202 queued:true, exactly one federation_outbox row
    await t.test('first accept enqueues -> 202 queued:true, one row', async () => {
      const envelope = makeEnvelope();
      const result = await acceptEnvelopeAsync(envelope, {
        ...baseOptions(),
        repository,
      });

      assert.equal(result.status, 202);
      assert.equal(result.body.code, 'ACCEPTED');
      assert.equal(result.body.queued, true);
      assert.equal(result.body.duplicate, false);
      assert.equal(result.body.request_id, 'req_fwd_1');

      // Verify exactly one federation_outbox row
      const listResult = await repository.listFederationOutbox({ states: ['pending'] });
      assert.equal(listResult.counts.pending, 1, 'should have exactly one pending row');
      const row = listResult.rows[0];
      assert.equal(row.message_id, envelope.message_id);
      assert.equal(row.idempotency_key, envelope.idempotency_key);
      assert.equal(row.recipient_domain, 'b.example');
      assert.equal(row.origin_domain, 'a.example');
      assert.equal(row.sender_owner_id, 'usr_codex_owner');
    });

    // Test: second identical accept -> 202 queued:true, duplicate:true, still one row
    await t.test('duplicate accept -> 202 queued:true, duplicate:true, still one row', async () => {
      const envelope = makeEnvelope({
        senderEndpointId: 'ep_codex@a.example',
        recipientEndpointId: 'ep_claude@b.example'
      });
      const idempotencyKey = envelope.idempotency_key;
      const messageId = envelope.message_id;

      // First accept
      const result1 = await acceptEnvelopeAsync(envelope, {
        ...baseOptions(),
        repository,
      });
      assert.equal(result1.status, 202);
      assert.equal(result1.body.queued, true);
      assert.equal(result1.body.duplicate, false);

      // Verify one row
      let listResult = await repository.listFederationOutbox({ states: ['pending'] });
      const countBefore = listResult.counts.pending;

      // Second accept with same message
      const result2 = await acceptEnvelopeAsync(envelope, {
        ...baseOptions(),
        repository,
      });
      assert.equal(result2.status, 202);
      assert.equal(result2.body.code, 'ACCEPTED');
      assert.equal(result2.body.queued, true);
      assert.equal(result2.body.duplicate, true);
      assert.equal(result2.body.request_id, 'req_fwd_1');

      // Verify still exactly one row (or same count as before)
      listResult = await repository.listFederationOutbox({ states: ['pending'] });
      assert.equal(listResult.counts.pending, countBefore, 'should still have same number of rows after duplicate');
    });
  } finally {
    await repository.close();
  }
});
