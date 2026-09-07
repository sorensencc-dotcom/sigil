import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { PostgresRepository } from './postgres-repository.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('consumeRelayNonce: first ok, duplicate throws RELAY_REPLAYED; pruneRelayNonces clears expired', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  const repo = new PostgresRepository({ pool });
  t.after(() => pool.end());
  await applyMigrations(connectionString, { reset: true });

  const exp = new Date(Date.now() + 300_000);
  await repo.consumeRelayNonce('PGNONCE_0000000000000000', { expiresAt: exp });
  await assert.rejects(
    repo.consumeRelayNonce('PGNONCE_0000000000000000', { expiresAt: exp }),
    (e) => e.code === 'RELAY_REPLAYED',
  );

  await repo.consumeRelayNonce('PGNONCE_expired_00000000', { expiresAt: new Date(Date.now() - 1000) });
  const { deleted } = await repo.pruneRelayNonces(new Date());
  assert.ok(deleted >= 1);
});

test('consumeRelayNonce honours a transaction client and does not burn the nonce on rollback', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  const repo = new PostgresRepository({ pool });
  t.after(() => pool.end());
  await applyMigrations(connectionString, { reset: true });

  await assert.rejects(repo.withTransaction(async (client) => {
    await repo.consumeRelayNonce('PGNONCE_rollback_0000000', { expiresAt: new Date(Date.now() + 300_000), client });
    throw new Error('force rollback');
  }));
  // fresh transaction: the nonce is NOT seen, because the first tx rolled back
  await repo.consumeRelayNonce('PGNONCE_rollback_0000000', { expiresAt: new Date(Date.now() + 300_000) });
});
