import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { PostgresRepository } from './postgres-repository.mjs';
import { acceptDirectoryRedemption } from './accept-federation-directory.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Repository/transaction-layer property only. This does NOT exercise a
// directory handler: it throws a synthetic error inside `withTransaction` to
// prove the plain tx semantics -- an INSERT of the nonce is rolled back with
// everything else when the transaction aborts. The handlers' actual rejection
// shape is the subject of the second test below, and it is different.
test('repo tx semantics: an aborted transaction rolls the consumeRelayNonce insert back', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  const repo = new PostgresRepository({ pool });
  t.after(() => pool.end());
  await applyMigrations(connectionString, { reset: true });

  const nonce = 'ROLLBACK_00000000000000';
  await assert.rejects(repo.withTransaction(async (client) => {
    await repo.consumeRelayNonce(nonce, { expiresAt: new Date(Date.now() + 300_000), client });
    throw Object.assign(new Error('link exists'), { code: 'FEDERATION_LINK_EXISTS' });
  }), (error) => error.code === 'FEDERATION_LINK_EXISTS');

  // a later request with the SAME nonce is accepted, because the first tx rolled back
  await repo.withTransaction(async (client) => {
    await repo.consumeRelayNonce(nonce, { expiresAt: new Date(Date.now() + 300_000), client });
  });

  // and the committed one IS burned: a third attempt is a genuine replay
  await assert.rejects(repo.withTransaction(async (client) => {
    await repo.consumeRelayNonce(nonce, { expiresAt: new Date(Date.now() + 300_000), client });
  }), (error) => error.code === 'RELAY_REPLAYED');
});

// The honest counterpart. The route (http-server.mjs) consumes the nonce as the
// first statement of `withTransaction`, then calls the handler. But the
// handlers RETURN their rejections (409 / 403 / 429 / 400) instead of throwing,
// so the transaction COMMITS on a rejection and the nonce IS burned. Only an
// unexpected re-thrown driver error aborts the transaction and reaches the
// rollback property above.
//
// That means "a rejection does not burn the nonce" holds for roughly one of six
// rejection paths. Functional impact is low -- the CLI mints a fresh nonce per
// send, so a retry is never the same nonce -- but the guarantee must be
// recorded as it actually is, not as the rollback test's name implies.
test('route reality: a handler-returned 409 COMMITS the transaction and burns the nonce', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  const repo = new PostgresRepository({ pool });
  t.after(() => pool.end());
  await applyMigrations(connectionString, { reset: true });

  const RELAY_DOMAIN = 'issuer.example';
  const PEER_DOMAIN = 'redeemer.example';
  const issuerOwner = `usr_issuer@${RELAY_DOMAIN}`;
  const issuerEndpoint = `ep_issuer@${RELAY_DOMAIN}`;
  const redeemer = { owner_id: `usr_redeemer@${PEER_DOMAIN}`, endpoint_id: `ep_redeemer@${PEER_DOMAIN}` };

  // A pending invite the redemption will match...
  const linkRef = crypto.randomUUID();
  const segment = 'abcdefghijklmnopqrstuvwx';
  await repo.createFederationDirectoryInvite({
    linkRef,
    issuerEndpointId: issuerEndpoint,
    issuerOwnerId: issuerOwner,
    peerDomain: PEER_DOMAIN,
    codeHash: sha256Hex(segment),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  // ...and a live link for the SAME owner pair under a DIFFERENT link_ref, so
  // step 5's collision probe returns the handler's 409.
  await repo.createFederationDirectoryLink({
    linkRef: crypto.randomUUID(),
    localOwnerId: issuerOwner,
    localEndpointId: issuerEndpoint,
    remoteOwnerId: redeemer.owner_id,
    remoteEndpointId: redeemer.endpoint_id,
    remoteDomain: PEER_DOMAIN,
    role: 'issuer',
    initiatedVia: 'invite',
    status: 'active',
    localConfirmedAt: new Date(),
    remoteConfirmedAt: new Date(),
    sourceInviteId: null,
    peerDomain: PEER_DOMAIN,
  });

  const nonce = 'COMMITTED_000000000000';
  const now = new Date();
  // Exactly the route's shape: consume the nonce first, then run the handler.
  const result = await repo.withTransaction(async (client) => {
    await repo.consumeRelayNonce(nonce, { expiresAt: new Date(now.getTime() + 300_000), client });
    return acceptDirectoryRedemption({
      link_ref: linkRef,
      code: `sigil-fed-invite:${RELAY_DOMAIN}:${linkRef}:${segment}`,
      redeemer,
      redeemer_domain: PEER_DOMAIN,
      nonce,
      signed_at: now.toISOString(),
    }, { repository: repo, client, originDomain: PEER_DOMAIN, now, relayDomain: RELAY_DOMAIN, request_id: 'req_1' });
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'FEDERATION_LINK_EXISTS');

  // The handler RETURNED, so the transaction committed -- nonce and all. A
  // retry of the same signed bytes is now a replay, not a fresh attempt.
  await assert.rejects(repo.withTransaction(async (client) => {
    await repo.consumeRelayNonce(nonce, { expiresAt: new Date(now.getTime() + 300_000), client });
  }), (error) => error.code === 'RELAY_REPLAYED');

  // And the invite is still pending, per the 409 branch's own contract.
  const invite = await repo.getFederationDirectoryInviteByRef(linkRef);
  assert.equal(invite.status, 'pending');
});
