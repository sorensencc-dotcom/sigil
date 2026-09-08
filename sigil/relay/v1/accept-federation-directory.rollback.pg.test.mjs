import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { PostgresRepository } from './postgres-repository.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

// B3 rollback safety. The nonce is consumed as the FIRST statement inside the
// handler transaction, so a handler that rejects afterwards (FEDERATION_LINK_
// EXISTS, RATE_LIMITED, a driver error) rolls the INSERT back with everything
// else. A peer that retries the same signed request must therefore still be
// able to spend its nonce -- otherwise one transient failure would permanently
// poison that request.
test('B3 rollback safety: a handler that throws after consumeRelayNonce does not burn the nonce', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  const repo = new PostgresRepository({ pool });
  t.after(() => pool.end());
  await applyMigrations(connectionString, { reset: true });

  const nonce = 'ROLLBACK_00000000000000';
  await assert.rejects(repo.withTransaction(async (client) => {
    await repo.consumeRelayNonce(nonce, { expiresAt: new Date(Date.now() + 300_000), client });
    throw Object.assign(new Error('link exists'), { code: 'FEDERATION_LINK_EXISTS' });
  }), (error) => error.code === 'FEDERATION_LINK_EXISTS');

  // a later request with the SAME nonce is accepted, because the first tx rolled back
  await repo.withTransaction(async (client) => {
    await repo.consumeRelayNonce(nonce, { expiresAt: new Date(Date.now() + 300_000), client });
  });

  // and the committed one IS burned: a third attempt is a genuine replay
  await assert.rejects(repo.withTransaction(async (client) => {
    await repo.consumeRelayNonce(nonce, { expiresAt: new Date(Date.now() + 300_000), client });
  }), (error) => error.code === 'RELAY_REPLAYED');
});
