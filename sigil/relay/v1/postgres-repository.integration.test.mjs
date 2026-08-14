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

  const migrationPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations/001_initial.sql');
  await pool.query(await fs.readFile(migrationPath, 'utf8'));

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
  assert.deepEqual(row, { message_id: ids.message });

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
