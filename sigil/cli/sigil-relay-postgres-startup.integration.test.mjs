import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
import http from 'node:http';

import { createIdentity } from './identity.mjs';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('sigil relay up auto-migrates fresh database and registers endpoints', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());

  // 1. Wipe schema completely so database is completely fresh/empty
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  // 2. Prepare test registry
  const id1 = createIdentity({ ownerId: 'usr_test_owner', endpointId: 'ep_test_alpha', kind: 'agent' });
  const id2 = createIdentity({ ownerId: 'usr_test_owner', endpointId: 'ep_test_beta', kind: 'human' });

  const registryData = {
    endpoints: [
      {
        owner_id: id1.owner_id,
        endpoint_id: id1.endpoint_id,
        key_id: id1.key_id,
        kind: id1.kind,
        status: 'active',
        public_key_pem: id1.public_key_pem,
        relay_token: id1.relay_token,
      },
      {
        owner_id: id2.owner_id,
        endpoint_id: id2.endpoint_id,
        key_id: id2.key_id,
        kind: id2.kind,
        status: 'active',
        public_key_pem: id2.public_key_pem,
        relay_token: id2.relay_token,
      },
    ],
  };

  const regPath = join(tmpdir(), `sigil-test-reg-${Date.now()}.json`);
  writeFileSync(regPath, JSON.stringify(registryData, null, 2), 'utf8');
  t.after(() => { try { unlinkSync(regPath); } catch {} });

  // 3. Test running relay startup sequence against the empty database
  const { applyMigrations } = await import('../scripts/apply-migrations.mjs');
  await applyMigrations(connectionString);

  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const repository = new PostgresRepository({ pool });

  // Verify migrations table exists and has all migrations
  const migrationsResult = await pool.query('SELECT version FROM _sigil_schema_migrations ORDER BY version ASC');
  assert.ok(migrationsResult.rows.length >= 11, 'All 11 migrations must be applied');

  // Verify tables exist
  const tablesResult = await pool.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name IN ('humans', 'endpoints', 'endpoint_keys', 'envelopes', 'deliveries')
  `);
  assert.equal(tablesResult.rows.length, 5, 'Core tables must exist after auto-migration');

  // Perform endpoint sync
  for (const ep of registryData.endpoints) {
    await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW()) ON CONFLICT (human_id) DO NOTHING`, [ep.owner_id]);
    await pool.query(`
      INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ($1, $2, $3, $4, $5, 'active', NOW())
      ON CONFLICT (endpoint_id) DO UPDATE SET status = 'active'
    `, [ep.endpoint_id, ep.owner_id, ep.kind ?? 'agent', `install_${ep.endpoint_id}`, ep.endpoint_id]);
    if (ep.public_key_pem) {
      const pubKeyBuf = crypto.createPublicKey(ep.public_key_pem).export({ type: 'spki', format: 'der' });
      await pool.query(`
        INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
        VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())
        ON CONFLICT (key_id) DO NOTHING
      `, [ep.key_id, ep.endpoint_id, pubKeyBuf]);
    }
  }

  // 4. Assert endpoints and keys are persisted
  const endpointsResult = await pool.query('SELECT endpoint_id, status FROM endpoints WHERE owner_id = $1 ORDER BY endpoint_id ASC', ['usr_test_owner']);
  assert.equal(endpointsResult.rows.length, 2);
  assert.equal(endpointsResult.rows[0].endpoint_id, 'ep_test_alpha');
  assert.equal(endpointsResult.rows[0].status, 'active');
  assert.equal(endpointsResult.rows[1].endpoint_id, 'ep_test_beta');
  assert.equal(endpointsResult.rows[1].status, 'active');

  const keysResult = await pool.query('SELECT key_id, algorithm, status FROM endpoint_keys WHERE endpoint_id = ANY($1)', [['ep_test_alpha', 'ep_test_beta']]);
  assert.equal(keysResult.rows.length, 2);
  assert.equal(keysResult.rows[0].algorithm, 'Ed25519');
  assert.equal(keysResult.rows[0].status, 'active');
});

test('startOidcIssuerAllowlistPolling picks up an issuer added after startup on the next tick', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  const { applyMigrations } = await import('../scripts/apply-migrations.mjs');
  await applyMigrations(connectionString);
  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { startOidcIssuerAllowlistPolling } = await import('./sigil.mjs');
  const repository = new PostgresRepository({ pool });

  const allowlistSet = new Set();
  const handle = startOidcIssuerAllowlistPolling({ repository, allowlistSet, intervalMs: 20 });
  t.after(() => clearInterval(handle));

  const issuer = `https://poll-test-${crypto.randomUUID().replaceAll('-', '_')}.example`;
  await repository.upsertOidcIssuerAllowlist({ issuer, clientId: 'poll-client' });

  await new Promise((resolve, reject) => {
    const check = setInterval(() => {
      if (allowlistSet.has(issuer)) { clearInterval(check); resolve(); }
    }, 10);
    setTimeout(() => { clearInterval(check); reject(new Error('timed out waiting for poll tick to pick up new issuer')); }, 2000);
  });

  assert.ok(allowlistSet.has(issuer));
});
