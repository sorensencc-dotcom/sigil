import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../scripts/apply-migrations.mjs';

const sql = fs.readFileSync(new URL('./035_floor_warden_bridge.sql', import.meta.url), 'utf8');
const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('035 declares the bot tables and thread columns', () => {
  for (const pattern of [
    /CREATE TABLE IF NOT EXISTS floor_warden_bots/, /CHECK \(status IN \('active','disabled'\)\)/,
    /endpoint_id\s+TEXT NOT NULL UNIQUE REFERENCES endpoints\(endpoint_id\)/,
    /CREATE TABLE IF NOT EXISTS bot_signing_keys/, /REFERENCES endpoint_keys\(key_id\)/,
    /ADD COLUMN IF NOT EXISTS cap_epoch INTEGER NOT NULL DEFAULT 0/, /ADD COLUMN IF NOT EXISTS last_reset_at TIMESTAMPTZ/,
  ]) assert.match(sql, pattern);
});

async function setup(t) {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  return { pool, s: crypto.randomUUID().replaceAll('-', '_') };
}

async function seedEndpoint(pool, s, name) {
  await pool.query(`INSERT INTO humans (human_id,status,created_at) VALUES ($1,'active',NOW()) ON CONFLICT DO NOTHING`, [`h_${s}`]);
  const id = `${name}_${s}`;
  await pool.query(`INSERT INTO endpoints (endpoint_id,owner_id,runtime,installation_id,display_name,status,kind,created_at) VALUES ($1,$2,'claude',$3,$1,'active','agent',NOW())`, [id, `h_${s}`, `i_${id}`]);
  return id;
}

test('035 creates the tables and columns', { skip: !connectionString }, async (t) => {
  const { pool } = await setup(t);
  for (const table of ['floor_warden_bots', 'bot_signing_keys']) {
    const r = await pool.query(`SELECT to_regclass($1) AS t`, [table]);
    assert.ok(r.rows[0].t, `${table} missing`);
  }
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'room_threads'`);
  const names = cols.rows.map((r) => r.column_name);
  assert.ok(names.includes('cap_epoch'));
  assert.ok(names.includes('last_reset_at'));
});

test('035 floor_warden_bots constrains status and endpoint', { skip: !connectionString }, async (t) => {
  const { pool, s } = await setup(t);
  const ep = await seedEndpoint(pool, s, 'bot');
  const ins = (botId, endpoint, status) => pool.query(`INSERT INTO floor_warden_bots (bot_id,endpoint_id,display_name,status,created_at) VALUES ($1,$2,'Grok',$3,NOW())`, [botId, endpoint, status]);
  await assert.rejects(ins(`b1_${s}`, ep, 'paused'), { code: '23514' });
  await ins(`b1_${s}`, ep, 'active');
  await assert.rejects(ins(`b2_${s}`, ep, 'active'), { code: '23505' });
  await assert.rejects(ins(`b3_${s}`, `missing_${s}`, 'active'), { code: '23503' });
  await ins(`b4_${s}`, await seedEndpoint(pool, s, 'bot2'), 'disabled');
});

test('035 bot_signing_keys references endpoint_keys', { skip: !connectionString }, async (t) => {
  const { pool, s } = await setup(t);
  const ep = await seedEndpoint(pool, s, 'keyed');
  const ins = (keyId) => pool.query(`INSERT INTO bot_signing_keys (key_id,wrapped_private_key,created_at) VALUES ($1,$2,NOW())`, [keyId, Buffer.alloc(48, 1)]);
  await assert.rejects(ins(`nokey_${s}`), { code: '23503' });
  await pool.query(`INSERT INTO endpoint_keys (key_id,endpoint_id,algorithm,public_key,status,valid_from) VALUES ($1,$2,'Ed25519',$3,'active',NOW())`, [`k_${s}`, ep, Buffer.alloc(32, 1)]);
  await ins(`k_${s}`);
});

test('035 cap_epoch defaults to 0 on a pre-existing thread row', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true, through: '034' });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const s = crypto.randomUUID().replaceAll('-', '_');
  await pool.query(`INSERT INTO humans (human_id,status,created_at) VALUES ($1,'active',NOW())`, [`h_${s}`]);
  await pool.query(`INSERT INTO conversations (conversation_id,kind,created_by,created_at) VALUES ($1,'room',$2,NOW())`, [`r_${s}`, `h_${s}`]);
  await pool.query(`INSERT INTO workspaces (workspace_id,name,created_by,created_at) VALUES ($1,$1,$2,NOW())`, [`ws_${s}`, `h_${s}`]);
  await pool.query(`INSERT INTO rooms (conversation_id,workspace_id,name,created_at) VALUES ($1,$2,'room',NOW())`, [`r_${s}`, `ws_${s}`]);
  await pool.query(`INSERT INTO room_threads (room_id,thread_root_id,agent_turns,updated_at) VALUES ($1,'root',2,NOW())`, [`r_${s}`]);
  await applyMigrations(connectionString);
  const r = await pool.query(`SELECT cap_epoch, last_reset_at FROM room_threads WHERE room_id = $1`, [`r_${s}`]);
  assert.equal(r.rows[0].cap_epoch, 0);
  assert.equal(r.rows[0].last_reset_at, null);
});

test('035 re-applying is a no-op', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await applyMigrations(connectionString);
  await pool.query(sql);
  await pool.query(sql);
});
