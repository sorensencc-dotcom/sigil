import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../scripts/apply-migrations.mjs';

const sql = fs.readFileSync(new URL('./036_report_only_mode.sql', import.meta.url), 'utf8');
const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('036 widens response_mode and adds the report marker index', () => {
  assert.match(sql, /DROP CONSTRAINT IF EXISTS conversation_members_response_mode_check/);
  assert.match(sql, /response_mode IN \('joins', 'mentions_only', 'router', 'report_only'\)/);
  assert.match(sql, /report_post BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(sql, /ON envelopes \(conversation_id, created_at\)\s+WHERE report_post/);
});

async function setup(t) {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  return { pool, suffix: crypto.randomUUID().replaceAll('-', '_') };
}

async function seedRoom(pool, suffix) {
  const human = `h_${suffix}`;
  const endpoint = `ep_${suffix}`;
  const key = `key_${suffix}`;
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [human]);
  await pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, kind, created_at) VALUES ($1, $2, 'claude', $3, $1, 'active', 'agent', NOW())`, [endpoint, human, `install_${suffix}`]);
  await pool.query(`INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())`, [key, endpoint, Buffer.alloc(32, 1)]);
  await pool.query(`INSERT INTO conversations (conversation_id, kind, created_by, created_at) VALUES ($1, 'room', $2, NOW())`, [`room_${suffix}`, human]);
  await pool.query(`INSERT INTO workspaces (workspace_id, name, created_by, created_at) VALUES ($1, $1, $2, NOW())`, [`ws_${suffix}`, human]);
  await pool.query(`INSERT INTO rooms (conversation_id, workspace_id, name, created_at) VALUES ($1, $2, $3, NOW())`, [`room_${suffix}`, `ws_${suffix}`, `room_${suffix}`]);
  return { human, endpoint, key, room: `room_${suffix}` };
}

test('036 accepts report_only, defaults report_post false, and creates the partial index', { skip: !connectionString }, async (t) => {
  const { pool, suffix } = await setup(t);
  const ids = await seedRoom(pool, suffix);
  await pool.query(`INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at, response_mode) VALUES ($1, $2, 'member', $3, NOW(), 'report_only')`, [ids.room, ids.endpoint, ids.human]);
  const unknownEndpoint = `ep_unknown_${suffix}`;
  await pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, kind, created_at) VALUES ($1, $2, 'claude', $3, $1, 'active', 'agent', NOW())`, [unknownEndpoint, ids.human, `install_unknown_${suffix}`]);
  await assert.rejects(
    pool.query(`INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at, response_mode) VALUES ($1, $2, 'member', $3, NOW(), 'unknown')`, [ids.room, unknownEndpoint, ids.human]),
    { code: '23514' },
  );
  const columns = await pool.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'envelopes' AND column_name = 'report_post'`);
  assert.deepEqual(columns.rows[0], { data_type: 'boolean', is_nullable: 'NO', column_default: 'false' });
  const indexes = await pool.query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'envelopes' AND indexname = 'envelopes_report_posts_idx'`);
  assert.match(indexes.rows[0].indexdef, /\(conversation_id, created_at\).*WHERE report_post/i);
});

test('036 is idempotent', { skip: !connectionString }, async (t) => {
  const { pool } = await setup(t);
  await applyMigrations(connectionString);
  await pool.query(sql);
  await pool.query(sql);
});
