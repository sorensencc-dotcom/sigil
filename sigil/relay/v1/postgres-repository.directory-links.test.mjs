// sigil/relay/v1/postgres-repository.directory-links.test.mjs
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

test('directory link confirmation, revocation, and lookup', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  const ids = { a: `usr_a_${suffix}`, b: `usr_b_${suffix}`, outsider: `usr_outsider_${suffix}`, epA: `ep_a_${suffix}`, epB: `ep_b_${suffix}` };
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.a}', 'active', NOW()), ('${ids.b}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.epA}', '${ids.a}', 'claude', 'install_a', 'A', 'active', NOW()),
             ('${ids.epB}', '${ids.b}', 'codex', 'install_b', 'B', 'active', NOW());
  `);
  const repository = new PostgresRepository({ pool });
  const now = new Date('2026-08-21T00:00:00Z');
  const invite = await repository.createDirectoryInvite({ issuerEndpointId: ids.epA, issuerHumanId: ids.a, expiresAt: new Date(now.getTime() + 60 * 60 * 1000), homeRelay: 'relay.local', now });
  const { link_id: linkId } = await repository.redeemDirectoryInvite({ code: invite.code, redeemerEndpointId: ids.epB, redeemerHumanId: ids.b, homeRelay: 'relay.local', now });

  // ids.b (the redeemer) already auto-confirmed as part of
  // redeemDirectoryInvite (Task 3; spec section on link activation) --
  // confirmed live against Postgres: b_confirmed_at was already set on the
  // row before this call. Re-confirming with ids.b is therefore a
  // legitimate idempotent no-op (verified separately below), not an
  // actor-mismatch case. The actor-mismatch check needs a human who is
  // genuinely not a party to this link at all.
  await assert.rejects(
    () => repository.confirmDirectoryLink({ linkId, confirmingHumanId: ids.outsider, now }),
    { code: 'CONFIRMATION_ACTOR_MISMATCH' }
  );

  // Idempotent no-op: ids.b already confirmed at redemption time, so
  // re-confirming with the same human must return the current status
  // rather than erroring or double-writing.
  const reconfirmed = await repository.confirmDirectoryLink({ linkId, confirmingHumanId: ids.b, now });
  assert.equal(reconfirmed.status, 'pending');

  const confirmed = await repository.confirmDirectoryLink({ linkId, confirmingHumanId: ids.a, now });
  assert.equal(confirmed.status, 'active');

  const noneBeforeConfirm = await pool.connect();
  try {
    const found = await repository.lookupActiveDirectoryLink(ids.epA, ids.epB, noneBeforeConfirm);
    assert.equal(found.link_id, linkId);
    const reversed = await repository.lookupActiveDirectoryLink(ids.epB, ids.epA, noneBeforeConfirm);
    assert.equal(reversed.link_id, linkId);
  } finally { noneBeforeConfirm.release(); }

  const revoked = await repository.revokeDirectoryLink({ linkId, revokingHumanId: ids.b, now });
  assert.equal(revoked.status, 'revoked');

  const afterRevoke = await pool.connect();
  try {
    const gone = await repository.lookupActiveDirectoryLink(ids.epA, ids.epB, afterRevoke);
    assert.equal(gone, null);
  } finally { afterRevoke.release(); }
});

test('confirmed_by attribution is correct when the redeemer/nominee endpoint sorts before the issuer endpoint', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  // Issuer endpoint ('ep_z_...') deliberately sorts AFTER the
  // redeemer/nominee endpoint ('ep_a_...') lexicographically -- the inverse
  // of every other test in this file, which masked a real bug where
  // a_confirmed_by/b_confirmed_by were computed relative to "is this the
  // issuer's side" instead of "did this side actually confirm."
  const ids = {
    issuer: `usr_issuer_${suffix}`, redeemer: `usr_redeemer_${suffix}`, nominee: `usr_nominee_${suffix}`,
    epIssuer: `ep_z_issuer_${suffix}`, epRedeemer: `ep_a_redeemer_${suffix}`, epNominee: `ep_a_nominee_${suffix}`
  };
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.issuer}', 'active', NOW()), ('${ids.redeemer}', 'active', NOW()), ('${ids.nominee}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.epIssuer}', '${ids.issuer}', 'claude', 'install_issuer', 'Issuer', 'active', NOW()),
             ('${ids.epRedeemer}', '${ids.redeemer}', 'codex', 'install_redeemer', 'Redeemer', 'active', NOW()),
             ('${ids.epNominee}', '${ids.nominee}', 'codex', 'install_nominee', 'Nominee', 'active', NOW());
    INSERT INTO oidc_issuer_allowlist (issuer, display_label, added_at)
      VALUES ('https://issuer.example', 'Test Issuer', NOW());
  `);
  const repository = new PostgresRepository({ pool });
  const now = new Date('2026-08-21T00:00:00Z');

  // Invite path.
  const invite = await repository.createDirectoryInvite({ issuerEndpointId: ids.epIssuer, issuerHumanId: ids.issuer, expiresAt: new Date(now.getTime() + 60 * 60 * 1000), homeRelay: 'relay.local', now });
  const redeemed = await repository.redeemDirectoryInvite({ code: invite.code, redeemerEndpointId: ids.epRedeemer, redeemerHumanId: ids.redeemer, homeRelay: 'relay.local', now });
  const inviteLinkRow = await pool.query('SELECT endpoint_a, endpoint_b, a_confirmed_at, b_confirmed_at, a_confirmed_by, b_confirmed_by FROM directory_links WHERE link_id = $1', [redeemed.link_id]);
  const inviteRow = inviteLinkRow.rows[0];
  assert.equal(inviteRow.endpoint_a, ids.epRedeemer, 'redeemer endpoint sorts first');
  assert.equal(inviteRow.endpoint_b, ids.epIssuer, 'issuer endpoint sorts second');
  assert.notEqual(inviteRow.a_confirmed_at, null);
  assert.equal(inviteRow.b_confirmed_at, null);
  assert.equal(inviteRow.a_confirmed_by, ids.redeemer, 'the side that actually confirmed (redeemer) must be attributed to the redeemer, not the issuer');
  assert.equal(inviteRow.b_confirmed_by, null, 'the unconfirmed side must not carry a confirmed_by value');

  // OIDC-match path.
  const request = await repository.createDirectoryMatchRequest({ issuerEndpointId: ids.epIssuer, issuerHumanId: ids.issuer, issuer: 'https://issuer.example', matchTarget: `hash_${suffix}`, expiresAt: new Date(now.getTime() + 60 * 60 * 1000), homeRelay: 'relay.local', now });
  await repository.claimDirectoryMatch({ issuer: 'https://issuer.example', matchTarget: `hash_${suffix}`, matchedHumanId: ids.nominee, now });
  const nominated = await repository.nominateDirectoryLinkEndpoint({ requestId: request.request_id, nominatedEndpointId: ids.epNominee, nominatedHumanId: ids.nominee, homeRelay: 'relay.local', now });
  const matchLinkRow = await pool.query('SELECT endpoint_a, endpoint_b, a_confirmed_at, b_confirmed_at, a_confirmed_by, b_confirmed_by FROM directory_links WHERE link_id = $1', [nominated.link_id]);
  const matchRow = matchLinkRow.rows[0];
  assert.equal(matchRow.endpoint_a, ids.epNominee, 'nominee endpoint sorts first');
  assert.equal(matchRow.endpoint_b, ids.epIssuer, 'issuer endpoint sorts second');
  assert.notEqual(matchRow.a_confirmed_at, null);
  assert.equal(matchRow.b_confirmed_at, null);
  assert.equal(matchRow.a_confirmed_by, ids.nominee, 'the side that actually confirmed (nominee) must be attributed to the nominee, not the issuer');
  assert.equal(matchRow.b_confirmed_by, null, 'the unconfirmed side must not carry a confirmed_by value');
});
