// Memory-repository coverage for the directory/trust invite (Task 3) and
// OIDC match (Task 4) lifecycles. The Postgres side of both is covered by
// sigil/relay/v1/postgres-repository.directory-invites.test.mjs and
// sigil/relay/v1/postgres-repository.directory-match.test.mjs; this file
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
