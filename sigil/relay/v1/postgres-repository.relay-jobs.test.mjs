import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function bootstrap(t, { through = null } = {}) {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const migrationFiles = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .filter((file) => through == null || file <= through);
  for (const file of migrationFiles) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  return { pool, repository: new PostgresRepository({ pool }) };
}

test('non-federation enqueue rejects missing or blank idempotency keys', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const payload = { delivery: 'webhook', target: 'https://example.test/hooks/43' };

  for (const idempotencyKey of [undefined, '', '   ']) {
    await assert.rejects(
      repository.enqueueRelayJob('future_job', { payload, idempotencyKey }),
      (error) => {
        assert.equal(error.code, 'RELAY_JOB_IDEMPOTENCY_KEY_REQUIRED');
        return true;
      },
    );
  }
});

test('migration 023 backfills legacy generic keys and enforces its partial unique index', { skip: !connectionString }, async (t) => {
  const { pool } = await bootstrap(t, { through: '022_generic_relay_jobs.sql' });
  const legacy = await pool.query(
    `INSERT INTO relay_jobs (job_type, payload)
     VALUES ('legacy_job', '{"source":"pre-023"}'::jsonb)
     RETURNING id`,
  );
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await pool.query(await fs.readFile(path.join(migrationsDir, '023_generic_relay_job_idempotency.sql'), 'utf8'));

  const migrated = await pool.query('SELECT idempotency_key FROM relay_jobs WHERE id = $1', [legacy.rows[0].id]);
  assert.equal(migrated.rows[0].idempotency_key, `legacy:${legacy.rows[0].id}`);

  for (const idempotencyKey of [null, '   ']) {
    await assert.rejects(
      pool.query(`INSERT INTO relay_jobs (job_type, idempotency_key) VALUES ('future_job', $1)`, [idempotencyKey]),
      (error) => error.code === '23514',
    );
  }
  await pool.query(`INSERT INTO relay_jobs (job_type, idempotency_key) VALUES ('future_job', 'duplicate-key')`);
  await assert.rejects(
    pool.query(`INSERT INTO relay_jobs (job_type, idempotency_key) VALUES ('future_job', 'duplicate-key')`),
    (error) => error.code === '23505',
  );

  const index = await pool.query(
    `SELECT i.indisunique, pg_get_expr(i.indpred, i.indrelid) AS predicate,
            pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_index i
      WHERE i.indexrelid = 'relay_jobs_generic_job_type_idempotency_uidx'::regclass`,
  );
  assert.equal(index.rows[0].indisunique, true);
  assert.match(index.rows[0].definition, /\(job_type, idempotency_key\)/);
  assert.match(index.rows[0].predicate, /job_type <> 'federation'::text/);
});

test('a non-federation relay job stores only generic payload through its full lifecycle', { skip: !connectionString }, async (t) => {
  const { pool, repository } = await bootstrap(t);
  const now = new Date('2026-09-09T01:00:00Z');
  const payload = { delivery: 'webhook', target: 'https://example.test/hooks/42' };
  const idempotencyKey = 'webhook-42';

  const enqueued = await repository.enqueueRelayJob('future_job', { payload, idempotencyKey, now });
  assert.equal(enqueued.inserted, true);
  assert.equal(enqueued.row.jobType, 'future_job');
  assert.equal(enqueued.row.messageId, null);
  assert.equal(enqueued.row.recipientDomain, null);
  assert.deepEqual(enqueued.row.payload, payload);

  const duplicate = await repository.enqueueRelayJob('future_job', { payload, idempotencyKey, now });
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.row.id, enqueued.row.id);

  const [claimed] = await repository.claimDueRelayJobs('future_job', now, 1, 30);
  assert.equal(claimed.id, enqueued.row.id);
  const finalized = await repository.finalizeRelayJob('future_job', claimed.id, claimed.claimToken, 'dead_letter', { reasonCode: 'WEBHOOK_UNAVAILABLE' });
  assert.deepEqual(finalized, { updated: true });
  const retried = await repository.retryRelayJob('future_job', claimed.id, now, { terminalStates: ['dead_letter'] });
  assert.deepEqual(retried, { retried: true });

  const indexes = await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'relay_jobs'`);
  assert.ok(indexes.rows.some((row) => /\(job_type, state, next_attempt_at\)/.test(row.indexdef)));
  assert.ok(indexes.rows.some((row) => /\(job_type, state, claimed_at\)/.test(row.indexdef)));
});
