import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { createMemoryRepository } from './memory-repository.mjs';

test('memory relay does not redeliver acknowledged messages and replays acknowledgements', async () => {
  const repository = createMemoryRepository();
  await repository.persistAcceptedEnvelope({ message_id: 'msg_1', canonical_hash: 'sha256:abc', envelope: { sender: { endpoint_id: 'ep_codex' }, recipient: { endpoint_id: 'ep_claude' }, idempotency_key: 'send_1' } });
  const first = await repository.listInbox('ep_claude');
  assert.equal(first.length, 1);
  const acknowledged = await repository.acknowledgeDelivery({ deliveryId: first[0].delivery_id, endpointId: 'ep_claude' });
  assert.equal(acknowledged.state, 'acknowledged');
  assert.deepEqual(await repository.listInbox('ep_claude'), []);
  assert.equal((await repository.acknowledgeDelivery({ deliveryId: first[0].delivery_id, endpointId: 'ep_claude' })).duplicate, true);
});

test('memory relay assigns monotonic stream sequences per sender conversation', async () => {
  const repository = createMemoryRepository();
  assert.equal(await repository.assignStreamSequence(null, 'ep_codex', 'conv_1'), 1n);
  assert.equal(await repository.assignStreamSequence(null, 'ep_codex', 'conv_1'), 2n);
  assert.equal(await repository.assignStreamSequence(null, 'ep_codex', 'conv_2'), 1n);
});

test('memory relay withTransaction runs the callback with a null client and returns its result', async () => {
  const repository = createMemoryRepository();
  const result = await repository.withTransaction(async (client) => { assert.equal(client, null); return 'ok'; });
  assert.equal(result, 'ok');
});

test('memory relay lookupTaskRequest finds an accepted task.request by conversation and task_id', async () => {
  const repository = createMemoryRepository();
  await repository.persistAcceptedEnvelope({
    message_id: 'msg_req_1', canonical_hash: 'sha256:abc',
    envelope: { message_id: 'msg_req_1', sender: { endpoint_id: 'ep_claude' }, message_type: 'task.request', conversation_id: 'conv_1', body: { task_id: 'task_1' }, idempotency_key: 'send_1' }
  });
  const found = await repository.lookupTaskRequest('task_1', 'conv_1');
  assert.deepEqual(found, { message_id: 'msg_req_1' });
  assert.equal(await repository.lookupTaskRequest('task_missing', 'conv_1'), null);
});

test('memory relay lookupIdempotency returns the stored canonical hash for a prior acceptance', async () => {
  const repository = createMemoryRepository();
  await repository.persistAcceptedEnvelope({
    message_id: 'msg_1', canonical_hash: 'sha256:abc',
    envelope: { sender: { endpoint_id: 'ep_codex' }, idempotency_key: 'send_1' }
  });
  assert.deepEqual(await repository.lookupIdempotency('ep_codex', 'send_1'), { message_id: 'msg_1', canonical_hash: 'sha256:abc' });
  assert.equal(await repository.lookupIdempotency('ep_codex', 'send_missing'), null);
});

test('memory relay lookupCapabilityRegistration returns registered capabilities with correct risk_tier', async () => {
  const repository = createMemoryRepository();
  const lowRiskCapability = await repository.lookupCapabilityRegistration('sigil.task/read_inbox');
  assert.ok(lowRiskCapability);
  assert.equal(lowRiskCapability.capability, 'sigil.task/read_inbox');
  assert.equal(lowRiskCapability.namespace, 'sigil.task');
  assert.equal(lowRiskCapability.risk_tier, 'low');

  const highRiskCapability = await repository.lookupCapabilityRegistration('sigil.approval/request');
  assert.ok(highRiskCapability);
  assert.equal(highRiskCapability.capability, 'sigil.approval/request');
  assert.equal(highRiskCapability.namespace, 'sigil.approval');
  assert.equal(highRiskCapability.risk_tier, 'high');
});

test('memory relay lookupCapabilityRegistration returns null for unregistered capabilities', async () => {
  const repository = createMemoryRepository();
  assert.equal(await repository.lookupCapabilityRegistration('unknown.capability/fake'), null);
});

test('memory relay federation_directory_invites: create -> getByRef -> lazy expire -> revoke', async () => {
  const repository = createMemoryRepository();
  const linkRef = crypto.randomUUID();

  const created = await repository.withTransaction((c) => repository.createFederationDirectoryInvite({
    linkRef, issuerEndpointId: 'ep_codex@a.example', issuerOwnerId: 'usr_chris@a.example',
    peerDomain: 'b.example', codeHash: 'HASH', expiresAt: new Date(Date.now() + 3600_000), now: new Date(),
  }, c));
  assert.equal(created.link_ref, linkRef);
  assert.ok(created.invite_id);

  const row = await repository.getFederationDirectoryInviteByRef(linkRef, null, {});
  assert.equal(row.status, 'pending');
  assert.equal(row.peer_domain, 'b.example');
  assert.equal(row.code_hash, 'HASH');
  // getByRef returns a shallow copy, not the live Map row (no `created_at`).
  assert.equal(row.created_at, undefined);

  // an invite created with a past expiry lazily transitions on getByRef
  const pastLinkRef = crypto.randomUUID();
  await repository.createFederationDirectoryInvite({
    linkRef: pastLinkRef, issuerEndpointId: 'ep_codex@a.example', issuerOwnerId: 'usr_chris@a.example',
    peerDomain: 'b.example', codeHash: 'HASH', expiresAt: new Date(Date.now() - 3600_000), now: new Date(),
  }, null);
  const expired = await repository.getFederationDirectoryInviteByRef(pastLinkRef, null, {});
  assert.equal(expired.status, 'expired');

  const revoke = await repository.revokeFederationDirectoryInvite(pastLinkRef, new Date(), null);
  assert.equal(revoke.updated, 0); // already terminal (expired)
});

test('memory relay federation_directory_invites: redeem + list omits code_hash', async () => {
  const repository = createMemoryRepository();
  const linkRef = crypto.randomUUID();

  const { invite_id } = await repository.createFederationDirectoryInvite({
    linkRef, issuerEndpointId: 'ep_codex@a.example', issuerOwnerId: 'usr_lister@a.example',
    peerDomain: 'b.example', codeHash: 'SECRET', expiresAt: new Date(Date.now() + 3600_000), now: new Date(),
  }, null);

  const marked = await repository.markFederationDirectoryInviteRedeemed(
    invite_id, { owner_id: 'usr_peer@b.example', endpoint_id: 'ep_peer@b.example' }, new Date(), null,
  );
  assert.equal(marked.updated, 1);

  const redeemed = await repository.getFederationDirectoryInviteByRef(linkRef, null, {});
  assert.equal(redeemed.status, 'redeemed');
  assert.equal(redeemed.redeemed_by_owner_id, 'usr_peer@b.example');
  assert.equal(redeemed.redeemed_by_endpoint_id, 'ep_peer@b.example');
  assert.ok(redeemed.redeemed_at);

  const listed = await repository.listFederationDirectoryInvites({ issuerOwnerId: 'usr_lister@a.example' });
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]).sort(), ['expires_at', 'link_ref', 'peer_domain', 'status']);
  assert.equal(listed[0].link_ref, linkRef);

  const revoke = await repository.revokeFederationDirectoryInvite(linkRef, new Date(), null);
  assert.equal(revoke.updated, 0); // already redeemed -> terminal
});

test('memory relay federation_directory_links: create -> confirm CAS -> revoke-wins race -> getActive', async () => {
  const repository = createMemoryRepository();
  const linkRef = crypto.randomUUID();

  await repository.withTransaction((c) => repository.createFederationDirectoryLink({
    linkRef, localOwnerId: 'usr_chris@a.example', localEndpointId: 'ep_codex@a.example',
    remoteOwnerId: 'usr_bob@b.example', remoteEndpointId: 'ep_c@b.example', remoteDomain: 'b.example',
    role: 'issuer', status: 'pending', localConfirmedAt: null, remoteConfirmedAt: new Date(),
    sourceInviteId: null, peerDomain: 'b.example',
  }, c));

  // second live link for the same pair -> typed FEDERATION_LINK_EXISTS
  await assert.rejects(
    repository.withTransaction((c) => repository.createFederationDirectoryLink({
      linkRef: crypto.randomUUID(), localOwnerId: 'usr_chris@a.example', localEndpointId: 'ep_x@a.example',
      remoteOwnerId: 'usr_bob@b.example', remoteEndpointId: 'ep_y@b.example', remoteDomain: 'b.example',
      role: 'issuer', status: 'pending', localConfirmedAt: null, remoteConfirmedAt: new Date(),
      sourceInviteId: null, peerDomain: 'b.example',
    }, c)),
    (e) => e.code === 'FEDERATION_LINK_EXISTS' && e.existingLinkRef === linkRef,
  );

  const set = await repository.setFederationDirectoryLinkConfirmation(linkRef, 'local', new Date(), null);
  assert.deepEqual(set, { updated: 1, activated: true });

  const active = await repository.getActiveFederationDirectoryLink('usr_chris@a.example', 'usr_bob@b.example', 'b.example', null);
  assert.equal(active?.link_ref, linkRef);
  assert.equal(active.status, 'active');
  // getActive returns a shallow copy -- mutating it must not reach the store
  active.status = 'MUTATED';
  const active2 = await repository.getActiveFederationDirectoryLink('usr_chris@a.example', 'usr_bob@b.example', 'b.example', null);
  assert.equal(active2.status, 'active');

  // revoke wins: after revoke, a late confirmation CAS updates nothing
  await repository.revokeFederationDirectoryLink(linkRef, 'local', new Date(), null);
  const late = await repository.setFederationDirectoryLinkConfirmation(linkRef, 'remote', new Date(), null);
  assert.equal(late.updated, 0);
  const afterRevoke = await repository.getActiveFederationDirectoryLink('usr_chris@a.example', 'usr_bob@b.example', 'b.example', null);
  assert.equal(afterRevoke, null);

  // list projection omits endpoint ids, source_invite_id, and reason codes
  const listed = await repository.listFederationDirectoryLinks({ ownerId: 'usr_chris@a.example' });
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]).sort(),
    ['link_ref', 'local_confirmed_at', 'local_owner_id', 'remote_confirmed_at', 'remote_domain', 'remote_owner_id', 'role', 'status']);
});

test('memory relay federation_directory_links: expired reaper path never resurrects a link', async () => {
  const repository = createMemoryRepository();
  const linkRef = crypto.randomUUID();
  await repository.createFederationDirectoryLink({
    linkRef, localOwnerId: 'usr_a@a.example', localEndpointId: 'ep_a@a.example',
    remoteOwnerId: 'usr_b@b.example', remoteEndpointId: 'ep_b@b.example', remoteDomain: 'b.example',
    role: 'redeemer', status: 'pending', localConfirmedAt: null, remoteConfirmedAt: null,
    sourceInviteId: null, peerDomain: 'b.example',
  }, null);

  const exp = await repository.markFederationDirectoryLinkExpired(linkRef, 'redemption_dead_letter', new Date(), null);
  assert.deepEqual(exp, { updated: 1 });

  // a late confirmation and a late revoke are both inert against a terminal row
  assert.equal((await repository.setFederationDirectoryLinkConfirmation(linkRef, 'local', new Date(), null)).updated, 0);
  assert.equal((await repository.revokeFederationDirectoryLink(linkRef, 'remote', new Date(), null)).updated, 0);
  assert.equal((await repository.markFederationDirectoryLinkExpired(linkRef, 'again', new Date(), null)).updated, 0);

  const row = await repository.getFederationDirectoryLinkByRef(linkRef, null, {});
  assert.equal(row.status, 'expired');
  assert.equal(row.last_reason_code, 'redemption_dead_letter');
});
