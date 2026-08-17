import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';

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
  assert.deepEqual(row, { message_id: ids.message, duplicate: false });

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
  const delivery = await pool.query('SELECT message_id, recipient_endpoint_id, state FROM deliveries WHERE message_id = $1', [ids.message]);
  assert.deepEqual(delivery.rows, [{ message_id: ids.message, recipient_endpoint_id: ids.claude, state: 'queued' }]);
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

test('concurrent duplicate ack requests race safely to exactly one acknowledgement, and survive a fresh connection', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = {
    human: `usr_${suffix}`, codex: `ep_codex_${suffix}`, claude: `ep_claude_${suffix}`, other: `ep_other_${suffix}`,
    key: `key_${suffix}`, conversation: `conv_${suffix}`, message: `msg_ack_race_${suffix}`, delivery: `del_ack_race_${suffix}`
  };
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
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
