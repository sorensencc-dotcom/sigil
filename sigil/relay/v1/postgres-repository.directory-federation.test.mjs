import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { PostgresRepository } from './postgres-repository.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('018 applies clean and creates the directory tables + outbox kind column', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await applyMigrations(connectionString, { reset: true });
  await applyMigrations(connectionString); // re-run must be a no-op

  const invites = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'federation_directory_invites'`);
  assert.ok(invites.rows.some((r) => r.column_name === 'link_ref'));
  assert.ok(invites.rows.some((r) => r.column_name === 'code_hash'));

  const links = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'federation_directory_links'`);
  assert.ok(links.rows.some((r) => r.column_name === 'local_confirmed_at'));
  assert.ok(links.rows.some((r) => r.column_name === 'remote_confirmed_at'));

  const outboxKind = await pool.query(`SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'federation_outbox' AND column_name = 'kind'`);
  assert.equal(outboxKind.rows[0].is_nullable, 'NO');
  assert.match(outboxKind.rows[0].column_default, /'envelope'/);

  const envNullable = await pool.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'federation_outbox' AND column_name = 'envelope'`);
  assert.equal(envNullable.rows[0].is_nullable, 'YES');

  await pool.query(`INSERT INTO federation_directory_links
    (id, link_ref, local_owner_id, local_endpoint_id, remote_owner_id, remote_endpoint_id, remote_domain, role, status, peer_domain, created_at, updated_at)
    VALUES (gen_random_uuid(), gen_random_uuid(), 'usr_a@a.example', 'ep_a@a.example', 'usr_b@b.example', 'ep_b@b.example', 'b.example', 'issuer', 'pending', 'b.example', now(), now())`);
  await assert.rejects(
    pool.query(`INSERT INTO federation_directory_links
      (id, link_ref, local_owner_id, local_endpoint_id, remote_owner_id, remote_endpoint_id, remote_domain, role, status, peer_domain, created_at, updated_at)
      VALUES (gen_random_uuid(), gen_random_uuid(), 'usr_a@a.example', 'ep_a2@a.example', 'usr_b@b.example', 'ep_b2@b.example', 'b.example', 'issuer', 'active', 'b.example', now(), now())`),
    /unique|duplicate key/i,
  );
  await pool.query(`DELETE FROM federation_directory_links WHERE local_owner_id = 'usr_a@a.example'`);
});

test('invite create -> getByRef -> lazy expire -> revoke', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await applyMigrations(connectionString);
  const repo = new PostgresRepository({ pool });
  const linkRef = crypto.randomUUID();

  await repo.withTransaction((c) => repo.createFederationDirectoryInvite({
    linkRef, issuerEndpointId: 'ep_codex@a.example', issuerOwnerId: 'usr_chris@a.example',
    peerDomain: 'b.example', codeHash: 'HASH', expiresAt: new Date(Date.now() + 3600_000), now: new Date(),
  }, c));

  const row = await repo.getFederationDirectoryInviteByRef(linkRef, pool, {});
  assert.equal(row.status, 'pending');
  assert.equal(row.peer_domain, 'b.example');

  // force expiry, then getByRef must lazily transition
  await pool.query(`UPDATE federation_directory_invites SET expires_at = now() - interval '1 hour' WHERE link_ref = $1`, [linkRef]);
  const expired = await repo.getFederationDirectoryInviteByRef(linkRef, pool, {});
  assert.equal(expired.status, 'expired');

  const revoke = await repo.revokeFederationDirectoryInvite(linkRef, new Date(), pool);
  assert.equal(revoke.updated, 0); // already terminal (expired)
  await pool.query(`DELETE FROM federation_directory_invites WHERE link_ref = $1`, [linkRef]);
});

test('invite redeem + list omits code_hash', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await applyMigrations(connectionString);
  const repo = new PostgresRepository({ pool });
  const linkRef = crypto.randomUUID();

  const { invite_id } = await repo.createFederationDirectoryInvite({
    linkRef, issuerEndpointId: 'ep_codex@a.example', issuerOwnerId: 'usr_lister@a.example',
    peerDomain: 'b.example', codeHash: 'SECRET', expiresAt: new Date(Date.now() + 3600_000), now: new Date(),
  }, pool);

  await repo.markFederationDirectoryInviteRedeemed(
    invite_id, { owner_id: 'usr_peer@b.example', endpoint_id: 'ep_peer@b.example' }, new Date(), pool,
  );
  const redeemed = await repo.getFederationDirectoryInviteByRef(linkRef, pool, {});
  assert.equal(redeemed.status, 'redeemed');
  assert.equal(redeemed.redeemed_by_owner_id, 'usr_peer@b.example');
  assert.equal(redeemed.redeemed_by_endpoint_id, 'ep_peer@b.example');
  assert.ok(redeemed.redeemed_at);

  const listed = await repo.listFederationDirectoryInvites({ issuerOwnerId: 'usr_lister@a.example' });
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]).sort(), ['expires_at', 'link_ref', 'peer_domain', 'status']);
  assert.equal(listed[0].link_ref, linkRef);

  const revoke = await repo.revokeFederationDirectoryInvite(linkRef, new Date(), pool);
  assert.equal(revoke.updated, 0); // already redeemed -> terminal
  await pool.query(`DELETE FROM federation_directory_invites WHERE link_ref = $1`, [linkRef]);
});

test('link create -> confirm CAS -> revoke-wins race -> getActive', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await applyMigrations(connectionString);
  const repo = new PostgresRepository({ pool });
  const linkRef = crypto.randomUUID();
  await repo.withTransaction((c) => repo.createFederationDirectoryLink({
    linkRef, localOwnerId: 'usr_chris@a.example', localEndpointId: 'ep_codex@a.example',
    remoteOwnerId: 'usr_bob@b.example', remoteEndpointId: 'ep_c@b.example', remoteDomain: 'b.example',
    role: 'issuer', status: 'pending', localConfirmedAt: null, remoteConfirmedAt: new Date(),
    sourceInviteId: null, peerDomain: 'b.example',
  }, c));

  // second live link for the same pair -> typed FEDERATION_LINK_EXISTS
  await assert.rejects(
    repo.withTransaction((c) => repo.createFederationDirectoryLink({
      linkRef: crypto.randomUUID(), localOwnerId: 'usr_chris@a.example', localEndpointId: 'ep_x@a.example',
      remoteOwnerId: 'usr_bob@b.example', remoteEndpointId: 'ep_y@b.example', remoteDomain: 'b.example',
      role: 'issuer', status: 'pending', localConfirmedAt: null, remoteConfirmedAt: new Date(),
      sourceInviteId: null, peerDomain: 'b.example',
    }, c)),
    (e) => e.code === 'FEDERATION_LINK_EXISTS' && e.existingLinkRef === linkRef,
  );

  const set = await repo.setFederationDirectoryLinkConfirmation(linkRef, 'local', new Date(), pool);
  assert.deepEqual(set, { updated: 1, activated: true });

  const active = await repo.getActiveFederationDirectoryLink('usr_chris@a.example', 'usr_bob@b.example', 'b.example', pool);
  assert.equal(active?.link_ref, linkRef);

  // revoke wins: after revoke, a late confirmation CAS updates nothing
  await repo.revokeFederationDirectoryLink(linkRef, 'local', new Date(), pool);
  const late = await repo.setFederationDirectoryLinkConfirmation(linkRef, 'remote', new Date(), pool);
  assert.equal(late.updated, 0);
  const afterRevoke = await repo.getActiveFederationDirectoryLink('usr_chris@a.example', 'usr_bob@b.example', 'b.example', pool);
  assert.equal(afterRevoke, null);

  await pool.query(`DELETE FROM federation_directory_links WHERE link_ref = $1`, [linkRef]);
});
