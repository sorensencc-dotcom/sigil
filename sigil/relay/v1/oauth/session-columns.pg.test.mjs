import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { provisionHumanTx } from '../provision-human.mjs';
import { PostgresRepository } from '../postgres-repository.mjs';
import { withTransaction } from '../with-transaction.mjs';
import { assertDisposableTestDatabase } from '../../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const skip = !connectionString;
const wrapKey = crypto.randomBytes(32);
const NOW = new Date('2030-01-02T03:04:05.000Z');
const LATER = new Date(NOW.getTime() + 3_600_000);

async function setup(t) {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyMigrations(connectionString);
  const repository = new PostgresRepository({ pool });
  const a = await withTransaction(pool, (c) => provisionHumanTx(c, { displayName: 'A', wrapKey, now: NOW }));
  const b = await withTransaction(pool, (c) => provisionHumanTx(c, { displayName: 'B', wrapKey, now: NOW }));
  return { pool, repository, a, b };
}

const base = { authenticationMethod: 'oauth', assurance: 'low', issuedAt: NOW, expiresAt: LATER, now: NOW };

test('createHumanSession stores and returns the cookie-session columns', { skip }, async (t) => {
  const { repository, a } = await setup(t);
  const row = await repository.createHumanSession({
    ...base, sessionId: 'sess_cookie', humanId: a.human_id, endpointId: a.endpoint_id, lastSeenAt: NOW, identityIssuer: 'github', identitySubject: '42',
  });
  assert.equal(row.endpoint_id, a.endpoint_id);
  assert.equal(row.last_seen_at.toISOString(), NOW.toISOString());
  assert.equal(row.identity_issuer, 'github');
  assert.equal(row.identity_subject, '42');
});

test('createHumanSession without the new fields inserts a step-up row with nulls', { skip }, async (t) => {
  const { repository, a } = await setup(t);
  const row = await repository.createHumanSession({ ...base, sessionId: 'sess_stepup', humanId: a.human_id });
  assert.equal(row.endpoint_id, null);
  assert.equal(row.last_seen_at, null);
  assert.equal(row.identity_issuer, null);
  assert.equal(row.identity_subject, null);
});

test('createHumanSession rejects an endpoint owned by a different human (composite FK)', { skip }, async (t) => {
  const { repository, a, b } = await setup(t);
  await assert.rejects(
    repository.createHumanSession({ ...base, sessionId: 'sess_bad', humanId: a.human_id, endpointId: b.endpoint_id, lastSeenAt: NOW, identityIssuer: 'github', identitySubject: '42' }),
    (e) => e.code === '23503',
  );
});

test('createOidcIdentity with client rolls back with the caller transaction', { skip }, async (t) => {
  const { pool, repository, a } = await setup(t);
  await assert.rejects(withTransaction(pool, async (client) => {
    await repository.createOidcIdentity({ issuer: 'github', subject: '42', humanId: a.human_id, client, verifiedVia: 'oauth', endpointId: a.endpoint_id, now: NOW });
    throw new Error('abort');
  }), /abort/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM oidc_identities')).rows[0].n, 0);
  const row = await withTransaction(pool, (client) => repository.createOidcIdentity({ issuer: 'github', subject: '42', humanId: a.human_id, client, verifiedVia: 'oauth', endpointId: a.endpoint_id, now: NOW }));
  assert.equal(row.verified_via, 'oauth');
  assert.equal(row.endpoint_id, a.endpoint_id);
});

test('verifiedVia oauth without endpointId violates the CHECK; plain step-up identity still works', { skip }, async (t) => {
  const { repository, a } = await setup(t);
  await assert.rejects(
    repository.createOidcIdentity({ issuer: 'github', subject: '42', humanId: a.human_id, verifiedVia: 'oauth', now: NOW }),
    (e) => e.code === '23514',
  );
  const row = await repository.createOidcIdentity({ issuer: 'https://idp', subject: 's', humanId: a.human_id, now: NOW });
  assert.equal(row.verified_via, null);
});
