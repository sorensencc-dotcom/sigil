import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const migrationsDir = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = ['001_initial.sql', '002_delivery_acknowledgement_idempotency.sql', '003_plugin_connector_auth.sql', '004_security_hardening.sql'];

async function freshSchema(pool) {
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of MIGRATIONS) await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
}

async function seedHuman(pool, humanId) {
  await pool.query('INSERT INTO humans (human_id, status, created_at) VALUES ($1, $2, NOW())', [humanId, 'active']);
}

async function seedEndpoint(pool, { endpointId, humanId }) {
  await pool.query(
    `INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
     VALUES ($1, $2, 'codex', $3, 'Codex', 'active', NOW())`,
    [endpointId, humanId, `install_${endpointId}`]
  );
}

test('migration 003 applies cleanly on top of 001 and 002', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await assert.doesNotReject(() => freshSchema(pool));
});

test('new §9 tables exist with their required columns', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const expected = {
    oidc_identities: ['issuer', 'subject', 'human_id', 'status'],
    human_attributes: ['human_id', 'kind', 'value_or_ciphertext', 'verification_state'],
    human_sessions: ['session_id', 'human_id', 'authentication_method', 'assurance', 'device_context', 'issued_at', 'version', 'expires_at', 'revoked_at'],
    account_links: ['link_id', 'human_id', 'issuer', 'subject', 'status', 'created_at'],
    endpoint_tokens: ['token_id', 'endpoint_id', 'token_hash', 'status', 'expires_at'],
    package_records: ['package_id', 'publisher_key_id', 'digest', 'contract_version', 'status'],
    capability_grants: ['grant_id', 'subject', 'scope', 'purpose', 'provenance', 'issuer', 'issued_at', 'expires_at', 'revoked_at'],
    approval_decisions: ['decision_id', 'human_id', 'credential_id', 'endpoint_id', 'action_hash', 'action_hash_algorithm', 'target', 'context_refs', 'scope', 'contract_version', 'policy_version', 'nonce', 'expires_at', 'status'],
    audit_events: ['event_id', 'event_type', 'actor_human_id', 'endpoint_id', 'subject_id', 'object_type', 'object_id', 'action_hash', 'outcome', 'reason', 'created_at', 'metadata_redacted'],
    idempotency_records: ['endpoint_id', 'idempotency_key', 'operation', 'action_hash', 'contract_version', 'response_status', 'created_at', 'expires_at'],
    recovery_attempts: ['attempt_id', 'human_id', 'method', 'status', 'created_at']
  };
  for (const [table, columns] of Object.entries(expected)) {
    const result = await pool.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table]);
    const present = new Set(result.rows.map((row) => row.column_name));
    for (const column of columns) assert.ok(present.has(column), `${table}.${column} missing`);
  }
});

test('oidc_identities enforces the exact (issuer, subject) pair as primary key', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const humanId = `usr_${crypto.randomUUID()}`;
  await seedHuman(pool, humanId);
  await pool.query(`INSERT INTO oidc_identities (issuer, subject, human_id, status, created_at) VALUES ('https://idp.example', 'sub_1', $1, 'active', NOW())`, [humanId]);
  await assert.rejects(
    () => pool.query(`INSERT INTO oidc_identities (issuer, subject, human_id, status, created_at) VALUES ('https://idp.example', 'sub_1', $1, 'active', NOW())`, [humanId]),
    { code: '23505' }
  );
});

test('oidc_identities rejects an unknown status value', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const humanId = `usr_${crypto.randomUUID()}`;
  await seedHuman(pool, humanId);
  await assert.rejects(
    () => pool.query(`INSERT INTO oidc_identities (issuer, subject, human_id, status, created_at) VALUES ('https://idp.example', 'sub_1', $1, 'bogus', NOW())`, [humanId]),
    { code: '23514' }
  );
});

test('account_links requires the linked identity to already exist in oidc_identities', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const humanId = `usr_${crypto.randomUUID()}`;
  await seedHuman(pool, humanId);
  await assert.rejects(
    () => pool.query(
      `INSERT INTO account_links (link_id, human_id, issuer, subject, status, created_at) VALUES ('link_1', $1, 'https://idp.example', 'sub_missing', 'active', NOW())`,
      [humanId]
    ),
    { code: '23503' }
  );
  await pool.query(`INSERT INTO oidc_identities (issuer, subject, human_id, status, created_at) VALUES ('https://idp.example', 'sub_present', $1, 'active', NOW())`, [humanId]);
  await assert.doesNotReject(() => pool.query(
    `INSERT INTO account_links (link_id, human_id, issuer, subject, status, created_at) VALUES ('link_2', $1, 'https://idp.example', 'sub_present', 'active', NOW())`,
    [humanId]
  ));
});

test('human_sessions rejects expiry at or before issuance', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const humanId = `usr_${crypto.randomUUID()}`;
  await seedHuman(pool, humanId);
  await assert.rejects(
    () => pool.query(
      `INSERT INTO human_sessions (session_id, human_id, authentication_method, assurance, issued_at, expires_at)
       VALUES ('sess_1', $1, 'webauthn', 'high', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      [humanId]
    ),
    { code: '23514' }
  );
});

test('endpoint_tokens enforces a unique token hash', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const humanId = `usr_${crypto.randomUUID()}`;
  await seedHuman(pool, humanId);
  await seedEndpoint(pool, { endpointId: 'ep_1', humanId });
  await seedEndpoint(pool, { endpointId: 'ep_2', humanId });
  await pool.query(`INSERT INTO endpoint_tokens (token_id, endpoint_id, token_hash, status, created_at, expires_at) VALUES ('tok_1', 'ep_1', 'hash_shared', 'active', NOW(), NOW() + INTERVAL '1 hour')`);
  await assert.rejects(
    () => pool.query(`INSERT INTO endpoint_tokens (token_id, endpoint_id, token_hash, status, created_at, expires_at) VALUES ('tok_2', 'ep_2', 'hash_shared', 'active', NOW(), NOW() + INTERVAL '1 hour')`),
    { code: '23505' }
  );
});

test('package_records rejects an unknown status value', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  await assert.rejects(
    () => pool.query(`INSERT INTO package_records (package_id, publisher_key_id, digest, contract_version, status, created_at) VALUES ('pkg_1', 'pub_1', '${'a'.repeat(64)}', 'sigil.connector/v1', 'installed', NOW())`),
    { code: '23514' }
  );
});

test('capability_grants accepts the completed §3 fields alongside the original 001 columns', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const humanId = `usr_${crypto.randomUUID()}`;
  await seedHuman(pool, humanId);
  await seedEndpoint(pool, { endpointId: 'ep_1', humanId });
  await assert.doesNotReject(() => pool.query(
    `INSERT INTO capability_grants (grant_id, capability, scope, granted_to, granted_by, granted_at, expires_at, subject, purpose, provenance, issuer, issued_at)
     VALUES ('grant_1', 'sigil.task/submit', 'sigil.task/submit', 'ep_1', $1, NOW(), NOW() + INTERVAL '1 hour', 'ep_1', 'task automation', 'install-flow', 'https://idp.example', NOW())`,
    [humanId]
  ));
});

test('audit_events keeps accepting the legacy relay insert shape unmodified', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  // Mirrors the exact column list PostgresRepository#persistAcceptedEnvelope
  // writes today (sigil/relay/v1/postgres-repository.mjs), proving this
  // migration didn't require touching that code.
  await assert.doesNotReject(() => pool.query(
    `INSERT INTO audit_events (event_id, event_type, subject_id, actor_id, payload, created_at)
     VALUES ('audit_1', 'envelope.accepted', 'msg_1', 'ep_1', '{}', NOW())`
  ));
});

test('approval_decisions enforces single-use nonces and a bounded status set', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const humanId = `usr_${crypto.randomUUID()}`;
  await seedHuman(pool, humanId);
  await seedEndpoint(pool, { endpointId: 'ep_1', humanId });
  await pool.query(`INSERT INTO human_credentials (credential_id, human_id, type, public_key, status, valid_from, created_at) VALUES ('cred_1', $1, 'webauthn', decode('00', 'hex'), 'active', NOW(), NOW())`, [humanId]);
  const insert = (decisionId, nonce) => pool.query(
    `INSERT INTO approval_decisions (decision_id, human_id, credential_id, endpoint_id, action_hash, action_hash_algorithm, target, scope, contract_version, nonce, status, created_at, expires_at)
     VALUES ($1, $2, 'cred_1', 'ep_1', 'sha256:abc', 'RFC8785-JCS-SHA256', '{}', 'sigil.task/submit', 'sigil.connector/v1', $3, 'pending', NOW(), NOW() + INTERVAL '5 minutes')`,
    [decisionId, humanId, nonce]
  );
  await insert('decision_1', 'nonce_1');
  await assert.rejects(() => insert('decision_2', 'nonce_1'), { code: '23505' });
  await assert.rejects(
    () => pool.query(
      `INSERT INTO approval_decisions (decision_id, human_id, credential_id, endpoint_id, action_hash, action_hash_algorithm, target, scope, contract_version, nonce, status, created_at, expires_at)
       VALUES ('decision_3', $1, 'cred_1', 'ep_1', 'sha256:abc', 'RFC8785-JCS-SHA256', '{}', 'sigil.task/submit', 'sigil.connector/v1', 'nonce_2', 'bogus', NOW(), NOW() + INTERVAL '5 minutes')`,
      [humanId]
    ),
    { code: '23514' }
  );
});

test('idempotency_records is keyed per endpoint and rejects a raw duplicate insert', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const humanId = `usr_${crypto.randomUUID()}`;
  await seedHuman(pool, humanId);
  await seedEndpoint(pool, { endpointId: 'ep_1', humanId });
  const insert = () => pool.query(
    `INSERT INTO idempotency_records (endpoint_id, idempotency_key, operation, contract_version, response_status, created_at, expires_at)
     VALUES ('ep_1', 'key_1', 'ack_delivery', 'sigil.connector/v1', 204, NOW(), NOW() + INTERVAL '1 hour')`
  );
  await insert();
  await assert.rejects(insert, { code: '23505' });
});

test('recovery_attempts rejects an unrecognized method or fraud signal', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const humanId = `usr_${crypto.randomUUID()}`;
  await seedHuman(pool, humanId);
  await assert.rejects(
    () => pool.query(`INSERT INTO recovery_attempts (attempt_id, human_id, method, status, initiated_by, created_at) VALUES ('attempt_1', $1, 'carrier_pigeon', 'attempted', $1, NOW())`, [humanId]),
    { code: '23514' }
  );
  await assert.doesNotReject(() => pool.query(
    `INSERT INTO recovery_attempts (attempt_id, human_id, method, status, fraud_signal, initiated_by, created_at) VALUES ('attempt_2', $1, 'phone', 'blocked', 'sim_swap', $1, NOW())`,
    [humanId]
  ));
});
