import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { signedBytes } from './validate-envelope.mjs';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';

// Task 14: origin relay in `queue` federation mode enqueues a foreign-domain
// envelope to federation_outbox instead of forwarding synchronously.

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

const senderKeys = crypto.generateKeyPairSync('ed25519');
const relayIdentityKeys = crypto.generateKeyPairSync('ed25519');
const federationIdentity = {
  private_key_pem: relayIdentityKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  key_id: 'relay-a-key-1',
};

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
  const pool = new pg.Pool({ connectionString });
  const repository = new PostgresRepository({ pool });
  t.after(() => repository.close());

  // Schema reset and migration (hermetic test setup)
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  const sqlFiles = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of sqlFiles) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }

  // Register the peer (b.example) so decideRoute doesn't reject with PEER_NOT_PINNED
  const peerPubKey = relayIdentityKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  await repository.upsertPeer({
    domain: 'b.example',
    relayUrl: 'https://relay.b.example',
    keys: [{ kid: federationIdentity.key_id, alg: 'Ed25519', publicKey: peerPubKey }],
    trustMode: 'static'
  });

  // Test: first accept -> 202 queued:true, exactly one federation_outbox row
  await t.test('first accept enqueues -> 202 queued:true, one row', async () => {
      // Clean federation_outbox for hermetic subtest
      await pool.query('DELETE FROM federation_outbox');

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
      assert.equal(row.messageId, envelope.message_id);
      assert.equal(row.idempotencyKey, envelope.idempotency_key);
      assert.equal(row.recipientDomain, 'b.example');
      assert.equal(row.originDomain, 'a.example');
      assert.equal(row.senderOwnerId, 'usr_codex_owner');

      // I5: a successful enqueue is a success, not a rejection. The old
      // `eventType.endsWith('forwarded')` heuristic in recordFederationAudit
      // stamped `federation.queued` as outcome 'rejected'; it must now be an
      // explicit success outcome.
      const audit = await pool.query(
        `SELECT outcome FROM audit_events WHERE event_type = 'federation.queued' AND subject_id = $1`,
        [envelope.message_id]
      );
      assert.equal(audit.rowCount, 1, 'a federation.queued audit event is recorded');
      assert.notEqual(audit.rows[0].outcome, 'rejected', 'a successful enqueue must not be audited as rejected');
      assert.equal(audit.rows[0].outcome, 'accepted');
    });

    // Test: duplicate accept -> 202 queued:true, duplicate:true, still exactly one row (idempotent)
    await t.test('duplicate accept -> 202 queued:true, duplicate:true, still one row', async () => {
      // Clean federation_outbox for hermetic subtest
      await pool.query('DELETE FROM federation_outbox');

      const envelope = makeEnvelope({
        senderEndpointId: 'ep_codex@a.example',
        recipientEndpointId: 'ep_claude@b.example'
      });

      // First accept
      const result1 = await acceptEnvelopeAsync(envelope, {
        ...baseOptions(),
        repository,
      });
      assert.equal(result1.status, 202);
      assert.equal(result1.body.queued, true);
      assert.equal(result1.body.duplicate, false);

      // Verify one row after first accept
      let listResult = await repository.listFederationOutbox({ states: ['pending'] });
      assert.equal(listResult.counts.pending, 1, 'should have exactly one pending row after first accept');

      // Second accept with same message (duplicate)
      const result2 = await acceptEnvelopeAsync(envelope, {
        ...baseOptions(),
        repository,
      });
      assert.equal(result2.status, 202);
      assert.equal(result2.body.code, 'ACCEPTED');
      assert.equal(result2.body.queued, true);
      assert.equal(result2.body.duplicate, true);
      assert.equal(result2.body.request_id, 'req_fwd_1');

      // Verify still exactly one row (idempotent via unique constraint, no second insert)
      listResult = await repository.listFederationOutbox({ states: ['pending'] });
      assert.equal(listResult.counts.pending, 1, 'should have exactly one pending row after duplicate');
    });
});
