import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('postgres lookupTrustedEndpoint returns local endpoints with KeyObject keys only', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const s = crypto.randomUUID().replaceAll('-', '_');
  const ids = { human: `usr_te_${s}`, ep: `ep_te_${s}`, key: `key_te_${s}`, shadow: `ep_shadow_${s}@peer.example`, tx: `ep_tx_${s}` };
  const der = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [ids.human]);
  await pool.query(
    `INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, kind, created_at)
     VALUES ($1, $2, 'web', $3, 'web', 'active', 'human', NOW())`, [ids.ep, ids.human, `install_${ids.ep}`]);
  await pool.query(
    `INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
     VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())`, [ids.key, ids.ep, der]);
  await pool.query(
    `INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, kind, origin_domain, created_at)
     VALUES ($1, $2, 'web', $3, 'shadow', 'active', 'agent', 'peer.example', NOW())`, [ids.shadow, ids.human, `install_${ids.shadow}`]);
  const repository = new PostgresRepository({ pool });

  const found = await repository.lookupTrustedEndpoint(ids.ep);
  assert.equal(found.endpoint_id, ids.ep);
  assert.equal(found.owner_id, ids.human);
  assert.equal(found.kind, 'human');
  assert.equal(found.status, 'active');
  assert.equal(found.keys.get(ids.key).public_key.asymmetricKeyType, 'ed25519');
  assert.equal(await repository.lookupTrustedEndpoint(ids.shadow), null);
  assert.equal(await repository.lookupTrustedEndpoint(`missing_${s}`), null);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, kind, created_at)
       VALUES ($1, $2, 'web', $3, 'tx', 'active', 'human', NOW())`, [ids.tx, ids.human, `install_${ids.tx}`]);
    assert.equal((await repository.lookupTrustedEndpoint(ids.tx, client))?.endpoint_id, ids.tx);
    assert.equal(await repository.lookupTrustedEndpoint(ids.tx), null);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});
