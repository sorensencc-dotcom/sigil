import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';

const sql = fs.readFileSync(new URL('./043_room_message_search.sql', import.meta.url), 'utf8');

test('043 enables trigram search and indexes only room message text', () => {
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS pg_trgm/);
  assert.match(sql, /USING GIN \(\(body->>'text'\) gin_trgm_ops\)/);
  assert.match(sql, /WHERE message_type = 'room\.message'/);
});

test('043 installs the search extension and supports bounded room queries', { skip: !process.env.SIGIL_TEST_DATABASE_URL }, async (t) => {
  const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
  assertDisposableTestDatabase(connectionString);
  const { applyMigrations } = await import('../scripts/apply-migrations.mjs');
  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const repository = new PostgresRepository({ pool });
  assert.deepEqual(await repository.listRoomMessagesBefore('missing-room', null, 10), []);
  assert.deepEqual(await repository.searchRoomMessages('missing-room', 'deploy', null, 10), []);
  const extension = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
  assert.equal(extension.rowCount, 1);
});
