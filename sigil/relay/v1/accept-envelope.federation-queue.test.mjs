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
// envelope to a federation relay job instead of forwarding synchronously.

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

  // Test: first accept -> 202 queued:true, exactly one federation relay job
  await t.test('first accept enqueues -> 202 queued:true, one row', async () => {
      // Clean relay_jobs for hermetic subtest
      await pool.query('DELETE FROM relay_jobs');

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

      // Verify exactly one federation relay job
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
      // Clean relay_jobs for hermetic subtest
      await pool.query('DELETE FROM relay_jobs');

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

    // Test: rollback-on-failure — outbox INSERT must be atomic with the txn
    // Guard for Blocker 1 (I1 review): confirms enqueueForward receives a real
    // txn client (not null), and that a post-enqueue failure rolls the INSERT back.
    await t.test('rollback-on-failure: outbox INSERT is atomic, rolled back on post-enqueue error', async () => {
      await pool.query('DELETE FROM relay_jobs');

      // Wrap repository to spy on enqueueFederationForward and capture its client arg,
      // then throw after the INSERT to force the transaction to roll back.
      const realEnqueue = repository.enqueueFederationForward.bind(repository);
      let capturedClient = undefined;
      let enqueueCallCount = 0;
      repository.enqueueFederationForward = async (args, client) => {
        capturedClient = client;
        enqueueCallCount++;
        await realEnqueue(args, client);
        // Throw after the INSERT but before commit to force rollback.
        throw Object.assign(new Error('injected post-enqueue failure'), { code: 'INJECTED_FAILURE' });
      };

      const envelope = makeEnvelope();
      const result = await acceptEnvelopeAsync(envelope, {
        ...baseOptions(),
        repository,
      });

      // The error propagates out as a server fault (no specific HTTP mapping for INJECTED_FAILURE)
      assert.equal(result.status, 400, 'unexpected error returns a non-2xx status');
      assert.equal(enqueueCallCount, 1, 'enqueue was attempted exactly once');

      // capturedClient must be a real pg client (has a query method), not null or the pool.
      // The pool object and a client both have .query, but a txn client is !== pool.
      assert.ok(capturedClient !== null, 'enqueueFederationForward must receive a non-null client');
      assert.ok(capturedClient !== pool, 'enqueueFederationForward must receive a txn client, not the pool directly');
      assert.ok(typeof capturedClient.query === 'function', 'client must have a .query method');

      // The INSERT was rolled back: relay_jobs must still be empty.
      const { rows } = await pool.query('SELECT COUNT(*)::int AS cnt FROM relay_jobs');
      assert.equal(rows[0].cnt, 0, 'outbox INSERT must be rolled back on post-enqueue failure');

      // Restore
      repository.enqueueFederationForward = realEnqueue;
    });
});

test('queue mode: an unregistered capability on a forwarded envelope is rejected with CAPABILITY_DENIED before it is enqueued', async () => {
  const enqueueCalls = [];
  const repository = {
    async withTransaction(fn) { return fn({ id: 'client-1' }); },
    async lookupAcceptedMessageId() { return null; },
    async getPeerByDomain(domain) { return domain === 'b.example' ? { domain: 'b.example', relayUrl: 'https://relay.b.example', wsUrl: null, keys: [], trustMode: 'pinned' } : null; },
    async lookupCapabilityRegistration() { return null; },
    async enqueueFederationForward(args) { enqueueCalls.push(args); return { row: { id: 'job_1' }, inserted: true }; },
    async recordAuditEvent() {},
  };
  const envelope = makeEnvelope();
  envelope.capabilities = ['sigil.task/submit'];
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), senderKeys.privateKey).toString('base64url');
  const result = await acceptEnvelopeAsync(envelope, {
    ...baseOptions(),
    repository,
    registered: new Map([['ep_codex@a.example', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_codex', public_key: senderKeys.publicKey }]]),
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'CAPABILITY_DENIED');
  assert.equal(enqueueCalls.length, 0, 'a rejected envelope must never be enqueued for federation forward');
});

test('queue mode: a high-risk capability on a forwarded envelope with no approval decision is rejected with APPROVAL_REQUIRED before it is enqueued', async () => {
  const enqueueCalls = [];
  const repository = {
    async withTransaction(fn) { return fn({ id: 'client-1' }); },
    async lookupAcceptedMessageId() { return null; },
    async getPeerByDomain(domain) { return domain === 'b.example' ? { domain: 'b.example', relayUrl: 'https://relay.b.example', wsUrl: null, keys: [], trustMode: 'pinned' } : null; },
    async lookupCapabilityRegistration(capability) { return { capability, risk_tier: 'high' }; },
    async enqueueFederationForward(args) { enqueueCalls.push(args); return { row: { id: 'job_1' }, inserted: true }; },
    async recordAuditEvent() {},
  };
  const envelope = makeEnvelope();
  envelope.capabilities = ['sigil.approval/request'];
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), senderKeys.privateKey).toString('base64url');
  const result = await acceptEnvelopeAsync(envelope, {
    ...baseOptions(),
    repository,
    registered: new Map([['ep_codex@a.example', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_codex', public_key: senderKeys.publicKey }]]),
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'APPROVAL_REQUIRED');
  assert.equal(enqueueCalls.length, 0);
});

test('queue mode: a high-risk capability WITH a matching approval decision, consumed on the transaction client, is enqueued', async () => {
  const enqueueCalls = [];
  const consumeCalls = [];
  const repository = {
    async withTransaction(fn) { return fn({ id: 'client-1' }); },
    async lookupAcceptedMessageId() { return null; },
    async getPeerByDomain(domain) { return domain === 'b.example' ? { domain: 'b.example', relayUrl: 'https://relay.b.example', wsUrl: null, keys: [], trustMode: 'pinned' } : null; },
    async lookupCapabilityRegistration(capability) { return { capability, risk_tier: 'high' }; },
    async consumeApprovalDecision(args) { consumeCalls.push(args); return { decision_id: 'dec_1' }; },
    async enqueueFederationForward(args) { enqueueCalls.push(args); return { row: { id: 'job_1' }, inserted: true }; },
    async recordAuditEvent() {},
  };
  const envelope = makeEnvelope();
  envelope.capabilities = ['sigil.approval/request'];
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), senderKeys.privateKey).toString('base64url');
  const result = await acceptEnvelopeAsync(envelope, {
    ...baseOptions(),
    repository,
    registered: new Map([['ep_codex@a.example', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_codex', public_key: senderKeys.publicKey }]]),
  });
  assert.equal(result.status, 202);
  assert.equal(result.body.queued, true);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(consumeCalls.length, 1);
  assert.deepEqual(consumeCalls[0].client, { id: 'client-1' }, 'the queue-forward path must consume the approval decision on the accept transaction client');
});
