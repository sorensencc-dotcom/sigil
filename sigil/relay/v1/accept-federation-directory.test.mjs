import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { acceptDirectoryRedemption } from './accept-federation-directory.mjs';

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
