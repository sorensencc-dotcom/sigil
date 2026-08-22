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
