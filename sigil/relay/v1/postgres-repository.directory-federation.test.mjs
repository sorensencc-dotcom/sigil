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

test('partial unique index blocks second live link and allows a new row once prior is revoked', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await applyMigrations(connectionString);
  const repo = new PostgresRepository({ pool });
  const firstRef = crypto.randomUUID();
  const secondRef = crypto.randomUUID();
  const thirdRef = crypto.randomUUID();

  await repo.withTransaction((c) => repo.createFederationDirectoryLink({
    linkRef: firstRef, localOwnerId: 'usr_owner1@a.example', localEndpointId: 'ep_1@a.example',
    remoteOwnerId: 'usr_owner2@b.example', remoteEndpointId: 'ep_2@b.example', remoteDomain: 'b.example',
    role: 'issuer', status: 'pending', localConfirmedAt: null, remoteConfirmedAt: null,
    sourceInviteId: null, peerDomain: 'b.example',
  }, c));

  // Second pending/active row for same owner pair is blocked by partial unique index
  await assert.rejects(
    repo.withTransaction((c) => repo.createFederationDirectoryLink({
      linkRef: secondRef, localOwnerId: 'usr_owner1@a.example', localEndpointId: 'ep_1b@a.example',
      remoteOwnerId: 'usr_owner2@b.example', remoteEndpointId: 'ep_2b@b.example', remoteDomain: 'b.example',
      role: 'issuer', status: 'active', localConfirmedAt: new Date(), remoteConfirmedAt: new Date(),
      sourceInviteId: null, peerDomain: 'b.example',
    }, c)),
    (e) => e.code === 'FEDERATION_LINK_EXISTS',
  );

  // Revoke first row -> status becomes 'revoked'
  await repo.revokeFederationDirectoryLink(firstRef, 'local', new Date(), pool);

  // Now a new row for the same owner pair is allowed
  const third = await repo.withTransaction((c) => repo.createFederationDirectoryLink({
    linkRef: thirdRef, localOwnerId: 'usr_owner1@a.example', localEndpointId: 'ep_1c@a.example',
    remoteOwnerId: 'usr_owner2@b.example', remoteEndpointId: 'ep_2c@b.example', remoteDomain: 'b.example',
    role: 'issuer', status: 'pending', localConfirmedAt: null, remoteConfirmedAt: null,
    sourceInviteId: null, peerDomain: 'b.example',
  }, c));
  assert.equal(third.link_ref, thirdRef);

  await pool.query(`DELETE FROM federation_directory_links WHERE local_owner_id = 'usr_owner1@a.example'`);
});

test('concurrent redemption posts for one invite -> exactly one 202+link, one 202-idempotent, and provably serializes on the invite row lock', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await applyMigrations(connectionString);

  const { acceptDirectoryRedemption } = await import('./accept-federation-directory.mjs');

  const linkRef = crypto.randomUUID();
  const segment = 'SECRET_SEGMENT_CONCURRENT';
  const codeHash = crypto.createHash('sha256').update(segment).digest('hex');

  // Instrumented subclass: sleeps AFTER the real `getFederationDirectoryInviteByRef`
  // query returns, before handing the row back to the caller. The Postgres row
  // lock (when `forUpdate: true` is passed by accept-federation-directory.mjs) is
  // acquired by the SELECT itself, not by this JS continuation, so the lock
  // holder keeps it for the whole sleep -- its owning transaction stays open and
  // uncommitted throughout. If the second concurrent transaction's own
  // `FOR UPDATE` SELECT genuinely blocks on that lock, the two sleeps cannot
  // overlap and total wall-clock time must be >= ~2x DELAY_MS. Without the lock,
  // both SELECTs return immediately and their sleeps run concurrently, so total
  // time stays close to ~1x DELAY_MS. This is the test's proof of real lock
  // contention -- it would fail if `forUpdate: true` were removed from the
  // `getFederationDirectoryInviteByRef` call site in accept-federation-directory.mjs.
  const DELAY_MS = 300;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  class InstrumentedRepo extends PostgresRepository {
    async getFederationDirectoryInviteByRef(...args) {
      const row = await super.getFederationDirectoryInviteByRef(...args);
      await sleep(DELAY_MS);
      return row;
    }
  }
  const repo = new InstrumentedRepo({ pool });
  // Rate-limit reservation (`quota_usage` upsert, keyed by scope+window) also
  // serializes two same-peer-domain concurrent requests, independent of the
  // invite row lock this test targets. Disable it here so timing isolates the
  // invite lock alone -- an own-property `undefined` shadows the inherited
  // method, so `typeof repository.reserveRateLimit === 'function'` is false
  // and acceptDirectoryRedemption's rate-limit branch is skipped entirely.
  repo.reserveRateLimit = undefined;

  await repo.createFederationDirectoryInvite({
    linkRef, issuerEndpointId: 'ep_codex@a.example', issuerOwnerId: 'usr_chris@a.example',
    peerDomain: 'b.example', codeHash, expiresAt: new Date(Date.now() + 3600_000), now: new Date(),
  }, pool);

  const ctxFor = (txClient) => ({
    repository: repo,
    client: txClient,
    originDomain: 'b.example',
    relayDomain: 'a.example',
    now: new Date(),
    request_id: crypto.randomUUID(),
  });

  const parsedBody = {
    code: `sigil-fed-invite:a.example:${linkRef}:${segment}`,
    link_ref: linkRef,
    redeemer: { owner_id: 'usr_bob@b.example', endpoint_id: 'ep_c@b.example' },
    redeemer_domain: 'b.example',
    requested_at: new Date().toISOString(),
  };

  // Run two concurrent acceptDirectoryRedemption calls inside transactions,
  // timing each to completion (post-commit) so we can measure serialization.
  const t0 = Date.now();
  const timestamps = {};
  const [res1, res2] = await Promise.all([
    repo.withTransaction((c1) => acceptDirectoryRedemption(parsedBody, ctxFor(c1)))
      .then((r) => { timestamps.a = Date.now() - t0; return r; }),
    repo.withTransaction((c2) => acceptDirectoryRedemption(parsedBody, ctxFor(c2)))
      .then((r) => { timestamps.b = Date.now() - t0; return r; }),
  ]);

  // Both return 202 (one first-time success, one idempotent replay)
  assert.equal(res1.status, 202);
  assert.equal(res2.status, 202);
  assert.equal(res1.body.link_ref, linkRef);
  assert.equal(res2.body.link_ref, linkRef);

  // Proof of real lock contention: see comment above InstrumentedRepo.
  const laterFinish = Math.max(timestamps.a, timestamps.b);
  assert.ok(
    laterFinish >= DELAY_MS * 1.8,
    `expected serialized completion >= ${DELAY_MS * 1.8}ms (proves the invite row's FOR UPDATE lock blocked the second transaction's read), got ${laterFinish}ms -- the two invite reads ran concurrently instead of being serialized by a row lock`,
  );

  // Assert exactly one link row in the database
  const links = await pool.query('SELECT * FROM federation_directory_links WHERE link_ref = $1', [linkRef]);
  assert.equal(links.rows.length, 1);

  await pool.query('DELETE FROM federation_directory_links WHERE link_ref = $1', [linkRef]);
  await pool.query('DELETE FROM federation_directory_invites WHERE link_ref = $1', [linkRef]);
});

test('federation_outbox.kind is back-compatible: legacy envelope rows read and drain unchanged', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await applyMigrations(connectionString);
  const repo = new PostgresRepository({ pool });

  const { runFederationReaperPass } = await import('./federation-reaper.mjs');

  const messageId = `msg_${crypto.randomUUID()}`;
  const idemKey = `idem_${crypto.randomUUID()}`;
  const envelope = {
    protocol: 'sigil/1',
    message_id: messageId,
    conversation_id: `conv_${crypto.randomUUID()}`,
    message_type: 'chat.message',
    sender: { owner_id: 'usr_a@a.example', endpoint_id: 'ep_a@a.example', kind: 'agent' },
    recipient: { owner_id: 'usr_b@b.example', endpoint_id: 'ep_b@b.example', kind: 'agent' },
    body: { text: 'legacy test' },
    context_refs: [],
    capabilities: [],
    idempotency_key: idemKey,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    signature: { algorithm: 'Ed25519', key_id: 'key_a', value: 'dummy' },
  };

  // Insert a legacy row with kind defaulted (omitted in INSERT)
  await pool.query(
    `INSERT INTO federation_outbox
       (message_id, idempotency_key, recipient_domain, origin_domain,
        envelope, sender_key, sender_owner_id, next_attempt_at, created_at, updated_at)
     VALUES ($1, $2, 'b.example', 'a.example', $3, $4, 'usr_a@a.example', now(), now(), now())`,
    [messageId, idemKey, JSON.stringify(envelope), JSON.stringify({ kid: 'key_a', alg: 'Ed25519', publicKey: 'AAAA' })],
  );

  // Pin peer b.example
  await repo.upsertPeer({
    domain: 'b.example',
    relayUrl: 'https://b.example/relay',
    keys: [{ kid: 'key_b', alg: 'Ed25519', publicKey: 'BBBB' }],
    trustMode: 'tofu',
  });

  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const identity = {
    key_id: 'key_a_relay',
    private_key_pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };

  let posted = false;
  const counts = await runFederationReaperPass({
    repository: repo,
    identity,
    originDomain: 'a.example',
    now: new Date(),
    postForwardImpl: async (peer, canonicalBytes, signed) => {
      posted = true;
      return { ok: true, status: 202 };
    },
  });

  assert.equal(posted, true);
  assert.equal(counts.forwarded, 1);

  const row = await repo.getFederationOutboxRow((await pool.query('SELECT id FROM federation_outbox WHERE message_id = $1', [messageId])).rows[0].id);
  assert.equal(row.state, 'forwarded');
  assert.equal(row.kind, 'envelope');

  await pool.query('DELETE FROM federation_outbox WHERE message_id = $1', [messageId]);
  await pool.query("DELETE FROM peer_relays WHERE domain = 'b.example'");
});

test('getActiveFederationDirectoryLink returns a row only in active state', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await applyMigrations(connectionString);
  const repo = new PostgresRepository({ pool });

  const localOwner = 'usr_active_test_a@a.example';
  const remoteOwner = 'usr_active_test_b@b.example';
  const remoteDomain = 'b.example';

  for (const status of ['pending', 'revoked', 'expired']) {
    const linkRef = crypto.randomUUID();
    await pool.query(
      `INSERT INTO federation_directory_links
         (id, link_ref, local_owner_id, local_endpoint_id, remote_owner_id, remote_endpoint_id, remote_domain, role, status, peer_domain, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'ep_a@a.example', $3, 'ep_b@b.example', $4, 'issuer', $5, $4, now(), now())`,
      [linkRef, localOwner, remoteOwner, remoteDomain, status],
    );
    const hit = await repo.getActiveFederationDirectoryLink(localOwner, remoteOwner, remoteDomain);
    assert.equal(hit, null, `expected null for status ${status}`);
    await pool.query('DELETE FROM federation_directory_links WHERE link_ref = $1', [linkRef]);
  }

  // Active status returns the row
  const activeRef = crypto.randomUUID();
  await pool.query(
    `INSERT INTO federation_directory_links
       (id, link_ref, local_owner_id, local_endpoint_id, remote_owner_id, remote_endpoint_id, remote_domain, role, status, peer_domain, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'ep_a@a.example', $3, 'ep_b@b.example', $4, 'issuer', 'active', $4, now(), now())`,
    [activeRef, localOwner, remoteOwner, remoteDomain],
  );
  const activeHit = await repo.getActiveFederationDirectoryLink(localOwner, remoteOwner, remoteDomain);
  assert.ok(activeHit);
  assert.equal(activeHit.link_ref, activeRef);
  assert.equal(activeHit.status, 'active');

  await pool.query('DELETE FROM federation_directory_links WHERE link_ref = $1', [activeRef]);
});

test('findLiveFederationDirectoryLinkForPair finds pending/active and ignores revoked/expired in Postgres', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await applyMigrations(connectionString);
  const repo = new PostgresRepository({ pool });

  const localOwner = 'usr_pair_a@a.example';
  const remoteOwner = 'usr_pair_b@b.example';
  const remoteDomain = 'b.example';

  for (const status of ['pending', 'active']) {
    const linkRef = crypto.randomUUID();
    await pool.query(
      `INSERT INTO federation_directory_links
         (id, link_ref, local_owner_id, local_endpoint_id, remote_owner_id, remote_endpoint_id, remote_domain, role, status, peer_domain, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'ep_a@a.example', $3, 'ep_b@b.example', $4, 'issuer', $5, $4, now(), now())`,
      [linkRef, localOwner, remoteOwner, remoteDomain, status],
    );
    const hit = await repo.findLiveFederationDirectoryLinkForPair(localOwner, remoteOwner, remoteDomain);
    assert.ok(hit, `expected hit for status ${status}`);
    assert.equal(hit.link_ref, linkRef);
    assert.equal(hit.status, status);
    await pool.query('DELETE FROM federation_directory_links WHERE link_ref = $1', [linkRef]);
  }

  for (const status of ['revoked', 'expired']) {
    const linkRef = crypto.randomUUID();
    await pool.query(
      `INSERT INTO federation_directory_links
         (id, link_ref, local_owner_id, local_endpoint_id, remote_owner_id, remote_endpoint_id, remote_domain, role, status, peer_domain, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'ep_a@a.example', $3, 'ep_b@b.example', $4, 'issuer', $5, $4, now(), now())`,
      [linkRef, localOwner, remoteOwner, remoteDomain, status],
    );
    const hit = await repo.findLiveFederationDirectoryLinkForPair(localOwner, remoteOwner, remoteDomain);
    assert.equal(hit, null, `expected null for status ${status}`);
    await pool.query('DELETE FROM federation_directory_links WHERE link_ref = $1', [linkRef]);
  }
});

test('a directory row with null directory_payload is rejected by 018 CHECK constraint', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await applyMigrations(connectionString);

  await assert.rejects(
    pool.query(
      `INSERT INTO federation_outbox
         (message_id, idempotency_key, recipient_domain, origin_domain, kind, directory_payload, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, 'b.example', 'a.example', 'directory_redemption', NULL, now(), now(), now())`,
      [`msg_${crypto.randomUUID()}`, `idem_${crypto.randomUUID()}`],
    ),
    /check constraint|federation_outbox_directory_payload_present_check/i,
  );
});

test('createFederationDirectoryLink writes a self_pair row with equal owners', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  const repo = new PostgresRepository({ pool });
  t.after(() => pool.end());
  await applyMigrations(connectionString, { reset: true });
  const linkRef = crypto.randomUUID();
  const row = await repo.createFederationDirectoryLink({
    linkRef, localOwnerId: 'usr_x@home.example', localEndpointId: 'ep_a@home.example',
    remoteOwnerId: 'usr_x@home.example', remoteEndpointId: 'ep_b@home.example',
    remoteDomain: 'a.example', role: 'issuer', initiatedVia: 'self_pair', status: 'active',
    localConfirmedAt: new Date(), remoteConfirmedAt: new Date(), sourceInviteId: null, peerDomain: 'a.example',
  });
  assert.equal(row.local_owner_id, row.remote_owner_id);
});

