import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function freshDb(t) {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  return pool;
}

test('consumeMockLoginJti allows first use, rejects replay with TOKEN_REPLAYED', { skip: !connectionString }, async (t) => {
  const pool = await freshDb(t);
  const repository = new PostgresRepository({ pool });
  const now = new Date('2026-08-22T00:00:00Z');
  const expiresAt = new Date(now.getTime() + 300_000);
  const jti = `jti_${crypto.randomUUID()}`;
  await repository.consumeMockLoginJti(jti, { now, expiresAt });
  await assert.rejects(
    () => repository.consumeMockLoginJti(jti, { now, expiresAt }),
    { code: 'TOKEN_REPLAYED' }
  );
});

test('upsertMockOidcIssuerAllowlist inserts the fixture issuer, enabled, standard assurance, idempotently', { skip: !connectionString }, async (t) => {
  const pool = await freshDb(t);
  const repository = new PostgresRepository({ pool });
  const now = new Date('2026-08-22T00:00:00Z');
  await repository.upsertMockOidcIssuerAllowlist({ issuer: 'https://mock-oidc.sigil.local', now });
  await repository.upsertMockOidcIssuerAllowlist({ issuer: 'https://mock-oidc.sigil.local', now });
  const row = await pool.query('SELECT * FROM oidc_issuer_allowlist WHERE issuer = $1', ['https://mock-oidc.sigil.local']);
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].enabled, true);
  assert.equal(row.rows[0].assurance_level, 'standard');
});
