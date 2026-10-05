import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { createIdentity, identityKeys } from '../../cli/identity.mjs';
import { ROOM_SYSTEM_ENDPOINT_ID, ROOM_SYSTEM_OWNER_ID } from './room-system-identity.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('postgres ensureRoomSystemEndpoint is idempotent and stores a readable SPKI key', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  // Non-destructive: migrate without reset, then clear only the fixed-id rows this test owns.
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  const clean = async () => {
    await pool.query(`DELETE FROM endpoint_keys WHERE endpoint_id = 'ep_relay_system' OR key_id IN ('key_ep_relay_system', 'key_rotated')`);
    await pool.query(`DELETE FROM endpoints WHERE endpoint_id = 'ep_relay_system'`);
    await pool.query(`DELETE FROM humans WHERE human_id = 'relay_system'`);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  const repository = new PostgresRepository({ pool });
  const identity = createIdentity({ ownerId: ROOM_SYSTEM_OWNER_ID, endpointId: ROOM_SYSTEM_ENDPOINT_ID, kind: 'system' });
  const now = new Date();

  await repository.ensureRoomSystemEndpoint({ identity, now });
  await repository.ensureRoomSystemEndpoint({ identity, now });

  const keys = await pool.query(`SELECT public_key FROM endpoint_keys WHERE endpoint_id = 'ep_relay_system'`);
  assert.equal(keys.rowCount, 1);
  const endpoints = await pool.query(`SELECT count(*)::int AS n FROM endpoints WHERE endpoint_id = 'ep_relay_system'`);
  assert.equal(endpoints.rows[0].n, 1);

  // Read back as a verify key the way the relay does (SPKI DER -> KeyObject).
  const readBack = crypto.createPublicKey({ key: keys.rows[0].public_key, format: 'der', type: 'spki' });
  assert.deepEqual(readBack.export({ type: 'spki', format: 'der' }), identityKeys(identity).publicKey.export({ type: 'spki', format: 'der' }));
  const sig = crypto.sign(null, Buffer.from('x'), identityKeys(identity).privateKey);
  assert.equal(crypto.verify(null, Buffer.from('x'), readBack, sig), true);
});

test('postgres ensureRoomSystemEndpoint rejects a different key under the registered endpoint', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  const clean = async () => {
    await pool.query(`DELETE FROM endpoint_keys WHERE endpoint_id = 'ep_relay_system' OR key_id IN ('key_ep_relay_system', 'key_rotated')`);
    await pool.query(`DELETE FROM endpoints WHERE endpoint_id = 'ep_relay_system'`);
    await pool.query(`DELETE FROM humans WHERE human_id = 'relay_system'`);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  const repository = new PostgresRepository({ pool });
  const identity = createIdentity({ ownerId: ROOM_SYSTEM_OWNER_ID, endpointId: ROOM_SYSTEM_ENDPOINT_ID, kind: 'system' });
  await repository.ensureRoomSystemEndpoint({ identity });
  const impostor = createIdentity({ ownerId: ROOM_SYSTEM_OWNER_ID, endpointId: ROOM_SYSTEM_ENDPOINT_ID, kind: 'system' });
  await assert.rejects(() => repository.ensureRoomSystemEndpoint({ identity: impostor }), { code: 'ROOM_SYSTEM_KEY_MISMATCH' });
  const rotated = { ...impostor, key_id: 'key_rotated' };
  await assert.rejects(() => repository.ensureRoomSystemEndpoint({ identity: rotated }), { code: 'ROOM_SYSTEM_KEY_MISMATCH' });
  const keys = await pool.query(`SELECT key_id FROM endpoint_keys WHERE endpoint_id = 'ep_relay_system'`);
  assert.deepEqual(keys.rows.map((r) => r.key_id), ['key_ep_relay_system']);
});

test('postgres ensureRoomSystemEndpoint rejects an existing endpoint row owned by someone else', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  const clean = async () => {
    await pool.query(`DELETE FROM endpoint_keys WHERE endpoint_id = 'ep_relay_system' OR key_id = 'key_ep_relay_system'`);
    await pool.query(`DELETE FROM endpoints WHERE endpoint_id = 'ep_relay_system'`);
    await pool.query(`DELETE FROM humans WHERE human_id IN ('relay_system', 'usr_squatter')`);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ('usr_squatter', 'active', $1)`, [now]);
  await pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at) VALUES ('ep_relay_system', 'usr_squatter', 'relay', 'squat', 'Squat', 'active', $1)`, [now]);
  const repository = new PostgresRepository({ pool });
  const identity = createIdentity({ ownerId: ROOM_SYSTEM_OWNER_ID, endpointId: ROOM_SYSTEM_ENDPOINT_ID, kind: 'system' });
  await assert.rejects(() => repository.ensureRoomSystemEndpoint({ identity }), { code: 'ROOM_SYSTEM_OWNER_MISMATCH' });
  const keys = await pool.query(`SELECT key_id FROM endpoint_keys WHERE endpoint_id = 'ep_relay_system'`);
  assert.equal(keys.rowCount, 0);
});
