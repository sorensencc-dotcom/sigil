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
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
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
