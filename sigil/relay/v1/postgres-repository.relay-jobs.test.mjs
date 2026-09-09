import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function bootstrap(t) {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  return { pool, repository: new PostgresRepository({ pool }) };
}

test('a non-federation relay job stores only generic payload through its full lifecycle', { skip: !connectionString }, async (t) => {
  const { pool, repository } = await bootstrap(t);
  const now = new Date('2026-09-09T01:00:00Z');
  const payload = { delivery: 'webhook', target: 'https://example.test/hooks/42' };

  const enqueued = await repository.enqueueRelayJob('future_job', { payload, now });
  assert.equal(enqueued.inserted, true);
  assert.equal(enqueued.row.jobType, 'future_job');
  assert.equal(enqueued.row.messageId, null);
  assert.equal(enqueued.row.recipientDomain, null);
  assert.deepEqual(enqueued.row.payload, payload);

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
