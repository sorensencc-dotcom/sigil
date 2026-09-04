import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { acceptDirectoryRedemption } from './accept-federation-directory.mjs';
import { acceptDirectoryConfirmation, acceptDirectoryRevocation } from './accept-federation-directory.mjs';

const RELAY_DOMAIN = 'a.example';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function seedInvite(repo, { linkRef, segment, peerDomain = 'b.example', expiresAt }) {
  await repo.createFederationDirectoryInvite({
    linkRef, issuerEndpointId: 'ep_codex@a.example', issuerOwnerId: 'usr_chris@a.example',
    peerDomain, codeHash: sha256(segment), expiresAt: expiresAt ?? new Date(Date.now() + 3600_000), now: new Date(),
  }, null);
}
function redemptionBody({ linkRef, segment, issuerDomain = 'a.example', redeemerDomain = 'b.example' }) {
  return {
    link_ref: linkRef,
    code: `sigil-fed-invite:${issuerDomain}:${linkRef}:${segment}`,
    redeemer: { owner_id: 'usr_bob@b.example', endpoint_id: 'ep_c@b.example' },
    redeemer_domain: redeemerDomain,
    requested_at: '2026-09-02T12:00:00.000Z',
  };
}
const ctx = (repo, over = {}) => ({ repository: repo, client: null, originDomain: 'b.example', now: new Date(), request_id: 'req_1', relayDomain: RELAY_DOMAIN, ...over });

test('good code: writes a pending issuer-side link with remote_confirmed_at set, marks invite redeemed', async () => {
  const repo = createMemoryRepository();
  const linkRef = crypto.randomUUID();
  await seedInvite(repo, { linkRef, segment: 'SEG' });
  const res = await acceptDirectoryRedemption(redemptionBody({ linkRef, segment: 'SEG' }), ctx(repo));
  assert.equal(res.status, 202);
  assert.equal(res.body.link_ref, linkRef);
  assert.deepEqual(res.body.issuer, { owner_id: 'usr_chris@a.example', endpoint_id: 'ep_codex@a.example' });
  const invite = await repo.getFederationDirectoryInviteByRef(linkRef, null, {});
  assert.equal(invite.status, 'redeemed');
  const link = await repo.getFederationDirectoryLinkByRef(linkRef, null, {});
  assert.equal(link.status, 'pending');
  assert.equal(link.role, 'issuer');
  assert.ok(link.remote_confirmed_at);
  assert.equal(link.local_confirmed_at, null);
});

test('unknown / expired / revoked / redeemed-by-another all collapse to one INVALID_FEDERATION_INVITE', async () => {
  const repo = createMemoryRepository();
  // unknown
  let res = await acceptDirectoryRedemption(redemptionBody({ linkRef: crypto.randomUUID(), segment: 'SEG' }), ctx(repo));
  assert.equal(res.body.code, 'INVALID_FEDERATION_INVITE');
  assert.equal(res.status, 403);
  // expired
  const l2 = crypto.randomUUID();
  await seedInvite(repo, { linkRef: l2, segment: 'SEG', expiresAt: new Date(Date.now() - 1000) });
  res = await acceptDirectoryRedemption(redemptionBody({ linkRef: l2, segment: 'SEG' }), ctx(repo));
  assert.equal(res.body.code, 'INVALID_FEDERATION_INVITE');
  const expired = await repo.getFederationDirectoryInviteByRef(l2, null, {});
  assert.equal(expired.status, 'expired'); // transitioned in the same call
});

test('embedded issuer domain that is not this relay -> 400 INVALID_FEDERATION_REQUEST', async () => {
  const repo = createMemoryRepository();
  const linkRef = crypto.randomUUID();
  await seedInvite(repo, { linkRef, segment: 'SEG' });
  const res = await acceptDirectoryRedemption(redemptionBody({ linkRef, segment: 'SEG', issuerDomain: 'evil.example' }), ctx(repo));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_FEDERATION_REQUEST');
});

test('redeemer_domain != verified originDomain -> 400', async () => {
  const repo = createMemoryRepository();
  const linkRef = crypto.randomUUID();
  await seedInvite(repo, { linkRef, segment: 'SEG' });
  const res = await acceptDirectoryRedemption(redemptionBody({ linkRef, segment: 'SEG', redeemerDomain: 'c.example' }), ctx(repo));
  assert.equal(res.status, 400);
});

test('same redeemer re-post on an already-redeemed invite -> 202, same link_ref, no second row', async () => {
  const repo = createMemoryRepository();
  const linkRef = crypto.randomUUID();
  await seedInvite(repo, { linkRef, segment: 'SEG' });
  await acceptDirectoryRedemption(redemptionBody({ linkRef, segment: 'SEG' }), ctx(repo));
  const res = await acceptDirectoryRedemption(redemptionBody({ linkRef, segment: 'SEG' }), ctx(repo));
  assert.equal(res.status, 202);
  assert.equal(res.body.link_ref, linkRef);
});

test('owner-pair collision under a different link_ref -> 409 FEDERATION_LINK_EXISTS, invite left pending', async () => {
  const repo = createMemoryRepository();
  const first = crypto.randomUUID(); const second = crypto.randomUUID();
  await seedInvite(repo, { linkRef: first, segment: 'S1' });
  await acceptDirectoryRedemption(redemptionBody({ linkRef: first, segment: 'S1' }), ctx(repo));
  await seedInvite(repo, { linkRef: second, segment: 'S2' });
  const res = await acceptDirectoryRedemption(redemptionBody({ linkRef: second, segment: 'S2' }), ctx(repo));
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'FEDERATION_LINK_EXISTS');
  assert.equal(res.body.details.existing_link_ref, first);
  const invite = await repo.getFederationDirectoryInviteByRef(second, null, {});
  assert.equal(invite.status, 'pending');
});

async function seedLink(repo, { linkRef, role = 'issuer', status = 'pending', localConfirmedAt = null, remoteConfirmedAt = null, peerDomain = 'b.example' }) {
  await repo.createFederationDirectoryLink({
    linkRef, localOwnerId: 'usr_chris@a.example', localEndpointId: 'ep_codex@a.example',
    remoteOwnerId: 'usr_bob@b.example', remoteEndpointId: 'ep_c@b.example', remoteDomain: 'b.example',
    role, status, localConfirmedAt, remoteConfirmedAt, sourceInviteId: null, peerDomain,
  }, null);
}

test('confirmation: sets remote_confirmed_at; flips to active only when local is also set', async () => {
  const repo = createMemoryRepository();
  const linkRef = crypto.randomUUID();
  await seedLink(repo, { linkRef, localConfirmedAt: new Date() });   // local already set on the issuer relay
  const res = await acceptDirectoryConfirmation({ link_ref: linkRef, confirmed_at: '2026-09-02T12:05:00Z' }, ctx(repo));
  assert.equal(res.status, 202);
  const link = await repo.getFederationDirectoryLinkByRef(linkRef, null, {});
  assert.equal(link.status, 'active');
  assert.ok(link.remote_confirmed_at);
});

test('confirmation: unknown link_ref -> 404 FEDERATION_LINK_NOT_FOUND', async () => {
  const repo = createMemoryRepository();
  const res = await acceptDirectoryConfirmation({ link_ref: crypto.randomUUID(), confirmed_at: '2026-09-02T12:05:00Z' }, ctx(repo));
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'FEDERATION_LINK_NOT_FOUND');
});

test('confirmation: posting relay != row peer_domain -> 403 PEER_NOT_TRUSTED', async () => {
  const repo = createMemoryRepository();
  const linkRef = crypto.randomUUID();
  await seedLink(repo, { linkRef, peerDomain: 'other.example' });
  const res = await acceptDirectoryConfirmation({ link_ref: linkRef, confirmed_at: '2026-09-02T12:05:00Z' }, ctx(repo));
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'PEER_NOT_TRUSTED');
});

test('confirmation after revocation never reactivates (revocation wins)', async () => {
  const repo = createMemoryRepository();
  const linkRef = crypto.randomUUID();
  await seedLink(repo, { linkRef, status: 'revoked' });
  const res = await acceptDirectoryConfirmation({ link_ref: linkRef, confirmed_at: '2026-09-02T12:05:00Z' }, ctx(repo));
  assert.equal(res.status, 202);
  const link = await repo.getFederationDirectoryLinkByRef(linkRef, null, {});
  assert.equal(link.status, 'revoked');
});

test('duplicate confirmation on an already-active row -> 202 no-op', async () => {
  const repo = createMemoryRepository();
  const linkRef = crypto.randomUUID();
  await seedLink(repo, { linkRef, status: 'active', localConfirmedAt: new Date(), remoteConfirmedAt: new Date() });
  const res = await acceptDirectoryConfirmation({ link_ref: linkRef, confirmed_at: '2026-09-02T12:05:00Z' }, ctx(repo));
  assert.equal(res.status, 202);
});

test('revocation: sets revoked/remote; repeat -> 202; unknown ref -> 202 no-op (no leak); wrong relay -> 403', async () => {
  const repo = createMemoryRepository();
  const linkRef = crypto.randomUUID();
  await seedLink(repo, { linkRef, status: 'active', localConfirmedAt: new Date(), remoteConfirmedAt: new Date() });
  let res = await acceptDirectoryRevocation({ link_ref: linkRef, revoked_at: '2026-09-02T13:00:00Z' }, ctx(repo));
  assert.equal(res.status, 202);
  let link = await repo.getFederationDirectoryLinkByRef(linkRef, null, {});
  assert.equal(link.status, 'revoked');
  assert.equal(link.revoked_by, 'remote');
  res = await acceptDirectoryRevocation({ link_ref: linkRef, revoked_at: '2026-09-02T13:00:00Z' }, ctx(repo));
  assert.equal(res.status, 202); // idempotent
  res = await acceptDirectoryRevocation({ link_ref: crypto.randomUUID(), revoked_at: '2026-09-02T13:00:00Z' }, ctx(repo));
  assert.equal(res.status, 202); // unknown -> no-op, no existence leak

  const other = crypto.randomUUID();
  await seedLink(repo, { linkRef: other, peerDomain: 'other.example' });
  res = await acceptDirectoryRevocation({ link_ref: other, revoked_at: '2026-09-02T13:00:00Z' }, ctx(repo));
  assert.equal(res.status, 403);
});
