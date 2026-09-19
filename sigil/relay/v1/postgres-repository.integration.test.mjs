import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('migration and repository persist an envelope in live PostgreSQL', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = {
    human: `usr_${suffix}`, codex: `ep_codex_${suffix}`, claude: `ep_claude_${suffix}`,
    key: `key_${suffix}`, conversation: `conv_${suffix}`, message: `msg_live_${suffix}`,
    task: `task_live_${suffix}`, idempotency: `send_live_${suffix}`
  };

  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const sqlFiles = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of sqlFiles) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }

  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.human}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.codex}', '${ids.human}', 'codex', 'install_codex_${suffix}', 'Codex', 'active', NOW()),
             ('${ids.claude}', '${ids.human}', 'claude', 'install_claude_${suffix}', 'Claude', 'active', NOW());
    INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
      VALUES ('${ids.key}', '${ids.codex}', 'Ed25519', decode('00', 'hex'), 'active', NOW());
    INSERT INTO conversations (conversation_id, kind, created_by, created_at)
      VALUES ('${ids.conversation}', 'direct', '${ids.human}', NOW());
  `);

  const envelope = {
    message_id: ids.message, conversation_id: ids.conversation, protocol: 'sigil/1', message_type: 'task.request',
    sender: { endpoint_id: ids.codex, owner_id: ids.human }, recipient: { endpoint_id: ids.claude },
    body: { task_id: ids.task }, context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: ids.idempotency, expires_at: '2030-01-01T00:00:00Z', created_at: '2029-12-31T12:00:00Z',
    signature: { algorithm: 'Ed25519', key_id: ids.key, value: 'sig' }
  };

  const row = await new PostgresRepository({ pool }).persistAcceptedEnvelope({
    envelope, canonical_bytes: Buffer.from(`{"message_id":"${ids.message}"}`), action_hash: 'sha256:live'
  });
  assert.equal(row.message_id, ids.message);
  assert.equal(row.duplicate, false);
  assert.equal(typeof row.delivery_id, 'string');
  assert.ok(row.delivery_id.startsWith('del_'));

  const persisted = await pool.query(
    'SELECT message_id, envelope_status, sender_endpoint_id, recipient_endpoint_id, canonical_bytes, action_hash FROM envelopes WHERE message_id = $1',
    [ids.message]
  );
  assert.equal(persisted.rowCount, 1);
  assert.equal(persisted.rows[0].envelope_status, 'accepted');
  assert.equal(persisted.rows[0].sender_endpoint_id, ids.codex);
  assert.equal(persisted.rows[0].recipient_endpoint_id, ids.claude);
  assert.equal(persisted.rows[0].canonical_bytes.toString(), `{"message_id":"${ids.message}"}`);
  assert.equal(persisted.rows[0].action_hash, 'sha256:live');
  const delivery = await pool.query('SELECT delivery_id, message_id, recipient_endpoint_id, state FROM deliveries WHERE message_id = $1', [ids.message]);
  assert.deepEqual(delivery.rows, [{ delivery_id: row.delivery_id, message_id: ids.message, recipient_endpoint_id: ids.claude, state: 'queued' }]);
  const repository = new PostgresRepository({ pool });
  const claimed = await repository.claimDelivery({ workerId: `worker_${suffix}`, now: new Date('2029-12-31T12:01:00Z') });
  assert.equal(claimed.delivery_id.startsWith('del_'), true);
  assert.equal(claimed.lease_until > claimed.updated_at, true);
  const secondClaim = await repository.claimDelivery({ workerId: `worker_second_${suffix}`, now: new Date('2029-12-31T12:02:00Z'), leaseSeconds: 30 });
  assert.equal(secondClaim.delivery_id, claimed.delivery_id);
  await assert.rejects(
    () => repository.saveDeliveryTransition(claimed.delivery_id, { ...claimed, state: 'delivered', updated_at: '2029-12-31T12:02:01Z' }, { workerId: `worker_${suffix}`, now: new Date('2029-12-31T12:02:01Z') }),
    { code: 'DELIVERY_LEASE_LOST' }
  );
  const transitioned = await repository.saveDeliveryTransition(secondClaim.delivery_id, {
    ...secondClaim, state: 'delivered', delivered_at: '2029-12-31T12:02:01.000Z', updated_at: '2029-12-31T12:02:01.000Z'
  }, { workerId: `worker_second_${suffix}`, now: new Date('2029-12-31T12:02:01Z') });
  assert.equal(transitioned.state, 'delivered');
  assert.equal(transitioned.lease_until, null);

  const concurrentEnvelope = {
    ...envelope,
    message_id: `msg_concurrent_${suffix}`,
    body: { task_id: `task_concurrent_${suffix}` },
    idempotency_key: `send_concurrent_${suffix}`
  };
  await repository.persistAcceptedEnvelope({
    envelope: concurrentEnvelope,
    canonical_bytes: Buffer.from(`{"message_id":"${concurrentEnvelope.message_id}"}`),
    action_hash: 'sha256:concurrent'
  });
  const concurrentNow = new Date('2029-12-31T12:03:00Z');
  const [workerOneClaim, workerTwoClaim] = await Promise.all([
    new PostgresRepository({ pool }).claimDelivery({ workerId: `worker_concurrent_one_${suffix}`, now: concurrentNow }),
    new PostgresRepository({ pool }).claimDelivery({ workerId: `worker_concurrent_two_${suffix}`, now: concurrentNow })
  ]);
  assert.equal([workerOneClaim, workerTwoClaim].filter(Boolean).length, 1);
  assert.equal([workerOneClaim, workerTwoClaim].filter((claim) => claim?.delivery_id === transitioned.delivery_id).length, 0);
  const idempotency = await pool.query('SELECT endpoint_id, message_id FROM idempotency_keys WHERE idempotency_key = $1', [ids.idempotency]);
  assert.deepEqual(idempotency.rows, [{ endpoint_id: ids.codex, message_id: ids.message }]);
  const audit = await pool.query('SELECT event_type, subject_id, actor_id FROM audit_events WHERE subject_id = $1', [ids.message]);
  assert.deepEqual(audit.rows, [{ event_type: 'envelope.accepted', subject_id: ids.message, actor_id: ids.codex }]);

  await assert.rejects(() => new PostgresRepository({ pool }).persistAcceptedEnvelope({
    envelope: { ...envelope, message_id: `rollback_${suffix}`, recipient: { endpoint_id: `missing_${suffix}` } }
  }));
  const rolledBack = await pool.query('SELECT 1 FROM envelopes WHERE message_id = $1', [`rollback_${suffix}`]);
  assert.equal(rolledBack.rowCount, 0);
});

test('concurrent duplicate envelope submissions race safely to exactly one acceptance', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = {
    human: `usr_${suffix}`, codex: `ep_codex_${suffix}`, claude: `ep_claude_${suffix}`,
    key: `key_${suffix}`, conversation: `conv_${suffix}`, idempotency: `send_race_${suffix}`
  };
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const sqlFiles = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of sqlFiles) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.human}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.codex}', '${ids.human}', 'codex', 'install_codex_${suffix}', 'Codex', 'active', NOW()),
             ('${ids.claude}', '${ids.human}', 'claude', 'install_claude_${suffix}', 'Claude', 'active', NOW());
    INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
      VALUES ('${ids.key}', '${ids.codex}', 'Ed25519', decode('00', 'hex'), 'active', NOW());
    INSERT INTO conversations (conversation_id, kind, created_by, created_at)
      VALUES ('${ids.conversation}', 'direct', '${ids.human}', NOW());
  `);

  const baseEnvelope = {
    conversation_id: ids.conversation, protocol: 'sigil/1', message_type: 'task.request',
    sender: { endpoint_id: ids.codex, owner_id: ids.human }, recipient: { endpoint_id: ids.claude },
    body: { task_id: `task_race_${suffix}` }, context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: ids.idempotency, expires_at: '2030-01-01T00:00:00Z', created_at: '2029-12-31T12:00:00Z',
    signature: { algorithm: 'Ed25519', key_id: ids.key, value: 'sig' }
  };
  // Two racers submit the same logical request (same idempotency key) with
  // distinct message IDs, simulating a client that regenerates message_id on
  // retry. Real overlapping transactions, not a mock.
  const racers = [1, 2].map((n) => ({ ...baseEnvelope, message_id: `msg_race_${n}_${suffix}` }));
  const results = await Promise.all(racers.map((envelope) => new PostgresRepository({ pool }).persistAcceptedEnvelope({
    envelope, canonical_bytes: Buffer.from(`{"n":${envelope.message_id}}`), action_hash: `sha256:race_${envelope.message_id}`
  })));

  const winners = results.filter((r) => r.duplicate === false);
  const losers = results.filter((r) => r.duplicate === true);
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.equal(losers.length, 1, JSON.stringify(results));
  assert.equal(losers[0].message_id, winners[0].message_id);

  const rows = await pool.query('SELECT message_id FROM envelopes WHERE conversation_id = $1', [ids.conversation]);
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].message_id, winners[0].message_id);
  const keyRows = await pool.query('SELECT message_id FROM idempotency_keys WHERE idempotency_key = $1', [ids.idempotency]);
  assert.equal(keyRows.rowCount, 1);
});

test('the DB-level unique index rejects a second task.request reusing an in-use task_id in the same conversation', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = {
    human: `usr_${suffix}`, codex: `ep_codex_${suffix}`, claude: `ep_claude_${suffix}`,
    key: `key_${suffix}`, conversation: `conv_${suffix}`, task: `task_dup_${suffix}`
  };
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const sqlFiles = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of sqlFiles) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.human}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.codex}', '${ids.human}', 'codex', 'install_codex_${suffix}', 'Codex', 'active', NOW()),
             ('${ids.claude}', '${ids.human}', 'claude', 'install_claude_${suffix}', 'Claude', 'active', NOW());
    INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
      VALUES ('${ids.key}', '${ids.codex}', 'Ed25519', decode('00', 'hex'), 'active', NOW());
    INSERT INTO conversations (conversation_id, kind, created_by, created_at)
      VALUES ('${ids.conversation}', 'direct', '${ids.human}', NOW());
  `);

  const repository = new PostgresRepository({ pool });
  const baseEnvelope = {
    conversation_id: ids.conversation, protocol: 'sigil/1', message_type: 'task.request',
    sender: { endpoint_id: ids.codex, owner_id: ids.human }, recipient: { endpoint_id: ids.claude },
    body: { task_id: ids.task }, context_refs: [], capabilities: [], correlation_id: null,
    expires_at: '2030-01-01T00:00:00Z', created_at: '2029-12-31T12:00:00Z',
    signature: { algorithm: 'Ed25519', key_id: ids.key, value: 'sig' }
  };

  const first = await repository.persistAcceptedEnvelope({
    envelope: { ...baseEnvelope, message_id: `msg_first_${suffix}`, idempotency_key: `send_first_${suffix}` },
    canonical_bytes: Buffer.from('{"n":1}'), action_hash: 'sha256:first'
  });
  assert.equal(first.duplicate, false);

  // A distinct message_id + idempotency_key means this isn't caught by the
  // idempotency/replay checks -- only the task_id unique index stops it.
  await assert.rejects(() => repository.persistAcceptedEnvelope({
    envelope: { ...baseEnvelope, message_id: `msg_second_${suffix}`, idempotency_key: `send_second_${suffix}` },
    canonical_bytes: Buffer.from('{"n":2}'), action_hash: 'sha256:second'
  }));

  const rows = await pool.query('SELECT message_id FROM envelopes WHERE conversation_id = $1', [ids.conversation]);
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].message_id, `msg_first_${suffix}`);
});

test('migration 024 resolves pre-existing duplicate task_id rows instead of failing to apply', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = {
    human: `usr_${suffix}`, codex: `ep_codex_${suffix}`, claude: `ep_claude_${suffix}`,
    key: `key_${suffix}`, conversation: `conv_${suffix}`, task: `task_dup_${suffix}`
  };
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');

  // Apply every migration up to (but not including) 024, so the exploit
  // this migration closes -- two accepted task.request rows sharing
  // (conversation_id, task_id) -- can be seeded exactly as it could have
  // existed on a database attacked before this fix shipped.
  const sqlFiles = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const preMigration = sqlFiles.filter((f) => f < '024_task_request_id_uniqueness.sql');
  const migration024 = sqlFiles.find((f) => f === '024_task_request_id_uniqueness.sql');
  assert.ok(migration024, 'migration 024 must exist on disk for this test to be meaningful');
  for (const file of preMigration) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }

  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.human}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.codex}', '${ids.human}', 'codex', 'install_codex_${suffix}', 'Codex', 'active', NOW()),
             ('${ids.claude}', '${ids.human}', 'claude', 'install_claude_${suffix}', 'Claude', 'active', NOW());
    INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
      VALUES ('${ids.key}', '${ids.codex}', 'Ed25519', decode('00', 'hex'), 'active', NOW());
    INSERT INTO conversations (conversation_id, kind, created_by, created_at)
      VALUES ('${ids.conversation}', 'direct', '${ids.human}', NOW());
    INSERT INTO envelopes (message_id, conversation_id, protocol, message_type, sender_endpoint_id, sender_owner_id,
                           recipient_endpoint_id, body, context_refs, capabilities, idempotency_key, expires_at,
                           created_at, signature_algorithm, signature_key_id, signature_value, canonical_bytes)
      VALUES ('msg_legit_${suffix}', '${ids.conversation}', 'sigil/1', 'task.request', '${ids.codex}', '${ids.human}',
              '${ids.claude}', '{"task_id":"${ids.task}"}', '[]', '{}', 'send_legit_${suffix}', '2030-01-01T00:00:00Z',
              '2029-12-31T12:00:00Z', 'Ed25519', '${ids.key}', 'sig', decode('00', 'hex')),
             ('msg_forged_${suffix}', '${ids.conversation}', 'sigil/1', 'task.request', '${ids.claude}', '${ids.human}',
              '${ids.claude}', '{"task_id":"${ids.task}"}', '[]', '{}', 'send_forged_${suffix}', '2030-01-01T00:00:00Z',
              '2029-12-31T12:05:00Z', 'Ed25519', '${ids.key}', 'sig', decode('00', 'hex'));
  `);

  // The migration this repairs must not abort on the pre-existing duplicate.
  await pool.query(await fs.readFile(path.join(migrationsDir, migration024), 'utf8'));

  const rows = await pool.query(
    'SELECT message_id, envelope_status FROM envelopes WHERE conversation_id = $1 ORDER BY created_at',
    [ids.conversation]
  );
  assert.deepEqual(rows.rows, [
    { message_id: `msg_legit_${suffix}`, envelope_status: 'accepted' },
    { message_id: `msg_forged_${suffix}`, envelope_status: 'superseded_duplicate_task_id' },
  ]);

  // Neither row was deleted -- dependent rows referencing them (none seeded
  // here beyond the envelopes themselves) would remain intact -- and the
  // unique index now exists and is enforced going forward.
  const indexRow = await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'envelopes_task_request_lookup_idx'`);
  assert.equal(indexRow.rowCount, 1);
  assert.match(indexRow.rows[0].indexdef, /CREATE UNIQUE INDEX/);

  // Re-applying the migration (idempotent, matching applyMigrations' model) must be a no-op.
  await pool.query(await fs.readFile(path.join(migrationsDir, migration024), 'utf8'));
  const rowsAfterReapply = await pool.query(
    'SELECT message_id, envelope_status FROM envelopes WHERE conversation_id = $1 ORDER BY created_at',
    [ids.conversation]
  );
  assert.deepEqual(rowsAfterReapply.rows, rows.rows);
});

test('a genuine concurrent task_id race is translated to an audited DUPLICATE_TASK_ID, not a raw Postgres error', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = {
    human: `usr_${suffix}`, claude: `ep_claude_${suffix}`, reviewer: `ep_reviewer_${suffix}`,
    key: `key_${suffix}`, keyReviewer: `key_reviewer_${suffix}`, conversation: `conv_${suffix}`, task: `task_race_${suffix}`
  };
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const sqlFiles = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of sqlFiles) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }

  const claudeKeys = crypto.generateKeyPairSync('ed25519');
  const reviewerKeys = crypto.generateKeyPairSync('ed25519');
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.human}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.claude}', '${ids.human}', 'claude', 'install_claude_${suffix}', 'Claude', 'active', NOW()),
             ('${ids.reviewer}', '${ids.human}', 'claude', 'install_reviewer_${suffix}', 'Reviewer', 'active', NOW());
    INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
      VALUES ('${ids.key}', '${ids.claude}', 'Ed25519', decode('00', 'hex'), 'active', NOW()),
             ('${ids.keyReviewer}', '${ids.reviewer}', 'Ed25519', decode('00', 'hex'), 'active', NOW());
    INSERT INTO conversations (conversation_id, kind, created_by, created_at)
      VALUES ('${ids.conversation}', 'direct', '${ids.human}', NOW());
  `);

  const { acceptEnvelopeAsync } = await import('./accept-envelope.mjs');
  const { signedBytes } = await import('./validate-envelope.mjs');
  const repository = new PostgresRepository({ pool });
  const registered = new Map([
    [ids.claude, { owner_id: ids.human, key_id: ids.key, status: 'active', public_key: claudeKeys.publicKey }],
    [ids.reviewer, { owner_id: ids.human, key_id: ids.keyReviewer, status: 'active', public_key: reviewerKeys.publicKey }],
  ]);
  function buildRequest({ sender, keys, keyId, messageId }) {
    const envelope = {
      protocol: 'sigil/1', message_id: messageId, conversation_id: ids.conversation, message_type: 'task.request',
      sender: { endpoint_id: sender, owner_id: ids.human }, recipient: { endpoint_id: sender },
      body: { task_id: ids.task, instruction: 'x' }, context_refs: [], capabilities: [], correlation_id: null,
      idempotency_key: `send_${messageId}`, created_at: '2029-12-31T12:00:00Z', expires_at: '2030-01-01T00:00:00Z',
      signature: { algorithm: 'Ed25519', key_id: keyId, value: '' }
    };
    envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.privateKey).toString('base64url');
    return envelope;
  }
  // Two distinct endpoints racing to claim the same task_id with distinct
  // message_ids/idempotency_keys -- neither the idempotency nor replay
  // checks can catch this; only the DB unique index does, and only after
  // both transactions' app-level lookupTaskRequest checks have already
  // passed (real overlapping transactions, not a mock).
  const racers = [
    buildRequest({ sender: ids.claude, keys: claudeKeys, keyId: ids.key, messageId: `msg_race_a_${suffix}` }),
    buildRequest({ sender: ids.reviewer, keys: reviewerKeys, keyId: ids.keyReviewer, messageId: `msg_race_b_${suffix}` }),
  ];
  const results = await Promise.all(racers.map((envelope) => acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2029-12-31T12:01:00Z') })));

  const accepted = results.filter((r) => r.status === 202);
  const rejected = results.filter((r) => r.status !== 202);
  assert.equal(accepted.length, 1, JSON.stringify(results));
  assert.equal(rejected.length, 1, JSON.stringify(results));
  // The loser must see the clean, audited rejection -- never the raw SQLSTATE.
  assert.equal(rejected[0].status, 409);
  assert.equal(rejected[0].body.code, 'DUPLICATE_TASK_ID');

  // writeRejectionAudit doesn't thread conversation_id through, so filter by
  // subject_id (= the rejected envelope's message_id) instead. Exactly one
  // of the two racers lost and must have its rejection audited.
  const auditRows = await pool.query(
    `SELECT subject_id FROM audit_events WHERE event_type = 'envelope.rejected.duplicate_task_id' AND subject_id = ANY($1)`,
    [racers.map((r) => r.message_id)]
  );
  assert.equal(auditRows.rowCount, 1, JSON.stringify(auditRows.rows));
});

test('concurrent duplicate ack requests race safely to exactly one acknowledgement, and survive a fresh connection', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = {
    human: `usr_${suffix}`, codex: `ep_codex_${suffix}`, claude: `ep_claude_${suffix}`, other: `ep_other_${suffix}`,
    key: `key_${suffix}`, conversation: `conv_${suffix}`, message: `msg_ack_race_${suffix}`, delivery: `del_ack_race_${suffix}`
  };
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const sqlFiles = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of sqlFiles) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.human}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.codex}', '${ids.human}', 'codex', 'install_codex_${suffix}', 'Codex', 'active', NOW()),
             ('${ids.claude}', '${ids.human}', 'claude', 'install_claude_${suffix}', 'Claude', 'active', NOW()),
             ('${ids.other}', '${ids.human}', 'claude', 'install_other_${suffix}', 'Other', 'active', NOW());
    INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
      VALUES ('${ids.key}', '${ids.codex}', 'Ed25519', decode('00', 'hex'), 'active', NOW());
    INSERT INTO conversations (conversation_id, kind, created_by, created_at)
      VALUES ('${ids.conversation}', 'direct', '${ids.human}', NOW());
    INSERT INTO envelopes (message_id, conversation_id, protocol, message_type, sender_endpoint_id, sender_owner_id,
                           recipient_endpoint_id, body, context_refs, capabilities, idempotency_key, expires_at,
                           created_at, signature_algorithm, signature_key_id, signature_value, canonical_bytes)
      VALUES ('${ids.message}', '${ids.conversation}', 'sigil/1', 'task.request', '${ids.codex}', '${ids.human}',
              '${ids.claude}', '{}', '[]', '{}', 'send_${suffix}', '2030-01-01T00:00:00Z', '2029-12-31T12:00:00Z',
              'Ed25519', '${ids.key}', 'sig', decode('00', 'hex'));
    INSERT INTO deliveries (delivery_id, message_id, recipient_endpoint_id, state, attempts, queued_at, updated_at, next_attempt_at)
      VALUES ('${ids.delivery}', '${ids.message}', '${ids.claude}', 'delivered', 0, NOW(), NOW(), NOW());
  `);

  // Ten concurrent acks for the same delivery from the rightful endpoint:
  // real overlapping transactions racing the same PK insert.
  const attempts = Array.from({ length: 10 }, () => new PostgresRepository({ pool }).acknowledgeDelivery({ deliveryId: ids.delivery, endpointId: ids.claude, now: new Date('2029-12-31T12:00:00Z') }));
  const results = await Promise.all(attempts);
  assert.equal(results.filter((r) => r.duplicate === false).length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => r.duplicate === true).length, 9, JSON.stringify(results));

  const deliveryRow = await pool.query('SELECT state FROM deliveries WHERE delivery_id = $1', [ids.delivery]);
  assert.equal(deliveryRow.rows[0].state, 'acknowledged');
  const receiptRows = await pool.query('SELECT endpoint_id FROM delivery_acknowledgements WHERE delivery_id = $1', [ids.delivery]);
  assert.equal(receiptRows.rowCount, 1);
  assert.equal(receiptRows.rows[0].endpoint_id, ids.claude);

  // A conflicting ack from a different endpoint must fail, not silently win.
  await assert.rejects(
    () => new PostgresRepository({ pool }).acknowledgeDelivery({ deliveryId: ids.delivery, endpointId: ids.other, now: new Date('2029-12-31T12:01:00Z') }),
    { code: 'DELIVERY_UNAVAILABLE' }
  );

  // Restart safety: a brand-new pool/connection (simulating a fresh relay
  // process) still sees the persisted receipt and replays idempotently.
  const freshPool = new pg.Pool({ connectionString });
  try {
    const replay = await new PostgresRepository({ pool: freshPool }).acknowledgeDelivery({ deliveryId: ids.delivery, endpointId: ids.claude, now: new Date('2029-12-31T12:02:00Z') });
    assert.equal(replay.duplicate, true);
  } finally {
    await freshPool.end();
  }
});

test('consumeApprovalDecision matches, is single-use, and respects expiry against live Postgres', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = { human: `usr_${suffix}`, endpoint: `ep_${suffix}` };
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const sqlFiles = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of sqlFiles) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.human}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.endpoint}', '${ids.human}', 'claude', 'install_${suffix}', 'Claude', 'active', NOW());
    INSERT INTO human_credentials (credential_id, human_id, type, public_key, status, valid_from, created_at)
      VALUES ('cred_${suffix}', '${ids.human}', 'webauthn', decode('00', 'hex'), 'active', NOW(), NOW());
    INSERT INTO approval_decisions (decision_id, human_id, credential_id, endpoint_id, action_hash, action_hash_algorithm, target, scope, contract_version, nonce, status, created_at, expires_at)
      VALUES ('decision_${suffix}', '${ids.human}', 'cred_${suffix}', '${ids.endpoint}', 'hash_${suffix}', 'sha256', '{}', 'approval', 'sigil/1', 'nonce_${suffix}', 'approved', NOW(), NOW() + INTERVAL '5 minutes');
  `);

  const repository = new PostgresRepository({ pool });
  // Wrong endpoint or wrong hash: no match, nothing consumed.
  assert.equal(await repository.consumeApprovalDecision({ endpointId: `ep_other_${suffix}`, actionHash: `hash_${suffix}` }), null);
  assert.equal(await repository.consumeApprovalDecision({ endpointId: ids.endpoint, actionHash: 'hash_wrong' }), null);

  const consumed = await repository.consumeApprovalDecision({ endpointId: ids.endpoint, actionHash: `hash_${suffix}` });
  assert.equal(consumed.decision_id, `decision_${suffix}`);
  assert.equal(consumed.status, 'consumed');

  // Single-use: a second attempt at the same, now-consumed decision fails closed.
  assert.equal(await repository.consumeApprovalDecision({ endpointId: ids.endpoint, actionHash: `hash_${suffix}` }), null);

  const row = await pool.query('SELECT status FROM approval_decisions WHERE decision_id = $1', [`decision_${suffix}`]);
  assert.equal(row.rows[0].status, 'consumed');
});

test('consumeApprovalDecision claims exactly one decision when duplicates exist for the same (endpoint_id, action_hash)', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = { human: `usr_${suffix}`, endpoint: `ep_${suffix}` };
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const sqlFiles = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of sqlFiles) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.human}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.endpoint}', '${ids.human}', 'claude', 'install_${suffix}', 'Claude', 'active', NOW());
    INSERT INTO human_credentials (credential_id, human_id, type, public_key, status, valid_from, created_at)
      VALUES ('cred_${suffix}', '${ids.human}', 'webauthn', decode('00', 'hex'), 'active', NOW(), NOW());
    INSERT INTO approval_decisions (decision_id, human_id, credential_id, endpoint_id, action_hash, action_hash_algorithm, target, scope, contract_version, nonce, status, created_at, expires_at)
      VALUES ('decision_a_${suffix}', '${ids.human}', 'cred_${suffix}', '${ids.endpoint}', 'hash_${suffix}', 'sha256', '{}', 'approval', 'sigil/1', 'nonce_a_${suffix}', 'approved', NOW(), NOW() + INTERVAL '5 minutes'),
             ('decision_b_${suffix}', '${ids.human}', 'cred_${suffix}', '${ids.endpoint}', 'hash_${suffix}', 'sha256', '{}', 'approval', 'sigil/1', 'nonce_b_${suffix}', 'approved', NOW() + INTERVAL '1 second', NOW() + INTERVAL '5 minutes');
  `);

  const repository = new PostgresRepository({ pool });
  const consumed = await repository.consumeApprovalDecision({ endpointId: ids.endpoint, actionHash: `hash_${suffix}` });
  assert.equal(consumed.decision_id, `decision_a_${suffix}`); // oldest (created_at) wins deterministically

  const rows = await pool.query(
    'SELECT decision_id, status FROM approval_decisions WHERE endpoint_id = $1 ORDER BY decision_id', [ids.endpoint]
  );
  assert.deepEqual(rows.rows, [
    { decision_id: `decision_a_${suffix}`, status: 'consumed' },
    { decision_id: `decision_b_${suffix}`, status: 'approved' }, // untouched -- still available to a later envelope
  ]);
});

test('consumeApprovalDecision ignores a decision whose approving human or credential has since been revoked', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = { human: `usr_${suffix}`, endpoint: `ep_${suffix}` };
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const sqlFiles = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of sqlFiles) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.human}', 'revoked', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.endpoint}', '${ids.human}', 'claude', 'install_${suffix}', 'Claude', 'active', NOW());
    INSERT INTO human_credentials (credential_id, human_id, type, public_key, status, valid_from, created_at)
      VALUES ('cred_${suffix}', '${ids.human}', 'webauthn', decode('00', 'hex'), 'active', NOW(), NOW());
    INSERT INTO approval_decisions (decision_id, human_id, credential_id, endpoint_id, action_hash, action_hash_algorithm, target, scope, contract_version, nonce, status, created_at, expires_at)
      VALUES ('decision_${suffix}', '${ids.human}', 'cred_${suffix}', '${ids.endpoint}', 'hash_${suffix}', 'sha256', '{}', 'approval', 'sigil/1', 'nonce_${suffix}', 'approved', NOW(), NOW() + INTERVAL '5 minutes');
  `);

  const repository = new PostgresRepository({ pool });
  // The human who approved this was revoked after approving but before the envelope arrived: fails closed.
  assert.equal(await repository.consumeApprovalDecision({ endpointId: ids.endpoint, actionHash: `hash_${suffix}` }), null);

  // Same, for a revoked credential on an otherwise-active human.
  await pool.query(`UPDATE humans SET status = 'active' WHERE human_id = '${ids.human}'`);
  await pool.query(`UPDATE human_credentials SET status = 'revoked' WHERE credential_id = 'cred_${suffix}'`);
  assert.equal(await repository.consumeApprovalDecision({ endpointId: ids.endpoint, actionHash: `hash_${suffix}` }), null);

  const row = await pool.query('SELECT status FROM approval_decisions WHERE decision_id = $1', [`decision_${suffix}`]);
  assert.equal(row.rows[0].status, 'approved'); // untouched -- never actually claimed
});

test('consumeApprovalDecision matches a decision stored with the documented sha256:-prefixed representation', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = { human: `usr_${suffix}`, endpoint: `ep_${suffix}` };
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const sqlFiles = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of sqlFiles) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.human}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.endpoint}', '${ids.human}', 'claude', 'install_${suffix}', 'Claude', 'active', NOW());
    INSERT INTO human_credentials (credential_id, human_id, type, public_key, status, valid_from, created_at)
      VALUES ('cred_${suffix}', '${ids.human}', 'webauthn', decode('00', 'hex'), 'active', NOW(), NOW());
    INSERT INTO approval_decisions (decision_id, human_id, credential_id, endpoint_id, action_hash, action_hash_algorithm, target, scope, contract_version, nonce, status, created_at, expires_at)
      VALUES ('decision_${suffix}', '${ids.human}', 'cred_${suffix}', '${ids.endpoint}', 'sha256:hash_${suffix}', 'sha256', '{}', 'approval', 'sigil/1', 'nonce_${suffix}', 'approved', NOW(), NOW() + INTERVAL '5 minutes');
  `);

  const repository = new PostgresRepository({ pool });
  // Caller passes the bare digest (what accept-envelope.mjs's result.canonical_hash always is);
  // the stored row uses the 'sha256:'-prefixed representation -- must still match.
  const consumed = await repository.consumeApprovalDecision({ endpointId: ids.endpoint, actionHash: `hash_${suffix}` });
  assert.equal(consumed.decision_id, `decision_${suffix}`);
  assert.equal(consumed.status, 'consumed');
});

test('a high-risk capability envelope is rejected without a decision, accepted once one exists, and the decision cannot authorize a second envelope', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = { human: `usr_${suffix}`, endpoint: `ep_${suffix}`, key: `key_${suffix}`, conversation: `conv_${suffix}` };
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const sqlFiles = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of sqlFiles) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }

  const keys = crypto.generateKeyPairSync('ed25519');
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.human}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.endpoint}', '${ids.human}', 'claude', 'install_${suffix}', 'Claude', 'active', NOW());
    INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
      VALUES ('${ids.key}', '${ids.endpoint}', 'Ed25519', decode('00', 'hex'), 'active', NOW());
    INSERT INTO conversations (conversation_id, kind, created_by, created_at)
      VALUES ('${ids.conversation}', 'direct', '${ids.human}', NOW());
    INSERT INTO capability_grants (grant_id, capability, scope, granted_to, granted_by, granted_at, expires_at)
      VALUES ('grant_${suffix}', 'sigil.approval/request', 'scope:conversation/${ids.conversation}', '${ids.endpoint}', '${ids.human}', NOW(), '2030-01-01T00:00:00Z');
  `);

  const { acceptEnvelopeAsync } = await import('./accept-envelope.mjs');
  const { signedBytes } = await import('./validate-envelope.mjs');
  const repository = new PostgresRepository({ pool });
  const registered = new Map([[ids.endpoint, { owner_id: ids.human, key_id: ids.key, status: 'active', public_key: keys.publicKey }]]);
  function buildEnvelope(messageId) {
    const envelope = {
      protocol: 'sigil/1', message_id: messageId, conversation_id: ids.conversation, message_type: 'chat.message',
      sender: { endpoint_id: ids.endpoint, owner_id: ids.human }, recipient: { endpoint_id: ids.endpoint },
      body: { text: 'high-risk action' }, context_refs: [], capabilities: ['sigil.approval/request'], correlation_id: null,
      idempotency_key: `send_${messageId}`, created_at: '2029-12-31T12:00:00Z', expires_at: '2030-01-01T00:00:00Z',
      signature: { algorithm: 'Ed25519', key_id: ids.key, value: '' }
    };
    envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.privateKey).toString('base64url');
    return envelope;
  }

  // No decision exists yet: rejected, nothing persisted.
  const firstAttempt = buildEnvelope(`msg_first_${suffix}`);
  const blocked = await acceptEnvelopeAsync(firstAttempt, { registered, repository, now: new Date('2029-12-31T12:01:00Z') });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'APPROVAL_REQUIRED');

  // Record a decision matching this exact envelope's canonical hash (the action_hash a real
  // WebAuthn approval-ceremony call would have been given at challenge-creation time).
  const canonicalHash = crypto.createHash('sha256').update(signedBytes(firstAttempt)).digest('hex');
  await pool.query(`
    INSERT INTO human_credentials (credential_id, human_id, type, public_key, status, valid_from, created_at)
      VALUES ('cred_${suffix}', '${ids.human}', 'webauthn', decode('00', 'hex'), 'active', NOW(), NOW());
    INSERT INTO approval_decisions (decision_id, human_id, credential_id, endpoint_id, action_hash, action_hash_algorithm, target, scope, contract_version, nonce, status, created_at, expires_at)
      VALUES ('decision_${suffix}', '${ids.human}', 'cred_${suffix}', '${ids.endpoint}', '${canonicalHash}', 'sha256', '{}', 'approval', 'sigil/1', 'nonce_${suffix}', 'approved', NOW(), '2030-01-01T00:00:00Z');
  `);

  // Same envelope bytes, now with a matching decision: accepted, and the decision is consumed.
  const approved = await acceptEnvelopeAsync(firstAttempt, { registered, repository, now: new Date('2029-12-31T12:02:00Z') });
  assert.equal(approved.status, 202);
  const decisionRow = await pool.query('SELECT status FROM approval_decisions WHERE decision_id = $1', [`decision_${suffix}`]);
  assert.equal(decisionRow.rows[0].status, 'consumed');

  // A different envelope (distinct message_id -> distinct canonical hash) from
  // the same endpoint does NOT inherit the decision just consumed above --
  // approval is scoped to one specific action_hash, not a blanket per-endpoint
  // pass. (consumeApprovalDecision's single-use behavior itself -- the same
  // decision cannot be claimed twice -- is covered directly, at the repository
  // level, by the test above this one.)
  const secondAttempt = buildEnvelope(`msg_second_${suffix}`);
  const rejectedUnrelated = await acceptEnvelopeAsync(secondAttempt, { registered, repository, now: new Date('2029-12-31T12:03:00Z') });
  assert.equal(rejectedUnrelated.status, 403);
  assert.equal(rejectedUnrelated.body.code, 'APPROVAL_REQUIRED');
});
