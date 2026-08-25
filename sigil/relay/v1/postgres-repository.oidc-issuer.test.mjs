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

test('listOidcIssuerAllowlist returns only enabled issuers', { skip: !connectionString }, async (t) => {
  const { pool, repository } = await bootstrap(t);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const enabledIssuer = `https://enabled-${suffix}.example`;
  const disabledIssuer = `https://disabled-${suffix}.example`;
  await pool.query(
    `INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, assurance_level, client_id, added_at) VALUES ($1, 'Enabled IdP', TRUE, 'standard', 'client_a', NOW())`,
    [enabledIssuer]
  );
  await pool.query(
    `INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, assurance_level, client_id, added_at) VALUES ($1, 'Disabled IdP', FALSE, 'standard', 'client_b', NOW())`,
    [disabledIssuer]
  );
  const entries = await repository.listOidcIssuerAllowlist();
  assert.deepEqual(entries.find((e) => e.issuer === enabledIssuer), { issuer: enabledIssuer, clientId: 'client_a', enabled: true, assuranceLevel: 'standard' });
  assert.equal(entries.some((e) => e.issuer === disabledIssuer), false);
});

test('upsertOidcIssuerAllowlist inserts a real issuer with a client_id', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const issuer = `https://idp-${suffix}.example`;
  await repository.upsertOidcIssuerAllowlist({ issuer, clientId: 'sigil-client-1', displayLabel: 'Example IdP', assuranceLevel: 'standard' });
  const entry = await repository.getOidcIssuerAllowlistEntry(issuer);
  assert.deepEqual(entry, { issuer, clientId: 'sigil-client-1', enabled: true });
});

test('upsertOidcIssuerAllowlist overwrites client_id on conflict', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const issuer = `https://idp-${suffix}.example`;
  await repository.upsertOidcIssuerAllowlist({ issuer, clientId: 'old-client' });
  await repository.upsertOidcIssuerAllowlist({ issuer, clientId: 'new-client' });
  const entry = await repository.getOidcIssuerAllowlistEntry(issuer);
  assert.equal(entry.clientId, 'new-client');
});

test('listOidcIssuerAllowlist({ includeDisabled: true }) returns both enabled and disabled issuers with assuranceLevel', { skip: !connectionString }, async (t) => {
  const { pool, repository } = await bootstrap(t);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const enabledIssuer = `https://enabled-${suffix}.example`;
  const disabledIssuer = `https://disabled-${suffix}.example`;
  await pool.query(
    `INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, assurance_level, client_id, added_at) VALUES ($1, 'Enabled IdP', TRUE, 'standard', 'client_a', NOW())`,
    [enabledIssuer]
  );
  await pool.query(
    `INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, assurance_level, client_id, added_at) VALUES ($1, 'Disabled IdP', FALSE, 'standard', 'client_b', NOW())`,
    [disabledIssuer]
  );
  const entries = await repository.listOidcIssuerAllowlist({ includeDisabled: true });
  assert.deepEqual(entries.find((e) => e.issuer === enabledIssuer), { issuer: enabledIssuer, clientId: 'client_a', enabled: true, assuranceLevel: 'standard' });
  assert.deepEqual(entries.find((e) => e.issuer === disabledIssuer), { issuer: disabledIssuer, clientId: 'client_b', enabled: false, assuranceLevel: 'standard' });
});

test('disableOidcIssuerAllowlist flips enabled to false without deleting the row', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const issuer = `https://idp-${suffix}.example`;
  await repository.upsertOidcIssuerAllowlist({ issuer, clientId: 'sigil-client-1' });
  await repository.disableOidcIssuerAllowlist(issuer);
  const entry = await repository.getOidcIssuerAllowlistEntry(issuer);
  assert.deepEqual(entry, { issuer, clientId: 'sigil-client-1', enabled: false });
});
