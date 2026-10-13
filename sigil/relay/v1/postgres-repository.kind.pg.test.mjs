import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { createIdentity } from '../../cli/identity.mjs';
import { ROOM_SYSTEM_ENDPOINT_ID, ROOM_SYSTEM_OWNER_ID } from './room-system-identity.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function setup(t) {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  return { pool, repository: new PostgresRepository({ pool }) };
}

const kindOf = async (pool, id) => (await pool.query('SELECT kind FROM endpoints WHERE endpoint_id = $1', [id])).rows[0]?.kind;

test('endpoint writers store an explicit kind', { skip: !connectionString }, async (t) => {
  const { pool, repository } = await setup(t);
  const s = crypto.randomUUID().replaceAll('-', '_');
  const humanId = `usr_${s}`;
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [humanId]);
  const der = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
  const base = { ownerId: humanId, runtime: 'codex', publicKey: der };

  await repository.createEndpointWithAudit({ ...base, endpointId: `ep_h_${s}`, installationId: `i_h_${s}`, displayName: 'H', keyId: `k_h_${s}`, kind: 'human' });
  assert.equal(await kindOf(pool, `ep_h_${s}`), 'human');

  await repository.createEndpointWithAudit({ ...base, endpointId: `ep_a_${s}`, installationId: `i_a_${s}`, displayName: 'A', keyId: `k_a_${s}`, kind: 'agent' });
  assert.equal(await kindOf(pool, `ep_a_${s}`), 'agent');

  await assert.rejects(
    () => repository.createEndpointWithAudit({ ...base, endpointId: `ep_n_${s}`, installationId: `i_n_${s}`, displayName: 'N', keyId: `k_n_${s}` }),
    { code: 'INVALID_KIND' },
  );
  await assert.rejects(
    () => repository.createEndpointWithAudit({ ...base, endpointId: `ep_b_${s}`, installationId: `i_b_${s}`, displayName: 'B', keyId: `k_b_${s}`, kind: 'robot' }),
    { code: 'INVALID_KIND' },
  );
  assert.equal(await kindOf(pool, `ep_n_${s}`), undefined);
  assert.equal(await kindOf(pool, `ep_b_${s}`), undefined);

  const identity = createIdentity({ ownerId: ROOM_SYSTEM_OWNER_ID, endpointId: ROOM_SYSTEM_ENDPOINT_ID, kind: 'system' });
  await repository.ensureRoomSystemEndpoint({ identity });
  assert.equal(await kindOf(pool, ROOM_SYSTEM_ENDPOINT_ID), 'system');

  await repository.registerFederatedSender({ endpoint_id: `ep_f_${s}@peer.example`, owner_id: `usr_f_${s}@peer.example`, key_id: `k_f_${s}`, public_key: der, origin_domain: 'peer.example' });
  assert.equal(await kindOf(pool, `ep_f_${s}@peer.example`), 'agent');
});
