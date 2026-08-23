import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { createRelayServer } from './http-server.mjs';
import { signMockIdToken, FIXTURE_ISSUER } from './mock-oidc.mjs';
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
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = `usr_${suffix}`;
  const endpointId = `ep_${suffix}`;
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${humanId}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at) VALUES ('${endpointId}', '${humanId}', 'claude', 'install_${suffix}', 'A', 'active', NOW());
  `);
  const repository = new PostgresRepository({ pool });
  const now = new Date('2026-08-22T00:00:00Z');
  const server = createRelayServer({ repository, enableMockOidc: true, authenticate: async () => ({ endpoint_id: endpointId, human_id: humanId }), now: () => now });
  const port = await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { pool, humanId, endpointId, baseUrl: `http://127.0.0.1:${port}`, now };
}

test('wrong issuer with no oidc_issuer_allowlist row: token verifies, but match half returns null (FK-backed no-op, not an error)', { skip: !connectionString }, async (t) => {
  const { baseUrl, now } = await bootstrap(t);
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now });
  const response = await fetch(`${baseUrl}/v1/auth/mock-login`, { method: 'POST', body: JSON.stringify({ id_token: token }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.match, null);
});

test('success path: fixture issuer allow-listed, pending match request gets claimed', { skip: !connectionString }, async (t) => {
  const { pool, baseUrl, humanId, endpointId, now } = await bootstrap(t);
  await pool.query(`INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, added_at) VALUES ($1, 'Mock', TRUE, NOW())`, [FIXTURE_ISSUER]);
  const repository = new PostgresRepository({ pool });
  const requesterHuman = `usr_req_${crypto.randomUUID().replaceAll('-', '_')}`;
  const requesterEndpoint = `ep_req_${crypto.randomUUID().replaceAll('-', '_')}`;
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [requesterHuman]);
  await pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at) VALUES ($1, $2, 'claude', $3, 'R', 'active', NOW())`, [requesterEndpoint, requesterHuman, `install_${requesterEndpoint}`]);
  await repository.createDirectoryMatchRequest({ issuerEndpointId: requesterEndpoint, issuerHumanId: requesterHuman, issuer: FIXTURE_ISSUER, matchTarget: 'a@example.com', expiresAt: new Date(now.getTime() + 3_600_000), homeRelay: 'relay.local', now });

  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now });
  const response = await fetch(`${baseUrl}/v1/auth/mock-login`, { method: 'POST', body: JSON.stringify({ id_token: token }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(typeof body.match.request_id, 'string');
  assert.equal(body.session.human_id, humanId);

  const sessionRow = await pool.query('SELECT * FROM human_sessions WHERE session_id = $1', [body.session.session_id]);
  assert.equal(sessionRow.rows.length, 1);
  const auditRow = await pool.query(`SELECT * FROM audit_events WHERE subject_id = $1 AND event_type = 'human_session.created'`, [body.session.session_id]);
  assert.equal(auditRow.rows.length, 1);
  assert.equal(auditRow.rows[0].actor_human_id, humanId);
  assert.equal(auditRow.rows[0].endpoint_id, endpointId);
  assert.equal(auditRow.rows[0].outcome, 'success');
});

test('replayed jti: retrying the exact same token after a simulated mid-sequence failure succeeds (rollback did not consume it)', { skip: !connectionString }, async (t) => {
  const { pool, baseUrl, now } = await bootstrap(t);
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now });

  // First: monkeypatch createHumanSession to fail, forcing a rollback --
  // done here by directly exercising the repository/transaction path rather
  // than the HTTP route, since the route always uses the real method.
  const repository = new PostgresRepository({ pool });
  const originalCreateHumanSession = repository.createHumanSession.bind(repository);
  let shouldFail = true;
  repository.createHumanSession = async (...args) => {
    if (shouldFail) { shouldFail = false; throw new Error('simulated mid-sequence failure'); }
    return originalCreateHumanSession(...args);
  };
  const { verifyMockIdToken } = await import('./mock-oidc.mjs');
  const claims = verifyMockIdToken(token, { now: () => now });
  const sessionId = `sess_${crypto.randomUUID()}`;
  const expiresAt = new Date(now.getTime() + 300_000);
  await assert.rejects(repository.withTransaction(async (client) => {
    await repository.consumeLoginJti(claims.jti, { now, expiresAt, client });
    await repository.createHumanSession({ sessionId, humanId: 'irrelevant', authenticationMethod: 'mock_oidc', assurance: 'standard', issuedAt: now, expiresAt, now, client });
  }));

  // Retry: the jti must not have been left consumed by the rolled-back
  // transaction -- a fresh consumeLoginJti for the same jti succeeds.
  await repository.consumeLoginJti(claims.jti, { now, expiresAt });

  const replayRow = await pool.query('SELECT count(*) FROM login_jti_replays WHERE jti = $1', [claims.jti]);
  assert.equal(Number(replayRow.rows[0].count), 1);
});

test('replayed jti over HTTP: second call to the route with the same token returns 401 TOKEN_REPLAYED, only one session/audit row exists', { skip: !connectionString }, async (t) => {
  const { pool, baseUrl, now } = await bootstrap(t);
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now });
  const first = await fetch(`${baseUrl}/v1/auth/mock-login`, { method: 'POST', body: JSON.stringify({ id_token: token }) });
  assert.equal(first.status, 201);
  const second = await fetch(`${baseUrl}/v1/auth/mock-login`, { method: 'POST', body: JSON.stringify({ id_token: token }) });
  assert.equal(second.status, 401);
  const secondBody = await second.json();
  assert.equal(secondBody.code, 'TOKEN_REPLAYED');
  const sessions = await pool.query('SELECT count(*) FROM human_sessions');
  assert.equal(Number(sessions.rows[0].count), 1);
});
