import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { assertDisposableTestDatabase } from './assert-disposable-test-db.mjs';
import { applyMigrations } from './apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('applyMigrations through stops at the given migration prefix', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true, through: '005' });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const { rows } = await pool.query('SELECT version FROM _sigil_schema_migrations ORDER BY version');
  assert.ok(rows.length >= 5);
  assert.ok(rows.every((r) => parseInt(r.version, 10) <= 5));
  assert.ok(rows.some((r) => r.version.startsWith('005')));
});
