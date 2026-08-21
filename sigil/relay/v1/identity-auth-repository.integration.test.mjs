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
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
async function freshSchema(pool) {
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const sqlFiles = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of sqlFiles) await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
}

async function seedHuman(pool, suffix) {
  const humanId = `usr_${suffix}`;
  await pool.query('INSERT INTO humans (human_id, status, created_at) VALUES ($1, $2, NOW())', [humanId, 'active']);
  return humanId;
}

async function seedEndpoint(pool, { endpointId, humanId, displayName }) {
  await pool.query(
    `INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
     VALUES ($1, $2, 'codex', $3, $4, 'active', NOW())`,
    [endpointId, humanId, `install_${endpointId}`, displayName || `Codex_${endpointId}`]
  );
}

function repo(pool) { return new PostgresRepository({ pool }); }

test('createOidcIdentity + lookupOidcIdentity + revokeOidcIdentity round-trip, and revoke is idempotent', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = await seedHuman(pool, suffix);
  const repository = repo(pool);
  const ceremonyIssued = new Date(); const ceremonyExpires = new Date(ceremonyIssued.getTime() + 60_000);

  const created = await repository.createOidcIdentity({ issuer: 'https://idp.example', subject: `sub_${suffix}`, humanId });
  assert.equal(created.status, 'active');

  const found = await repository.lookupOidcIdentity('https://idp.example', `sub_${suffix}`);
  assert.equal(found.human_id, humanId);

  const revoked = await repository.revokeOidcIdentity('https://idp.example', `sub_${suffix}`);
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.duplicate, false);

  const replay = await repository.revokeOidcIdentity('https://idp.example', `sub_${suffix}`);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.status, 'revoked');

  await assert.rejects(
    () => repository.revokeOidcIdentity('https://idp.example', `sub_missing_${suffix}`),
    { code: 'IDENTITY_UNAVAILABLE' }
  );
});

test('createOidcIdentity rejects a duplicate (issuer, subject) pair at the constraint layer', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = await seedHuman(pool, suffix);
  const repository = repo(pool);
  await repository.createOidcIdentity({ issuer: 'https://idp.example', subject: `sub_${suffix}`, humanId });
  await assert.rejects(
    () => repository.createOidcIdentity({ issuer: 'https://idp.example', subject: `sub_${suffix}`, humanId }),
    { code: '23505' }
  );
});

test('linkAccount requires an existing oidc_identity, and unlinkAccount refuses to leave zero recoverable auth methods', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = await seedHuman(pool, suffix);
  const repository = repo(pool);
  const ceremonyIssued = new Date();
  const ceremonyExpires = new Date(ceremonyIssued.getTime() + 60_000);

  await assert.rejects(
    () => repository.linkAccount({ linkId: `link_${suffix}`, humanId, issuer: 'https://idp.example', subject: `sub_missing_${suffix}`, nonceHash: `nonce_${suffix}`, stateHash: `state_${suffix}`, issuedAt: ceremonyIssued, expiresAt: ceremonyExpires }),
    { code: '23503' }
  );

  await repository.createOidcIdentity({ issuer: 'https://idp.example', subject: `sub_${suffix}`, humanId });
  const link = await repository.linkAccount({ linkId: `link_${suffix}`, humanId, issuer: 'https://idp.example', subject: `sub_${suffix}`, nonceHash: `nonce_${suffix}`, stateHash: `state_${suffix}`, issuedAt: ceremonyIssued, expiresAt: ceremonyExpires });
  assert.equal(link.status, 'active');

  // This human has exactly one auth method (the link just created) and no
  // WebAuthn credential, so unlinking it would leave nobody able to sign in.
  await assert.rejects(
    () => repository.unlinkAccount(`link_${suffix}`),
    { code: 'LOCKOUT_REFUSED' }
  );

  await pool.query(
    `INSERT INTO human_credentials (credential_id, human_id, type, public_key, status, valid_from, created_at)
     VALUES ($1, $2, 'webauthn', decode('00', 'hex'), 'active', NOW(), NOW())`,
    [`cred_${suffix}`, humanId]
  );
  const unlinked = await repository.unlinkAccount(`link_${suffix}`);
  assert.equal(unlinked.status, 'unlinked');
  assert.equal(unlinked.duplicate, false);

  const replay = await repository.unlinkAccount(`link_${suffix}`);
  assert.equal(replay.duplicate, true);

  await assert.rejects(() => repository.unlinkAccount(`link_missing_${suffix}`), { code: 'LINK_UNAVAILABLE' });
});

test('createHumanSession + revokeHumanSession round-trip, revoke is idempotent, and expiry ordering is enforced', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = await seedHuman(pool, suffix);
  const repository = repo(pool);

  const session = await repository.createHumanSession({
    sessionId: `sess_${suffix}`, humanId, authenticationMethod: 'webauthn', assurance: 'high',
    deviceContext: { ua: 'test-agent' }, issuedAt: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2026-01-01T01:00:00Z')
  });
  assert.equal(session.version, 1);
  assert.deepEqual(session.device_context, { ua: 'test-agent' });

  const revoked = await repository.revokeHumanSession(`sess_${suffix}`, { now: new Date('2026-01-01T00:30:00Z') });
  assert.equal(revoked.duplicate, false);
  assert.ok(revoked.revoked_at);

  const replay = await repository.revokeHumanSession(`sess_${suffix}`, { now: new Date('2026-01-01T00:45:00Z') });
  assert.equal(replay.duplicate, true);
  assert.equal(new Date(replay.revoked_at).toISOString(), new Date(revoked.revoked_at).toISOString());

  await assert.rejects(
    () => repository.createHumanSession({ sessionId: `sess_bad_${suffix}`, humanId, authenticationMethod: 'webauthn', assurance: 'high', issuedAt: new Date('2026-01-01T01:00:00Z'), expiresAt: new Date('2026-01-01T00:00:00Z') }),
    { code: '23514' }
  );

  await assert.rejects(() => repository.revokeHumanSession(`sess_missing_${suffix}`), { code: 'SESSION_UNAVAILABLE' });
});

test('issueEndpointToken never persists the plaintext token, and rotateEndpointToken invalidates the old token atomically', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = await seedHuman(pool, suffix);
  await seedEndpoint(pool, { endpointId: `ep_${suffix}`, humanId });
  const repository = repo(pool);

  const issued = await repository.issueEndpointToken({ tokenId: `tok_${suffix}`, endpointId: `ep_${suffix}` });
  assert.equal(typeof issued.token, 'string');
  assert.equal(issued.status, 'active');
  const stored = await pool.query('SELECT token_hash FROM endpoint_tokens WHERE token_id = $1', [`tok_${suffix}`]);
  assert.notEqual(stored.rows[0].token_hash, issued.token);
  assert.equal(stored.rows[0].token_hash, crypto.createHash('sha256').update(issued.token).digest('hex'));

  const rotated = await repository.rotateEndpointToken({ oldTokenId: `tok_${suffix}`, newTokenId: `tok_rotated_${suffix}`, endpointId: `ep_${suffix}` });
  assert.notEqual(rotated.token, issued.token);

  const oldRow = await pool.query('SELECT status FROM endpoint_tokens WHERE token_id = $1', [`tok_${suffix}`]);
  assert.equal(oldRow.rows[0].status, 'revoked');
  const newRow = await pool.query('SELECT status FROM endpoint_tokens WHERE token_id = $1', [`tok_rotated_${suffix}`]);
  assert.equal(newRow.rows[0].status, 'active');
  const audit = await pool.query(`SELECT event_type, endpoint_id FROM audit_events WHERE event_type = 'endpoint_token.rotated' AND endpoint_id = $1`, [`ep_${suffix}`]);
  assert.equal(audit.rowCount, 1);

  // Rotating an already-revoked (or unknown) token must fail closed, not
  // silently mint a replacement.
  await assert.rejects(
    () => repository.rotateEndpointToken({ oldTokenId: `tok_${suffix}`, newTokenId: `tok_second_${suffix}`, endpointId: `ep_${suffix}` }),
    { code: 'TOKEN_UNAVAILABLE' }
  );
  const notMinted = await pool.query('SELECT 1 FROM endpoint_tokens WHERE token_id = $1', [`tok_second_${suffix}`]);
  assert.equal(notMinted.rowCount, 0);
});

test('revokeEndpointToken is scoped to the owning endpoint and emits an audit event', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = await seedHuman(pool, suffix);
  await seedEndpoint(pool, { endpointId: `ep_a_${suffix}`, humanId });
  await seedEndpoint(pool, { endpointId: `ep_b_${suffix}`, humanId });
  const repository = repo(pool);
  await repository.issueEndpointToken({ tokenId: `tok_${suffix}`, endpointId: `ep_a_${suffix}` });

  await assert.rejects(
    () => repository.revokeEndpointToken(`tok_${suffix}`, { endpointId: `ep_b_${suffix}` }),
    { code: 'TOKEN_UNAVAILABLE' }
  );

  const revoked = await repository.revokeEndpointToken(`tok_${suffix}`, { endpointId: `ep_a_${suffix}`, reason: 'compromised' });
  assert.equal(revoked.status, 'revoked');
  const audit = await pool.query(`SELECT reason FROM audit_events WHERE event_type = 'endpoint_token.revoked' AND subject_id = $1`, [`tok_${suffix}`]);
  assert.equal(audit.rows[0].reason, 'compromised');
});

test('createCapabilityGrant + revokeCapabilityGrant writes a capability_revocations record and is idempotent', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = await seedHuman(pool, suffix);
  await seedEndpoint(pool, { endpointId: `ep_${suffix}`, humanId });
  const repository = repo(pool);

  const grant = await repository.createCapabilityGrant({
    grantId: `grant_${suffix}`, capability: 'sigil.task/submit', scope: 'sigil.task/submit',
    purpose: 'task automation', provenance: 'install-flow', issuer: 'https://idp.example',
    grantedTo: `ep_${suffix}`, grantedBy: humanId, expiresAt: new Date(Date.now() + 3600_000)
  });
  assert.equal(grant.subject, `ep_${suffix}`);
  assert.equal(grant.revoked_at, null);

  const revoked = await repository.revokeCapabilityGrant(`grant_${suffix}`, { revokedBy: humanId, reason: 'no longer needed' });
  assert.equal(revoked.duplicate, false);
  assert.ok(revoked.revoked_at);
  const revocationRow = await pool.query('SELECT capability_grant_id, reason FROM capability_revocations WHERE capability_grant_id = $1', [`grant_${suffix}`]);
  assert.equal(revocationRow.rows[0].reason, 'no longer needed');

  const replay = await repository.revokeCapabilityGrant(`grant_${suffix}`, { revokedBy: humanId, reason: 'duplicate call' });
  assert.equal(replay.duplicate, true);
  const revocationCount = await pool.query('SELECT count(*) FROM capability_revocations WHERE capability_grant_id = $1', [`grant_${suffix}`]);
  assert.equal(Number(revocationCount.rows[0].count), 1);

  await assert.rejects(() => repository.revokeCapabilityGrant(`grant_missing_${suffix}`, { revokedBy: humanId, reason: 'x' }), { code: 'GRANT_UNAVAILABLE' });
});

test('recordAuditEvent persists the completed §9 columns alongside the legacy ones', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = await seedHuman(pool, suffix);
  await seedEndpoint(pool, { endpointId: `ep_${suffix}`, humanId });
  const repository = repo(pool);

  const event = await repository.recordAuditEvent({
    eventType: 'capability_grant.created', subjectId: `grant_${suffix}`, actorId: humanId, actorHumanId: humanId,
    endpointId: `ep_${suffix}`, objectType: 'capability_grant', objectId: `grant_${suffix}`,
    outcome: 'success', reason: null, payload: { scope: 'sigil.task/submit' }
  });
  assert.equal(event.event_type, 'capability_grant.created');
  const stored = await pool.query('SELECT actor_human_id, endpoint_id, object_type, object_id, outcome FROM audit_events WHERE event_id = $1', [event.event_id]);
  assert.deepEqual(stored.rows[0], { actor_human_id: humanId, endpoint_id: `ep_${suffix}`, object_type: 'capability_grant', object_id: `grant_${suffix}`, outcome: 'success' });
});

test('createEndpointWithAudit creates the endpoint, its key, and an audit row in one transaction, and rejects a display-name collision for the same owner', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await freshSchema(pool);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = await seedHuman(pool, suffix);
  const repository = repo(pool);
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });

  const created = await repository.createEndpointWithAudit({
    endpointId: `ep_${suffix}`, ownerId: humanId, installationId: `install_${suffix}`,
    runtime: 'codex', displayName: 'Codex', keyId: `key_${suffix}`, publicKey: publicKeyDer,
  });
  assert.equal(created.endpoint_id, `ep_${suffix}`);
  assert.equal(created.display_name, 'Codex');

  const keyRow = await pool.query('SELECT key_id, endpoint_id, status FROM endpoint_keys WHERE endpoint_id = $1', [`ep_${suffix}`]);
  assert.deepEqual(keyRow.rows, [{ key_id: `key_${suffix}`, endpoint_id: `ep_${suffix}`, status: 'active' }]);

  const audit = await pool.query('SELECT event_type, subject_id, actor_id FROM audit_events WHERE subject_id = $1', [`ep_${suffix}`]);
  assert.deepEqual(audit.rows, [{ event_type: 'endpoint.created', subject_id: `ep_${suffix}`, actor_id: humanId }]);

  // Same owner, colliding (case/whitespace-insensitive) display name -> DISPLAY_NAME_COLLISION,
  // and the failed attempt must not have inserted a stray key or audit row.
  await assert.rejects(
    () => repository.createEndpointWithAudit({
      endpointId: `ep_collide_${suffix}`, ownerId: humanId, installationId: `install_collide_${suffix}`,
      runtime: 'codex', displayName: '  codex  ', keyId: `key_collide_${suffix}`, publicKey: publicKeyDer,
    }),
    { code: 'DISPLAY_NAME_COLLISION' }
  );
  const strayKey = await pool.query('SELECT 1 FROM endpoint_keys WHERE key_id = $1', [`key_collide_${suffix}`]);
  assert.equal(strayKey.rowCount, 0);
  const strayEndpoint = await pool.query('SELECT 1 FROM endpoints WHERE endpoint_id = $1', [`ep_collide_${suffix}`]);
  assert.equal(strayEndpoint.rowCount, 0);

  // A different owner may still use the same display name.
  const otherHumanId = await seedHuman(pool, `${suffix}_other`);
  const otherOwnerCreated = await repository.createEndpointWithAudit({
    endpointId: `ep_other_${suffix}`, ownerId: otherHumanId, installationId: `install_other_${suffix}`,
    runtime: 'codex', displayName: 'Codex', keyId: `key_other_${suffix}`, publicKey: publicKeyDer,
  });
  assert.equal(otherOwnerCreated.endpoint_id, `ep_other_${suffix}`);
});
