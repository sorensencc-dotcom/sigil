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

async function bootstrap(t) {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  return { pool, repository: new PostgresRepository({ pool }) };
}

test('getOidcIssuerAllowlistEntry returns null for an unknown issuer', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  assert.equal(await repository.getOidcIssuerAllowlistEntry('https://unknown.example'), null);
});

test('getOidcIssuerAllowlistEntry returns clientId/enabled for a seeded issuer', { skip: !connectionString }, async (t) => {
  const { pool, repository } = await bootstrap(t);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  await pool.query(
    `INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, assurance_level, client_id, added_at) VALUES ($1, 'Test IdP', TRUE, 'standard', $2, NOW())`,
    [`https://idp-${suffix}.example`, `client_${suffix}`]
  );
  const entry = await repository.getOidcIssuerAllowlistEntry(`https://idp-${suffix}.example`);
  assert.equal(entry.clientId, `client_${suffix}`);
  assert.equal(entry.enabled, true);
});

test('getOidcIssuerAllowlistEntry returns clientId: null for a row with no client_id set', { skip: !connectionString }, async (t) => {
  const { pool, repository } = await bootstrap(t);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  await pool.query(
    `INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, assurance_level, added_at) VALUES ($1, 'Test IdP', TRUE, 'standard', NOW())`,
    [`https://idp-${suffix}.example`]
  );
  const entry = await repository.getOidcIssuerAllowlistEntry(`https://idp-${suffix}.example`);
  assert.equal(entry.clientId, null);
});
