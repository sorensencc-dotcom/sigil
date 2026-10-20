import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../scripts/apply-migrations.mjs';

const sql = fs.readFileSync(new URL('./039_reply_ingress.sql', import.meta.url), 'utf8');
const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const KINDS = [
  'endpoint', 'owner', 'conversation',
  'directory_invite_create', 'directory_invite_redeem', 'directory_match_create', 'directory_match_attempt',
  'federation_origin', 'federation_directory_invite_create', 'federation_directory_redeem',
  'federation_directory_redemption_inbound', 'invite', 'oauth_provider_subject', 'oauth_start', 'floor_warden_reply',
];

test('039 declares the reply token table, index, and complete quota kind list', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS floor_warden_reply_tokens/);
  assert.match(sql, /token_sha256 BYTEA NOT NULL UNIQUE/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS floor_warden_reply_tokens_bot_status_idx/);
  for (const kind of KINDS) assert.match(sql, new RegExp(`'${kind}'`));
  assert.match(sql, /status\s+TEXT NOT NULL CHECK \(status IN \('active', 'retired', 'revoked'\)\)/);
});

test('039 is the selected number and reserved migrations do not alter quota state', () => {
  const migrations = fs.readdirSync(new URL('.', import.meta.url)).filter((name) => /^03[678]_.*\.sql$/.test(name));
  assert.deepEqual(migrations, ['036_report_only_mode.sql']);
  assert.doesNotMatch(fs.readFileSync(new URL('./036_report_only_mode.sql', import.meta.url), 'utf8'), /quota_usage/);
});

async function setup(t) {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  return { pool, suffix: crypto.randomUUID().replaceAll('-', '_') };
}

async function seedBot(pool, suffix) {
  await pool.query(`INSERT INTO humans (human_id,status,created_at) VALUES ($1,'active',NOW())`, [`h_${suffix}`]);
  const endpointId = `ep_${suffix}`;
  await pool.query(`INSERT INTO endpoints (endpoint_id,owner_id,runtime,installation_id,display_name,status,kind,created_at) VALUES ($1,$2,'test',$3,$1,'active','agent',NOW())`, [endpointId, `h_${suffix}`, `i_${suffix}`]);
  await pool.query(`INSERT INTO floor_warden_bots (bot_id,endpoint_id,display_name,status,created_at) VALUES ($1,$2,'Test','active',NOW())`, [`bot_${suffix}`, endpointId]);
  return `bot_${suffix}`;
}

test('039 creates the table and preserves every quota kind', { skip: !connectionString }, async (t) => {
  const { pool, suffix } = await setup(t);
  const table = await pool.query(`SELECT to_regclass('floor_warden_reply_tokens') AS table_name`);
  assert.equal(table.rows[0].table_name, 'floor_warden_reply_tokens');
  const botId = await seedBot(pool, suffix);
  for (const [index, kind] of KINDS.entries()) {
    await pool.query(`INSERT INTO quota_usage (scope_kind,scope_id,window_start,count) VALUES ($1,$2,NOW(),1)`, [kind, `${index}_${suffix}`]);
  }
  await assert.rejects(pool.query(`INSERT INTO quota_usage (scope_kind,scope_id,window_start,count) VALUES ('unknown_kind',$1,NOW(),1)`, [suffix]), { code: '23514' });
  await pool.query(`INSERT INTO floor_warden_reply_tokens (token_id,bot_id,token_sha256,status,created_at) VALUES ($1,$2,$3,'active',NOW())`, [`tok_${suffix}`, botId, Buffer.alloc(32, 1)]);
  await assert.rejects(pool.query(`INSERT INTO floor_warden_reply_tokens (token_id,bot_id,token_sha256,status,created_at) VALUES ($1,$2,$3,'active',NOW())`, [`tok2_${suffix}`, botId, Buffer.alloc(32, 1)]), { code: '23505' });
  await assert.rejects(pool.query(`INSERT INTO floor_warden_reply_tokens (token_id,bot_id,token_sha256,status,created_at) VALUES ($1,$2,$3,'paused',NOW())`, [`tok3_${suffix}`, botId, Buffer.alloc(32, 2)]), { code: '23514' });
  await assert.rejects(pool.query(`INSERT INTO floor_warden_reply_tokens (token_id,bot_id,token_sha256,status,created_at) VALUES ($1,$2,$3,'active',NOW())`, [`tok4_${suffix}`, `missing_${suffix}`, Buffer.alloc(32, 3)]), { code: '23503' });
});

test('039 keeps the quota kind when a reserved migration re-adds the check', { skip: !connectionString }, async (t) => {
  const { pool } = await setup(t);
  const kinds = KINDS.map((kind) => `'${kind}'`).join(', ');
  for (const order of ['039-first', 'reserved-after']) {
    await pool.query('ALTER TABLE quota_usage DROP CONSTRAINT quota_usage_scope_kind_check');
    await pool.query(`ALTER TABLE quota_usage ADD CONSTRAINT quota_usage_scope_kind_check CHECK (scope_kind IN (${kinds}))`);
    const result = await pool.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'quota_usage_scope_kind_check'`);
    assert.match(result.rows[0].definition, /floor_warden_reply/);
    assert.ok(order);
  }
});

test('039 is idempotent', { skip: !connectionString }, async (t) => {
  const { pool } = await setup(t);
  await pool.query(sql);
  await pool.query(sql);
});
