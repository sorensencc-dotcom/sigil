// Live-Postgres pins for Task 7: single active signing key, rotateEndpointKey,
// revokeEndpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const spki = () => crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });

async function setup(t) {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyMigrations(connectionString);
  const repository = new PostgresRepository({ pool });
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ('usr_k', 'active', NOW())`);
  await repository.createEndpointWithAudit({ endpointId: 'ep_k', ownerId: 'usr_k', installationId: 'inst_k', runtime: 'claude', displayName: 'K', keyId: 'key_k1', publicKey: spki(), kind: 'agent' });
  return { pool, repository };
}

const keyRows = async (pool, endpointId) => (await pool.query(`SELECT key_id, status, valid_until FROM endpoint_keys WHERE endpoint_id=$1 ORDER BY key_id`, [endpointId])).rows;

test('a second active key on a local endpoint raises 23505 on endpoint_keys_one_active_idx', { skip: !connectionString }, async (t) => {
  const { pool } = await setup(t);
  await assert.rejects(
    () => pool.query(`INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ('key_k2','ep_k','Ed25519',$1,'active',NOW())`, [spki()]),
    (error) => error.code === '23505' && error.constraint === 'endpoint_keys_one_active_idx',
  );
});

test('rotateEndpointKey retires the old key and leaves exactly one active', { skip: !connectionString }, async (t) => {
  const { pool, repository } = await setup(t);
  await repository.rotateEndpointKey({ endpointId: 'ep_k', newKey: { key_id: 'key_k2', public_key: spki() } });
  const rows = await keyRows(pool, 'ep_k');
  assert.deepEqual(rows.map((r) => [r.key_id, r.status]), [['key_k1', 'retired'], ['key_k2', 'active']]);
  assert.notEqual(rows[0].valid_until, null);
  assert.equal(rows[1].valid_until, null);
});

test('rotateEndpointKey rolls back the retire when the insert fails', { skip: !connectionString }, async (t) => {
  const { pool, repository } = await setup(t);
  await assert.rejects(() => repository.rotateEndpointKey({ endpointId: 'ep_k', newKey: { key_id: 'key_k1', public_key: spki() } }));
  assert.deepEqual((await keyRows(pool, 'ep_k')).map((r) => [r.key_id, r.status]), [['key_k1', 'active']]);
});

test('registerFederatedSender with a new key_id retires the old shadow key in one transaction', { skip: !connectionString }, async (t) => {
  const { pool, repository } = await setup(t);
  const sender = { endpoint_id: 'ep_s@a.example', owner_id: 'usr_s@a.example', public_key: spki(), origin_domain: 'a.example' };
  await repository.registerFederatedSender({ ...sender, key_id: 'key_s1' });
  await repository.registerFederatedSender({ ...sender, key_id: 'key_s1' });
  await repository.registerFederatedSender({ ...sender, key_id: 'key_s2' });
  assert.deepEqual((await keyRows(pool, sender.endpoint_id)).map((r) => [r.key_id, r.status]), [['key_s1', 'retired'], ['key_s2', 'active']]);
});

test('revokeEndpoint revokes, retires every key, audits, and nothing verifies afterwards', { skip: !connectionString }, async (t) => {
  const { pool, repository } = await setup(t);
  const result = await repository.revokeEndpoint({ endpointId: 'ep_k', actorHumanId: 'usr_k' });
  assert.deepEqual(result, { owner_id: 'usr_k' });
  const endpoint = (await pool.query(`SELECT status, revoked_at FROM endpoints WHERE endpoint_id='ep_k'`)).rows[0];
  assert.equal(endpoint.status, 'revoked');
  assert.notEqual(endpoint.revoked_at, null);
  const rows = await keyRows(pool, 'ep_k');
  assert.ok(rows.length > 0 && rows.every((r) => r.status === 'retired' && r.valid_until !== null));
  const audit = (await pool.query(`SELECT event_type, subject_id, actor_human_id FROM audit_events WHERE event_type='endpoint.revoked'`)).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].subject_id, 'ep_k');
  assert.equal(audit[0].actor_human_id, 'usr_k');
  const trusted = await repository.lookupTrustedEndpoint('ep_k');
  assert.equal(trusted.status, 'revoked');
  assert.ok([...trusted.keys.values()].every((k) => k.status === 'retired' && k.valid_until !== null));
});

test('revokeEndpoint on an unknown endpoint throws ENDPOINT_NOT_FOUND', { skip: !connectionString }, async (t) => {
  const { repository } = await setup(t);
  await assert.rejects(() => repository.revokeEndpoint({ endpointId: 'ep_missing' }), { code: 'ENDPOINT_NOT_FOUND' });
});
