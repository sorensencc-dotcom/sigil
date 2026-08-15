import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const MIGRATIONS = ['001_initial.sql', '002_delivery_acknowledgement_idempotency.sql', '003_plugin_connector_auth.sql', '004_security_hardening.sql'];

async function freshSchema(pool) {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of MIGRATIONS) await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
}

async function seedHuman(pool, suffix) {
  const humanId = `usr_${suffix}`;
  await pool.query('INSERT INTO humans (human_id, status, created_at) VALUES ($1, $2, NOW())', [humanId, 'active']);
  return humanId;
}

async function seedEndpoint(pool, { endpointId, humanId }) {
  await pool.query(
    `INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
     VALUES ($1, $2, 'codex', $3, 'Codex', 'active', NOW())`,
    [endpointId, humanId, `install_${endpointId}`]
  );
}

// Wraps a real pg.Pool so its connect()ed client throws on the first
// INSERT INTO audit_events it sees, then behaves normally. This proves
// real Postgres transaction rollback -- BEGIN/…/ROLLBACK actually
// happening against a live connection -- not just a mocked assertion that
// ROLLBACK was requested.
function withAuditFailureInjected(pool) {
  return {
    async connect() {
      const client = await pool.connect();
      // pg.Pool reuses client objects across connect()/release() cycles, so
      // mutating client.query in place would leak this override into later,
      // unrelated pool.query() calls once this client is released back to
      // the pool. Restore the original on release so the client comes back
      // pristine for its next borrower.
      const originalQuery = client.query.bind(client);
      const originalRelease = client.release.bind(client);
      client.query = async (text, values) => {
        if (typeof text === 'string' && text.startsWith('INSERT INTO audit_events')) {
          throw new Error('simulated audit_events insert failure');
        }
        return originalQuery(text, values);
      };
      client.release = (...args) => { client.query = originalQuery; return originalRelease(...args); };
      return client;
    },
    query: (text, values) => pool.query(text, values)
  };
}

test('revokeOidcIdentityWithAudit commits the revoke and the audit row together, and rolls both back on audit failure', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = await seedHuman(pool, suffix);
  const repository = new PostgresRepository({ pool });
  await repository.createOidcIdentity({ issuer: 'https://idp.example', subject: `sub_${suffix}`, humanId });

  // Failure-injection: audit insert throws -> the UPDATE must not survive.
  const failing = new PostgresRepository({ pool: withAuditFailureInjected(pool) });
  await assert.rejects(() => failing.revokeOidcIdentityWithAudit('https://idp.example', `sub_${suffix}`, { actorHumanId: humanId }));
  const stillActive = await repository.lookupOidcIdentity('https://idp.example', `sub_${suffix}`);
  assert.equal(stillActive.status, 'active');
  const noAudit = await pool.query(`SELECT count(*) FROM audit_events WHERE event_type = 'oidc_identity.revoked'`);
  assert.equal(Number(noAudit.rows[0].count), 0);

  // Success path: both commit together.
  const revoked = await repository.revokeOidcIdentityWithAudit('https://idp.example', `sub_${suffix}`, { actorHumanId: humanId });
  assert.equal(revoked.duplicate, false);
  assert.equal(revoked.status, 'revoked');
  const audit = await pool.query(`SELECT actor_human_id, object_id FROM audit_events WHERE event_type = 'oidc_identity.revoked'`);
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].actor_human_id, humanId);

  // Idempotent replay: no mutation, no second audit row.
  const replay = await repository.revokeOidcIdentityWithAudit('https://idp.example', `sub_${suffix}`, { actorHumanId: humanId });
  assert.equal(replay.duplicate, true);
  const auditAfterReplay = await pool.query(`SELECT count(*) FROM audit_events WHERE event_type = 'oidc_identity.revoked'`);
  assert.equal(Number(auditAfterReplay.rows[0].count), 1);
});

test('unlinkAccountWithAudit commits the unlink and audit together, and rolls both back on audit failure', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = await seedHuman(pool, suffix);
  const repository = new PostgresRepository({ pool });
  await repository.createOidcIdentity({ issuer: 'https://idp.example', subject: `sub_${suffix}`, humanId });
  const ceremonyIssued = new Date(); const ceremonyExpires = new Date(ceremonyIssued.getTime() + 60_000);
  const link = await repository.linkAccount({ linkId: `link_${suffix}`, humanId, issuer: 'https://idp.example', subject: `sub_${suffix}`, nonceHash: `nonce_${suffix}`, stateHash: `state_${suffix}`, issuedAt: ceremonyIssued, expiresAt: ceremonyExpires });
  await pool.query(
    `INSERT INTO human_credentials (credential_id, human_id, type, public_key, status, valid_from, created_at)
     VALUES ($1, $2, 'webauthn', decode('00', 'hex'), 'active', NOW(), NOW())`,
    [`cred_${suffix}`, humanId]
  );

  const failing = new PostgresRepository({ pool: withAuditFailureInjected(pool) });
  await assert.rejects(() => failing.unlinkAccountWithAudit(link.link_id, { actorHumanId: humanId }));
  const stillActive = await pool.query('SELECT status FROM account_links WHERE link_id = $1', [link.link_id]);
  assert.equal(stillActive.rows[0].status, 'active');
  const noAudit = await pool.query(`SELECT count(*) FROM audit_events WHERE event_type = 'account_link.unlinked'`);
  assert.equal(Number(noAudit.rows[0].count), 0);

  const unlinked = await repository.unlinkAccountWithAudit(link.link_id, { actorHumanId: humanId });
  assert.equal(unlinked.duplicate, false);
  assert.equal(unlinked.status, 'unlinked');
  const audit = await pool.query(`SELECT count(*) FROM audit_events WHERE event_type = 'account_link.unlinked'`);
  assert.equal(Number(audit.rows[0].count), 1);

  const replay = await repository.unlinkAccountWithAudit(link.link_id, { actorHumanId: humanId });
  assert.equal(replay.duplicate, true);
  const auditAfterReplay = await pool.query(`SELECT count(*) FROM audit_events WHERE event_type = 'account_link.unlinked'`);
  assert.equal(Number(auditAfterReplay.rows[0].count), 1);
});

test('revokeHumanSessionWithAudit commits the revoke and audit together, and rolls both back on audit failure', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = await seedHuman(pool, suffix);
  const repository = new PostgresRepository({ pool });
  const session = await repository.createHumanSession({ sessionId: `sess_${suffix}`, humanId, authenticationMethod: 'webauthn', assurance: 'high', issuedAt: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2026-01-01T01:00:00Z') });

  const failing = new PostgresRepository({ pool: withAuditFailureInjected(pool) });
  await assert.rejects(() => failing.revokeHumanSessionWithAudit(session.session_id, { actorHumanId: humanId }));
  const stillLive = await pool.query('SELECT revoked_at FROM human_sessions WHERE session_id = $1', [session.session_id]);
  assert.equal(stillLive.rows[0].revoked_at, null);

  const revoked = await repository.revokeHumanSessionWithAudit(session.session_id, { actorHumanId: humanId });
  assert.equal(revoked.duplicate, false);
  assert.ok(revoked.revoked_at);
  const audit = await pool.query(`SELECT count(*) FROM audit_events WHERE event_type = 'human_session.revoked'`);
  assert.equal(Number(audit.rows[0].count), 1);

  const replay = await repository.revokeHumanSessionWithAudit(session.session_id, { actorHumanId: humanId });
  assert.equal(replay.duplicate, true);
  const auditAfterReplay = await pool.query(`SELECT count(*) FROM audit_events WHERE event_type = 'human_session.revoked'`);
  assert.equal(Number(auditAfterReplay.rows[0].count), 1);
});

test('createCapabilityGrantWithAudit commits the grant and audit together, and rolls both back on audit failure', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = await seedHuman(pool, suffix);
  await seedEndpoint(pool, { endpointId: `ep_${suffix}`, humanId });
  const repository = new PostgresRepository({ pool });
  const grantFields = { grantId: `grant_${suffix}`, capability: 'sigil.task/submit', scope: 'sigil.task/submit', grantedTo: `ep_${suffix}`, grantedBy: humanId, expiresAt: new Date(Date.now() + 3600_000) };

  const failing = new PostgresRepository({ pool: withAuditFailureInjected(pool) });
  await assert.rejects(() => failing.createCapabilityGrantWithAudit({ ...grantFields, actorHumanId: humanId }));
  const notCreated = await pool.query('SELECT 1 FROM capability_grants WHERE grant_id = $1', [grantFields.grantId]);
  assert.equal(notCreated.rowCount, 0);

  const grant = await repository.createCapabilityGrantWithAudit({ ...grantFields, actorHumanId: humanId });
  assert.equal(grant.grant_id, grantFields.grantId);
  const audit = await pool.query(`SELECT count(*) FROM audit_events WHERE event_type = 'capability_grant.created'`);
  assert.equal(Number(audit.rows[0].count), 1);
});

test('revokeCapabilityGrantWithAudit commits the revoke, revocation record, and audit together, and rolls all back on audit failure', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = await seedHuman(pool, suffix);
  await seedEndpoint(pool, { endpointId: `ep_${suffix}`, humanId });
  const repository = new PostgresRepository({ pool });
  const grant = await repository.createCapabilityGrant({ grantId: `grant_${suffix}`, capability: 'sigil.task/submit', scope: 'sigil.task/submit', grantedTo: `ep_${suffix}`, grantedBy: humanId, expiresAt: new Date(Date.now() + 3600_000) });

  const failing = new PostgresRepository({ pool: withAuditFailureInjected(pool) });
  await assert.rejects(() => failing.revokeCapabilityGrantWithAudit(grant.grant_id, { revokedBy: humanId, reason: 'test', actorHumanId: humanId }));
  const stillActive = await pool.query('SELECT revoked_at FROM capability_grants WHERE grant_id = $1', [grant.grant_id]);
  assert.equal(stillActive.rows[0].revoked_at, null);
  const noRevocationRecord = await pool.query('SELECT count(*) FROM capability_revocations WHERE capability_grant_id = $1', [grant.grant_id]);
  assert.equal(Number(noRevocationRecord.rows[0].count), 0);

  const revoked = await repository.revokeCapabilityGrantWithAudit(grant.grant_id, { revokedBy: humanId, reason: 'no longer needed', actorHumanId: humanId });
  assert.equal(revoked.duplicate, false);
  assert.ok(revoked.revoked_at);
  const revocationRecord = await pool.query('SELECT count(*) FROM capability_revocations WHERE capability_grant_id = $1', [grant.grant_id]);
  assert.equal(Number(revocationRecord.rows[0].count), 1);
  const audit = await pool.query(`SELECT count(*) FROM audit_events WHERE event_type = 'capability_grant.revoked'`);
  assert.equal(Number(audit.rows[0].count), 1);

  const replay = await repository.revokeCapabilityGrantWithAudit(grant.grant_id, { revokedBy: humanId, reason: 'duplicate call', actorHumanId: humanId });
  assert.equal(replay.duplicate, true);
  const revocationRecordAfterReplay = await pool.query('SELECT count(*) FROM capability_revocations WHERE capability_grant_id = $1', [grant.grant_id]);
  assert.equal(Number(revocationRecordAfterReplay.rows[0].count), 1);
});
