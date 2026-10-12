import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../scripts/apply-migrations.mjs';

const sql = fs.readFileSync(new URL('./033_multi_human_foundation.sql', import.meta.url), 'utf8');
const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('033 declares every column and index the foundation relies on', () => {
  for (const pattern of [
    /ADD COLUMN kind TEXT/, /CHECK \(kind IN \('human','agent','system'\)\)/, /suspended_by_human_id TEXT/,
    /CREATE UNIQUE INDEX endpoint_keys_one_active_idx ON endpoint_keys \(endpoint_id\) WHERE status = 'active'/,
    /CREATE TABLE human_signing_keys/, /invokable_by TEXT NOT NULL DEFAULT 'owner'/, /subject_human_id TEXT/,
  ]) assert.match(sql, pattern);
});

test('033 backfills kind, retires surplus shadow keys, backfills subject', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true, through: '032' });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const s = crypto.randomUUID().replaceAll('-', '_');
  await pool.query(`INSERT INTO humans (human_id,status,created_at) VALUES ($1,'active',NOW())`, [`h_${s}`]);
  for (const [id, runtime, origin] of [[`relay_${s}`, 'relay', null], [`hum_${s}`, 'human', null], [`ag_${s}`, 'claude', null], [`fed_${s}`, 'federated', 'peer.example'], [`skew_${s}`, 'federated', 'peer.example']]) {
    await pool.query(`INSERT INTO endpoints (endpoint_id,owner_id,runtime,installation_id,display_name,status,origin_domain,created_at) VALUES ($1,$2,$3,$4,$1,'active',$5,NOW())`, [id, `h_${s}`, runtime, `i_${id}`, origin]);
  }
  // Equal valid_from: the greater key_id (kb_) must win the tie-break.
  for (const k of ['a', 'b']) await pool.query(`INSERT INTO endpoint_keys (key_id,endpoint_id,algorithm,public_key,status,valid_from) VALUES ($1,$2,'Ed25519',$3,'active','2026-01-01T00:00:00Z')`, [`k${k}_${s}`, `fed_${s}`, Buffer.alloc(32, 1)]);
  // Surplus key with a future valid_from (peer clock skew) must not violate the valid_until check.
  await pool.query(`INSERT INTO endpoint_keys (key_id,endpoint_id,algorithm,public_key,status,valid_from) VALUES ($1,$2,'Ed25519',$3,'active',NOW() + interval '1 day')`, [`ks1_${s}`, `skew_${s}`, Buffer.alloc(32, 1)]);
  await pool.query(`INSERT INTO endpoint_keys (key_id,endpoint_id,algorithm,public_key,status,valid_from) VALUES ($1,$2,'Ed25519',$3,'active',NOW() + interval '2 days')`, [`ks2_${s}`, `skew_${s}`, Buffer.alloc(32, 1)]);
  await applyMigrations(connectionString);
  const st = Object.fromEntries((await pool.query(`SELECT key_id, status FROM endpoint_keys WHERE key_id LIKE '%${s}'`)).rows.map((r) => [r.key_id.split('_')[0], r.status]));
  assert.deepEqual(st, { ka: 'retired', kb: 'active', ks1: 'retired', ks2: 'active' });
  const kinds = Object.fromEntries((await pool.query(`SELECT endpoint_id, kind FROM endpoints WHERE endpoint_id LIKE '%${s}'`)).rows.map((r) => [r.endpoint_id.split('_')[0], r.kind]));
  assert.deepEqual(kinds, { relay: 'system', hum: 'human', ag: 'agent', fed: 'agent', skew: 'agent' });
  const active = await pool.query(`SELECT count(*)::int AS n FROM endpoint_keys WHERE endpoint_id = $1 AND status = 'active'`, [`fed_${s}`]);
  assert.equal(active.rows[0].n, 1);
  await assert.rejects(pool.query(`INSERT INTO endpoint_keys (key_id,endpoint_id,algorithm,public_key,status,valid_from) VALUES ($1,$2,'Ed25519',$3,'active',NOW())`, [`kc_${s}`, `fed_${s}`, Buffer.alloc(32, 2)]), { code: '23505' });
});

test('033 fails naming a local endpoint with two active keys', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true, through: '032' });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const s = crypto.randomUUID().replaceAll('-', '_');
  await pool.query(`INSERT INTO humans (human_id,status,created_at) VALUES ($1,'active',NOW())`, [`h_${s}`]);
  await pool.query(`INSERT INTO endpoints (endpoint_id,owner_id,runtime,installation_id,display_name,status,created_at) VALUES ($1,$2,'claude',$3,$1,'active',NOW())`, [`dup_${s}`, `h_${s}`, `i_${s}`]);
  for (const k of ['a', 'b']) await pool.query(`INSERT INTO endpoint_keys (key_id,endpoint_id,algorithm,public_key,status,valid_from) VALUES ($1,$2,'Ed25519',$3,'active',NOW())`, [`k${k}_${s}`, `dup_${s}`, Buffer.alloc(32, 1)]);
  await assert.rejects(applyMigrations(connectionString), (e) => e.message.includes(`dup_${s}`));
});
