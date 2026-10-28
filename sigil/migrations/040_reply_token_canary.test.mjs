import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';

const sql = fs.readFileSync(new URL('./040_reply_token_canary.sql', import.meta.url), 'utf8');
const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('040 widens reply token status to include canary', () => {
  assert.match(sql, /DROP CONSTRAINT IF EXISTS floor_warden_reply_tokens_status_check/);
  assert.match(sql, /ADD CONSTRAINT floor_warden_reply_tokens_status_check/);
  assert.match(sql, /status IN \('active', 'retired', 'revoked', 'canary'\)/);
});

async function setup(t) {
  const { default: pg } = await import('pg');
  const { applyMigrations } = await import('../scripts/apply-migrations.mjs');
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

test('040 allows status canary and rejects other junk', { skip: !connectionString }, async (t) => {
  const { pool, suffix } = await setup(t);
  const botId = await seedBot(pool, suffix);
  await pool.query(`INSERT INTO floor_warden_reply_tokens (token_id,bot_id,token_sha256,status,created_at) VALUES ($1,$2,$3,'canary',NOW())`, [`tok_canary_${suffix}`, botId, Buffer.alloc(32, 1)]);
  await assert.rejects(
    pool.query(`INSERT INTO floor_warden_reply_tokens (token_id,bot_id,token_sha256,status,created_at) VALUES ($1,$2,$3,'paused',NOW())`, [`tok_paused_${suffix}`, botId, Buffer.alloc(32, 2)]),
    { code: '23514' },
  );
});

test('040 is idempotent', { skip: !connectionString }, async (t) => {
  const { pool } = await setup(t);
  await pool.query(sql);
  await pool.query(sql);
});
