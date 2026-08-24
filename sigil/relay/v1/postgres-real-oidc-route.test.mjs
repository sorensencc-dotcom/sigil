// sigil/relay/v1/postgres-real-oidc-route.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { createRelayServer } from './http-server.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

const ISSUER = 'https://idp.example';
const CLIENT_ID = 'sigil-client-1';
const JWKS_URI = 'https://idp.example/jwks.json';
const FIXED_NOW = new Date('2026-08-23T00:00:00Z');

function b64url(buffer) { return buffer.toString('base64url'); }
function signToken({ privateKey, header = {}, payload }) {
  const fullHeader = { alg: 'RS256', typ: 'JWT', ...header };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(fullHeader)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

const rsaKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaJwk = { ...rsaKeyPair.publicKey.export({ format: 'jwk' }), kid: 'rsa-key-1' };

function makeToken(overrides = {}) {
  const iat = Math.floor(FIXED_NOW.getTime() / 1000);
  const payload = { iss: ISSUER, sub: 'sub_1', email: 'a@example.com', email_verified: true, aud: CLIENT_ID, iat, exp: iat + 300, jti: crypto.randomUUID(), ...overrides };
  return signToken({ privateKey: rsaKeyPair.privateKey, header: { kid: rsaJwk.kid }, payload });
}

function fetchImpl(url) {
  if (url === `${ISSUER}/.well-known/openid-configuration`) return Promise.resolve({ ok: true, status: 200, json: async () => ({ issuer: ISSUER, jwks_uri: JWKS_URI }) });
  if (url === JWKS_URI) return Promise.resolve({ ok: true, status: 200, json: async () => ({ keys: [rsaJwk] }) });
  return Promise.reject(new Error(`Unexpected fetch: ${url}`));
}

async function bootstrap(t, { seedIssuer = true } = {}) {
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
  if (seedIssuer) {
    await pool.query(
      `INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, assurance_level, client_id, added_at) VALUES ($1, 'Test IdP', TRUE, 'standard', $2, NOW())`,
      [ISSUER, CLIENT_ID]
    );
  }
  const repository = new PostgresRepository({ pool });
  const server = createRelayServer({ repository, authenticate: async () => ({ endpoint_id: endpointId, human_id: humanId }), now: () => FIXED_NOW, oidcFetchImpl: fetchImpl });
  const port = await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { pool, humanId, endpointId, baseUrl: `http://127.0.0.1:${port}` };
}

async function post(baseUrl, idToken) {
  const response = await fetch(`${baseUrl}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: idToken }) });
  return { status: response.status, body: await response.json() };
}

test('unrecognized issuer -- 401, session table untouched', { skip: !connectionString }, async (t) => {
  const { pool, baseUrl } = await bootstrap(t, { seedIssuer: false });
  const result = await post(baseUrl, makeToken());
  assert.equal(result.status, 401);
  const sessions = await pool.query('SELECT count(*) FROM human_sessions');
  assert.equal(Number(sessions.rows[0].count), 0);
});

test('success path creates a durable session row and audit event', { skip: !connectionString }, async (t) => {
  const { pool, humanId, baseUrl } = await bootstrap(t);
  const result = await post(baseUrl, makeToken());
  assert.equal(result.status, 201);
  const sessions = await pool.query('SELECT human_id FROM human_sessions WHERE session_id = $1', [result.body.session.session_id]);
  assert.equal(sessions.rows[0].human_id, humanId);
  const audit = await pool.query(`SELECT * FROM audit_events WHERE event_type = 'human_session.created' AND subject_id = $1`, [result.body.session.session_id]);
  assert.equal(audit.rows[0].actor_human_id, humanId);
});

test('replayed token -- second call 401 TOKEN_REPLAYED, only one session row exists', { skip: !connectionString }, async (t) => {
  const { pool, baseUrl } = await bootstrap(t);
  const token = makeToken();
  const first = await post(baseUrl, token);
  assert.equal(first.status, 201);
  const second = await post(baseUrl, token);
  assert.equal(second.status, 401);
  assert.equal(second.body.code, 'TOKEN_REPLAYED');
  const sessions = await pool.query('SELECT count(*) FROM human_sessions');
  assert.equal(Number(sessions.rows[0].count), 1);
});

test('simulated mid-sequence failure rolls back the transaction; retrying the same token afterward succeeds', { skip: !connectionString }, async (t) => {
  const { pool, humanId, endpointId } = await bootstrap(t);
  const repository = new PostgresRepository({ pool });
  const failingRepository = new Proxy(repository, {
    get(target, prop) {
      if (prop === 'createHumanSession') {
        let calls = 0;
        return async (...args) => { calls++; if (calls === 1) throw new Error('simulated failure'); return target.createHumanSession(...args); };
      }
      return target[prop];
    }
  });
  const server = createRelayServer({ repository: failingRepository, authenticate: async () => ({ endpoint_id: endpointId, human_id: humanId }), now: () => FIXED_NOW, oidcFetchImpl: fetchImpl });
  const port = await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = makeToken();
  const failed = await post(baseUrl, token);
  assert.equal(failed.status, 500);
  const retried = await post(baseUrl, token);
  assert.equal(retried.status, 201);
});
