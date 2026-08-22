// Memory-repository coverage for the directory/trust invite (Task 3), OIDC
// match (Task 4), and confirmation/revocation/lookup (Task 5) lifecycles.
// The Postgres side is covered by
// sigil/relay/v1/postgres-repository.directory-invites.test.mjs,
// sigil/relay/v1/postgres-repository.directory-match.test.mjs, and
// sigil/relay/v1/postgres-repository.directory-links.test.mjs; this file
// closes the gap flagged in Task 4 review -- the dual-repository test
// requirement (plan Global Constraints) had no memory-repository regression
// coverage for these methods, only an ad hoc scratch script that was never
// committed. Pure in-memory: no SIGIL_TEST_DATABASE_URL, no Docker, runs as
// part of plain `npm test`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryRepository } from './memory-repository.mjs';

test('memory relay directory invite lifecycle: create, redeem, reject double-redemption and self-redemption', async () => {
  const repository = createMemoryRepository();
  const now = new Date('2026-08-22T00:00:00Z');

  const invite = await repository.createDirectoryInvite({ issuerEndpointId: 'ep_inv_a', issuerHumanId: 'human_inv_a', homeRelay: 'relay.local', now });
  assert.equal(typeof invite.code, 'string');
  assert.equal(typeof invite.invite_id, 'string');

  const redeemed = await repository.redeemDirectoryInvite({ code: invite.code, redeemerEndpointId: 'ep_inv_b', redeemerHumanId: 'human_inv_b', homeRelay: 'relay.local', now });
  assert.equal(typeof redeemed.link_id, 'string');
  assert.equal(redeemed.status, 'pending');

  await assert.rejects(
    () => repository.redeemDirectoryInvite({ code: invite.code, redeemerEndpointId: 'ep_inv_b', redeemerHumanId: 'human_inv_b', homeRelay: 'relay.local', now }),
    { code: 'INVITE_UNAVAILABLE' }
  );

  const secondInvite = await repository.createDirectoryInvite({ issuerEndpointId: 'ep_inv_a', issuerHumanId: 'human_inv_a', homeRelay: 'relay.local', now });
  await assert.rejects(
    () => repository.redeemDirectoryInvite({ code: secondInvite.code, redeemerEndpointId: 'ep_inv_other', redeemerHumanId: 'human_inv_a', homeRelay: 'relay.local', now }),
    { code: 'INVITE_UNAVAILABLE' }
  );
});

test('memory relay directory match-request lifecycle: create, claim, reject stale re-claim, nominate, reject wrong-human nominate', async () => {
  const repository = createMemoryRepository();
  const now = new Date('2026-08-22T00:00:00Z');
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);

  const request = await repository.createDirectoryMatchRequest({ issuerEndpointId: 'ep_match_a', issuerHumanId: 'human_match_a', issuer: 'https://accounts.example.com', matchTarget: 'target@example.com', expiresAt, homeRelay: 'relay.local', now });
  assert.equal(typeof request.request_id, 'string');

  const claimed = await repository.claimDirectoryMatch({ issuer: 'https://accounts.example.com', matchTarget: 'target@example.com', matchedHumanId: 'human_match_b', now });
  assert.deepEqual(claimed, { request_id: request.request_id });

  // Request is now 'matched', not 'pending' -- a second claim attempt for
  // the same (issuer, target) must see nothing to claim and return null,
  // mirroring the Postgres SKIP LOCKED path's non-match result.
  const staleClaim = await repository.claimDirectoryMatch({ issuer: 'https://accounts.example.com', matchTarget: 'target@example.com', matchedHumanId: 'human_match_c', now });
  assert.equal(staleClaim, null);

  await assert.rejects(
    () => repository.nominateDirectoryLinkEndpoint({ requestId: request.request_id, nominatedEndpointId: 'ep_match_b', nominatedHumanId: 'human_match_wrong', homeRelay: 'relay.local', now }),
    { code: 'MATCH_UNAVAILABLE' }
  );

  const nominated = await repository.nominateDirectoryLinkEndpoint({ requestId: request.request_id, nominatedEndpointId: 'ep_match_b', nominatedHumanId: 'human_match_b', homeRelay: 'relay.local', now });
  assert.equal(typeof nominated.link_id, 'string');
  assert.equal(nominated.status, 'pending');
});

test('memory relay directory link conflict rejects a second invite redemption and a second match nomination for the same endpoint pair', async () => {
  const repository = createMemoryRepository();
  const now = new Date('2026-08-22T00:00:00Z');
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);

  const invite = await repository.createDirectoryInvite({ issuerEndpointId: 'ep_conflict_a', issuerHumanId: 'human_conflict_a', homeRelay: 'relay.local', now });
  const redeemed = await repository.redeemDirectoryInvite({ code: invite.code, redeemerEndpointId: 'ep_conflict_b', redeemerHumanId: 'human_conflict_b', homeRelay: 'relay.local', now });
  assert.equal(redeemed.status, 'pending');

  // A second, distinct invite between the same endpoint pair: the code
  // itself is fresh (not a double-redemption), but a pending link already
  // exists for (ep_conflict_a, ep_conflict_b), so it must be rejected as a
  // link conflict, not an invite-availability error.
  const secondInvite = await repository.createDirectoryInvite({ issuerEndpointId: 'ep_conflict_a', issuerHumanId: 'human_conflict_a', homeRelay: 'relay.local', now });
  await assert.rejects(
    () => repository.redeemDirectoryInvite({ code: secondInvite.code, redeemerEndpointId: 'ep_conflict_b', redeemerHumanId: 'human_conflict_b', homeRelay: 'relay.local', now }),
    { code: 'DIRECTORY_LINK_CONFLICT' }
  );

  // Same conflict check applies on the match/nominate path: a distinct,
  // freshly matched request between the same already-linked endpoint pair
  // must also be rejected as a link conflict.
  const request = await repository.createDirectoryMatchRequest({ issuerEndpointId: 'ep_conflict_a', issuerHumanId: 'human_conflict_a', issuer: 'https://accounts.example.com', matchTarget: 'conflict@example.com', expiresAt, homeRelay: 'relay.local', now });
  await repository.claimDirectoryMatch({ issuer: 'https://accounts.example.com', matchTarget: 'conflict@example.com', matchedHumanId: 'human_conflict_b', now });
  await assert.rejects(
    () => repository.nominateDirectoryLinkEndpoint({ requestId: request.request_id, nominatedEndpointId: 'ep_conflict_b', nominatedHumanId: 'human_conflict_b', homeRelay: 'relay.local', now }),
    { code: 'DIRECTORY_LINK_CONFLICT' }
  );
});

// Task 5 coverage: confirmDirectoryLink, revokeDirectoryLink,
// lookupActiveDirectoryLink. redeemDirectoryInvite (Task 3) auto-confirms
// the redeemer's side as part of redemption -- confirmed against a live
// Postgres run for the equivalent postgres-repository.directory-links.test
// -- so a link created via invite redemption starts 'pending' with the
// redeemer already confirmed and only the issuer's confirmation still
// outstanding. These tests set that starting state up the same way.
test('memory relay directory link confirmation: actor mismatch, idempotent reconfirm by the already-confirmed redeemer, and issuer confirmation activates the link', async () => {
  const repository = createMemoryRepository();
  const now = new Date('2026-08-22T00:00:00Z');

  const invite = await repository.createDirectoryInvite({ issuerEndpointId: 'ep_confirm_a', issuerHumanId: 'human_confirm_a', homeRelay: 'relay.local', now });
  const redeemed = await repository.redeemDirectoryInvite({ code: invite.code, redeemerEndpointId: 'ep_confirm_b', redeemerHumanId: 'human_confirm_b', homeRelay: 'relay.local', now });
  assert.equal(redeemed.status, 'pending');

  // A human who is not a party to the link at all must be rejected.
  await assert.rejects(
    () => repository.confirmDirectoryLink({ linkId: redeemed.link_id, confirmingHumanId: 'human_confirm_outsider', now }),
    { code: 'CONFIRMATION_ACTOR_MISMATCH' }
  );

  // The redeemer already auto-confirmed at redemption time -- re-confirming
  // with the same human must be an idempotent no-op, not an error or a
  // second write.
  const reconfirmed = await repository.confirmDirectoryLink({ linkId: redeemed.link_id, confirmingHumanId: 'human_confirm_b', now });
  assert.equal(reconfirmed.status, 'pending');

  // The issuer's confirmation is still outstanding; confirming it activates
  // the link now that both sides have confirmed.
  const activated = await repository.confirmDirectoryLink({ linkId: redeemed.link_id, confirmingHumanId: 'human_confirm_a', now });
  assert.equal(activated.status, 'active');
});

test('memory relay directory link revocation: either party can revoke unilaterally, and revoking an already-revoked link is idempotent', async () => {
  const repository = createMemoryRepository();
  const now = new Date('2026-08-22T00:00:00Z');

  // Link one: revoked by the redeemer (the side that auto-confirmed).
  const inviteOne = await repository.createDirectoryInvite({ issuerEndpointId: 'ep_revoke_a1', issuerHumanId: 'human_revoke_a1', homeRelay: 'relay.local', now });
  const redeemedOne = await repository.redeemDirectoryInvite({ code: inviteOne.code, redeemerEndpointId: 'ep_revoke_b1', redeemerHumanId: 'human_revoke_b1', homeRelay: 'relay.local', now });
  await repository.confirmDirectoryLink({ linkId: redeemedOne.link_id, confirmingHumanId: 'human_revoke_a1', now });
  const revokedByRedeemer = await repository.revokeDirectoryLink({ linkId: redeemedOne.link_id, revokingHumanId: 'human_revoke_b1', now });
  assert.equal(revokedByRedeemer.status, 'revoked');
  assert.equal(revokedByRedeemer.duplicate, false);

  // Revoking the same, already-revoked link again must return
  // duplicate: true rather than erroring, regardless of which party asks.
  const revokedAgain = await repository.revokeDirectoryLink({ linkId: redeemedOne.link_id, revokingHumanId: 'human_revoke_a1', now });
  assert.equal(revokedAgain.status, 'revoked');
  assert.equal(revokedAgain.duplicate, true);

  // Link two: revoked by the issuer instead, proving revocation is
  // unilateral and not tied to a specific side.
  const inviteTwo = await repository.createDirectoryInvite({ issuerEndpointId: 'ep_revoke_a2', issuerHumanId: 'human_revoke_a2', homeRelay: 'relay.local', now });
  const redeemedTwo = await repository.redeemDirectoryInvite({ code: inviteTwo.code, redeemerEndpointId: 'ep_revoke_b2', redeemerHumanId: 'human_revoke_b2', homeRelay: 'relay.local', now });
  const revokedByIssuer = await repository.revokeDirectoryLink({ linkId: redeemedTwo.link_id, revokingHumanId: 'human_revoke_a2', now });
  assert.equal(revokedByIssuer.status, 'revoked');
  assert.equal(revokedByIssuer.duplicate, false);
});

test('memory relay directory link lookup: finds an active link regardless of endpoint argument order, and no longer finds it after revocation', async () => {
  const repository = createMemoryRepository();
  const now = new Date('2026-08-22T00:00:00Z');

  const invite = await repository.createDirectoryInvite({ issuerEndpointId: 'ep_lookup_a', issuerHumanId: 'human_lookup_a', homeRelay: 'relay.local', now });
  const redeemed = await repository.redeemDirectoryInvite({ code: invite.code, redeemerEndpointId: 'ep_lookup_b', redeemerHumanId: 'human_lookup_b', homeRelay: 'relay.local', now });
  await repository.confirmDirectoryLink({ linkId: redeemed.link_id, confirmingHumanId: 'human_lookup_a', now });

  const found = await repository.lookupActiveDirectoryLink('ep_lookup_a', 'ep_lookup_b');
  assert.equal(found.link_id, redeemed.link_id);

  // Reversed argument order must still find the same active link.
  const reversed = await repository.lookupActiveDirectoryLink('ep_lookup_b', 'ep_lookup_a');
  assert.equal(reversed.link_id, redeemed.link_id);

  await repository.revokeDirectoryLink({ linkId: redeemed.link_id, revokingHumanId: 'human_lookup_b', now });
  const gone = await repository.lookupActiveDirectoryLink('ep_lookup_a', 'ep_lookup_b');
  assert.equal(gone, null);
});

test('confirmed_by attribution is correct when the redeemer/nominee endpoint sorts before the issuer endpoint', async () => {
  const repository = createMemoryRepository();
  const now = new Date('2026-08-22T00:00:00Z');
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);

  // Issuer endpoint ('ep_z_...') deliberately sorts AFTER the
  // redeemer/nominee endpoint ('ep_a_...') -- the inverse of every other
  // test in this file, which masked a real bug where a_confirmed_by/
  // b_confirmed_by were computed relative to "is this the issuer's side"
  // instead of "did this side actually confirm."

  const invite = await repository.createDirectoryInvite({ issuerEndpointId: 'ep_z_sort_issuer', issuerHumanId: 'human_sort_issuer', homeRelay: 'relay.local', now });
  const redeemed = await repository.redeemDirectoryInvite({ code: invite.code, redeemerEndpointId: 'ep_a_sort_redeemer', redeemerHumanId: 'human_sort_redeemer', homeRelay: 'relay.local', now });
  const inviteLink = repository._debugGetDirectoryLink(redeemed.link_id);
  assert.equal(inviteLink.endpoint_a, 'ep_a_sort_redeemer', 'redeemer endpoint sorts first');
  assert.equal(inviteLink.endpoint_b, 'ep_z_sort_issuer', 'issuer endpoint sorts second');
  assert.notEqual(inviteLink.a_confirmed_at, null);
  assert.equal(inviteLink.b_confirmed_at, null);
  assert.equal(inviteLink.a_confirmed_by, 'human_sort_redeemer', 'the side that actually confirmed (redeemer) must be attributed to the redeemer, not the issuer');
  assert.equal(inviteLink.b_confirmed_by, null, 'the unconfirmed side must not carry a confirmed_by value');

  const request = await repository.createDirectoryMatchRequest({ issuerEndpointId: 'ep_z_sort_issuer2', issuerHumanId: 'human_sort_issuer2', issuer: 'https://accounts.example.com', matchTarget: 'sort-target@example.com', expiresAt, homeRelay: 'relay.local', now });
  await repository.claimDirectoryMatch({ issuer: 'https://accounts.example.com', matchTarget: 'sort-target@example.com', matchedHumanId: 'human_sort_nominee', now });
  const nominated = await repository.nominateDirectoryLinkEndpoint({ requestId: request.request_id, nominatedEndpointId: 'ep_a_sort_nominee', nominatedHumanId: 'human_sort_nominee', homeRelay: 'relay.local', now });
  const matchLink = repository._debugGetDirectoryLink(nominated.link_id);
  assert.equal(matchLink.endpoint_a, 'ep_a_sort_nominee', 'nominee endpoint sorts first');
  assert.equal(matchLink.endpoint_b, 'ep_z_sort_issuer2', 'issuer endpoint sorts second');
  assert.notEqual(matchLink.a_confirmed_at, null);
  assert.equal(matchLink.b_confirmed_at, null);
  assert.equal(matchLink.a_confirmed_by, 'human_sort_nominee', 'the side that actually confirmed (nominee) must be attributed to the nominee, not the issuer');
  assert.equal(matchLink.b_confirmed_by, null, 'the unconfirmed side must not carry a confirmed_by value');
});
