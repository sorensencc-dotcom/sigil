// Live-Postgres pin for PostgresRepository.livenessSnapshot.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { PostgresRepository } from './postgres-repository.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('livenessSnapshot reports endpoint status, an active key, and the owning human status in one read', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyMigrations(connectionString);
  const repository = new PostgresRepository({ pool });
  const spki = () => crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ('hum_a', 'active', NOW())`);
  await pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at) VALUES
    ('ep_h','hum_a','web','human','inst_h','H','active',NOW()), ('ep_g','hum_a','claude','agent','inst_g','G','active',NOW())`);
  await pool.query(`INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ('key_h','ep_h','Ed25519',$1,'active',NOW())`, [spki()]);
  await pool.query(`INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ('key_g','ep_g','Ed25519',$1,'retired',NOW())`, [spki()]);

  assert.deepEqual(await repository.livenessSnapshot({ endpointId: 'ep_h' }),
    { endpoint_id: 'ep_h', owner_id: 'hum_a', kind: 'human', endpoint_status: 'active', has_active_key: true, human_status: 'active' });
  assert.deepEqual(await repository.livenessSnapshot({ endpointId: 'ep_g' }),
    { endpoint_id: 'ep_g', owner_id: 'hum_a', kind: 'agent', endpoint_status: 'active', has_active_key: false, human_status: 'active' });
  assert.equal(await repository.livenessSnapshot({ endpointId: 'ep_missing' }), null);

  await pool.query(`UPDATE humans SET status = 'suspended' WHERE human_id = 'hum_a'`);
  assert.equal((await repository.livenessSnapshot({ endpointId: 'ep_h' })).human_status, 'suspended');
});
