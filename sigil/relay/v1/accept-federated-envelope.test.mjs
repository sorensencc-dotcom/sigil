import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { acceptFederatedEnvelope } from './accept-federated-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { buildForwardRequest, signForwardRequest } from './federation-router.mjs';
import { canonicalJsonBytes } from './jcs.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

const ORIGIN = 'a.example';
const RELAY = 'b.example';
// Task 4: the inbound relay verifier requires a fresh signed_at plus a 22-char
// base64url nonce on every relay request body. Task 10 threads `options.now`
// and the freshness window into the verifier, so `signed_at` is signed relative
// to SERVER_NOW (buildForwardRequest stamps it from the `now` it is given) --
// never wall-clock time. Task 10 also consumes the nonce inside the handler
// transaction, so any test that posts twice must vary the nonce unless it is
// deliberately exercising the replay guard.
const NONCE_OK = 'abcdefghijklmnopqrstuv';
const NONCE_2 = 'bcdefghijklmnopqrstuvw';
const SERVER_NOW = new Date('2026-08-30T12:00:30.000Z');
const SIGNED_AT = new Date('2026-08-30T12:00:05.000Z');

function makeWorld() {
  const relayKeys = crypto.generateKeyPairSync('ed25519');
  const senderKeys = crypto.generateKeyPairSync('ed25519');
  const relayIdentity = { key_id: 'relay-a-2026-08', private_key_pem: relayKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const relayPub = relayKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const senderPub = senderKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const repo = createMemoryRepository({ registry: new Map() });
  repo.upsertPeer({ domain: ORIGIN, relayUrl: 'https://a.example/relay', keys: [{ kid: relayIdentity.key_id, alg: 'Ed25519', publicKey: relayPub }], trustMode: 'tofu' });
  return { relayKeys, senderKeys, relayIdentity, relayPub, senderPub, repo };
}

function senderEnvelope(senderPrivateKey, overrides = {}) {
  const base = {
    protocol: 'sigil/1', message_id: 'msg_fed_1', conversation_id: 'conv_1', message_type: 'chat.message',
    sender: { owner_id: 'usr_chris@primary.example', endpoint_id: `ep_codex@${ORIGIN}`, kind: 'agent' },
    recipient: { owner_id: 'usr_chris@primary.example', endpoint_id: `ep_claude@${RELAY}`, kind: 'agent' },
    body: { text: 'hi' }, context_refs: [], capabilities: [], idempotency_key: 'idem_1',
    created_at: '2026-08-30T12:00:00.000Z', expires_at: '2026-08-30T12:10:00.000Z',
    ...overrides,
  };
  const value = crypto.sign(null, signedBytes({ ...base, signature: undefined }), senderPrivateKey).toString('base64url');
  return { ...base, signature: { algorithm: 'Ed25519', key_id: `key_ep_codex@${ORIGIN}`, value } };
}

function forwardPayload(world, envelopeOverrides = {}, opts = {}) {
  const envelope = opts.envelope ?? senderEnvelope(world.senderKeys.privateKey, envelopeOverrides);
  const { body } = buildForwardRequest(envelope, {
    originDomain: opts.originDomain ?? ORIGIN,
    senderKey: { kid: `key_ep_codex@${ORIGIN}`, alg: 'Ed25519', publicKey: opts.senderPub ?? world.senderPub },
    senderOwnerId: opts.senderOwnerId ?? 'usr_chris@primary.example',
    now: opts.signedAt ?? SIGNED_AT,
    nonce: opts.nonce ?? NONCE_OK,
  });
  const { signature, keyId } = signForwardRequest(canonicalJsonBytes(body), opts.relayIdentity ?? world.relayIdentity);
  return { body, headers: { 'sigil-relay-signature': signature, 'sigil-relay-key-id': keyId } };
}

const baseOpts = (repo) => ({ repository: repo, registered: new Map(), relayDomain: RELAY, request_id: 'req_1', now: SERVER_NOW });

test('check 1: structural garbage → 400 INVALID_FEDERATION_REQUEST', async () => {
  const world = makeWorld();
  // The shared verifier re-parses the raw bytes; a non-JSON body fails the
  // parse step -> 400 INVALID_FEDERATION_REQUEST before any signature work.
  const r = await acceptFederatedEnvelope({}, {}, { ...baseOpts(world.repo), rawBody: Buffer.from('not json{{') });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'INVALID_FEDERATION_REQUEST');
});
test('check 1: malformed sender_owner_id → 400 INVALID_FEDERATION_REQUEST', async () => {
  const world = makeWorld();
  const { body, headers } = forwardPayload(world, {}, { senderOwnerId: 'no-domain' });
  const r = await acceptFederatedEnvelope(body, headers, baseOpts(world.repo));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'INVALID_FEDERATION_REQUEST');
});
test('check 2: unpinned origin → 403 PEER_NOT_TRUSTED', async () => {
  const world = makeWorld();
  const { body, headers } = forwardPayload(world, {}, { originDomain: 'c.example' });
  const r = await acceptFederatedEnvelope(body, headers, baseOpts(world.repo));
  assert.equal(r.status, 403); assert.equal(r.body.code, 'PEER_NOT_TRUSTED');
});
test('self-federation: origin_domain == this relay\'s own domain → 400 INVALID_FEDERATION_REQUEST (before the peer lookup)', async () => {
  const world = makeWorld();
  // origin_domain asserts RELAY itself. RELAY is not pinned, so if this guard
  // were absent the request would fall through to check 2 (PEER_NOT_TRUSTED);
  // getting INVALID_FEDERATION_REQUEST proves the self-federation check fires first.
  const { body, headers } = forwardPayload(world, {}, { originDomain: RELAY });
  const r = await acceptFederatedEnvelope(body, headers, baseOpts(world.repo));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_FEDERATION_REQUEST');
  assert.match(r.body.message, /self-federation/);
});
test('self-federation: case-insensitive domain compare still rejects', async () => {
  const world = makeWorld();
  const { body, headers } = forwardPayload(world, {}, { originDomain: RELAY.toUpperCase() });
  const r = await acceptFederatedEnvelope(body, headers, baseOpts(world.repo));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_FEDERATION_REQUEST');
});
test('check 3: bad relay signature → 401 RELAY_SIGNATURE_INVALID', async () => {
  const world = makeWorld();
  const { body, headers } = forwardPayload(world);
  const r = await acceptFederatedEnvelope(body, { ...headers, 'sigil-relay-signature': 'AAAA' }, baseOpts(world.repo));
  assert.equal(r.status, 401); assert.equal(r.body.code, 'RELAY_SIGNATURE_INVALID');
});
test('check 4: sender domain ≠ origin_domain → 403 SENDER_DOMAIN_FOREIGN', async () => {
  const world = makeWorld();
  const envelope = senderEnvelope(world.senderKeys.privateKey, { sender: { owner_id: 'usr_chris@primary.example', endpoint_id: 'ep_codex@evil.example', kind: 'agent' } });
  const { body, headers } = forwardPayload(world, {}, { envelope });
  const r = await acceptFederatedEnvelope(body, headers, baseOpts(world.repo));
  assert.equal(r.status, 403); assert.equal(r.body.code, 'SENDER_DOMAIN_FOREIGN');
});
test('check 5: envelope signature not matching sender_key → 401 INVALID_SIGNATURE', async () => {
  const world = makeWorld();
  const other = crypto.generateKeyPairSync('ed25519');
  const { body, headers } = forwardPayload(world, {}, { senderPub: other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') });
  const r = await acceptFederatedEnvelope(body, headers, baseOpts(world.repo));
  assert.equal(r.status, 401); assert.equal(r.body.code, 'INVALID_SIGNATURE');
});
// The Task 8 "checks 1-5 pass -> reaches the stub" test is folded into the
// same-owner-exemption test below: with a registered recipient the checks
// 6-10 path now returns 202 { code: 'ACCEPTED' }, a positive success outcome.

function worldWithRecipient(recipientOwnerId = 'usr_chris@primary.example') {
  const registry = new Map([[`ep_claude@${RELAY}`, { endpoint_id: `ep_claude@${RELAY}`, owner_id: recipientOwnerId, key_id: `key_ep_claude@${RELAY}`, kind: 'agent', status: 'active', public_key: crypto.generateKeyPairSync('ed25519').publicKey }]]);
  const relayKeys = crypto.generateKeyPairSync('ed25519');
  const senderKeys = crypto.generateKeyPairSync('ed25519');
  const relayIdentity = { key_id: 'relay-a-2026-08', private_key_pem: relayKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const relayPub = relayKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const senderPub = senderKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const repo = createMemoryRepository({ registry });
  repo.upsertPeer({ domain: ORIGIN, relayUrl: 'https://a.example/relay', keys: [{ kid: relayIdentity.key_id, alg: 'Ed25519', publicKey: relayPub }], trustMode: 'tofu' });
  return { relayKeys, senderKeys, relayIdentity, relayPub, senderPub, repo, registered: registry };
}
const opts9 = (world) => ({ repository: world.repo, registered: world.registered, relayDomain: RELAY, request_id: 'req_1', now: SERVER_NOW });

// B1: the same-owner exemption is gone; same-owner federated delivery now needs
// an active self-pair directory link. `worldWithRecipient` defaults both the
// sender-attested owner and the recipient owner to usr_chris@primary.example.
const seedSelfPairLink = (world, ownerId = 'usr_chris@primary.example') => world.repo.createFederationDirectoryLink({
  linkRef: crypto.randomUUID(),
  localOwnerId: ownerId, localEndpointId: `ep_claude@${RELAY}`,
  remoteOwnerId: ownerId, remoteEndpointId: `ep_codex@${ORIGIN}`,
  remoteDomain: ORIGIN, role: 'issuer', initiatedVia: 'self_pair', status: 'active',
  localConfirmedAt: new Date(), remoteConfirmedAt: new Date(), sourceInviteId: null, peerDomain: ORIGIN,
}, null);

test('B1: same-owner federated delivery with NO directory link → 403 DIRECTORY_LINK_REQUIRED (exemption removed)', async () => {
  const world = worldWithRecipient('usr_chris@primary.example');
  const { body, headers } = forwardPayload(world); // senderOwnerId defaults to usr_chris@primary.example == recipient owner
  const r = await acceptFederatedEnvelope(body, headers, opts9(world));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'DIRECTORY_LINK_REQUIRED');
  const inbox = await world.repo.listInbox(`ep_claude@${RELAY}`, '');
  assert.equal(inbox.length, 0, 'the forged same-owner envelope must not be delivered');
});
test('B1: same-owner federated delivery WITH an active self-pair link → 202 delivered', async () => {
  const world = worldWithRecipient('usr_chris@primary.example');
  await seedSelfPairLink(world);
  const { body, headers } = forwardPayload(world);
  const r = await acceptFederatedEnvelope(body, headers, opts9(world));
  assert.equal(r.status, 202);
  assert.equal(r.body.code, 'ACCEPTED');
  const inbox = await world.repo.listInbox(`ep_claude@${RELAY}`, '');
  assert.equal(inbox.length, 1);
  assert.equal(world.repo._debugGetEnvelope(inbox[0].message_id).federation_hop, true);
  assert.ok(world.repo._debugGetAuditEvents().some((e) => e.event_type === 'federation.inbound_accepted'));
});
test('cross-owner → 403 DIRECTORY_LINK_REQUIRED', async () => {
  const world = worldWithRecipient('usr_someone_else@b.example');
  const { body, headers } = forwardPayload(world);
  const r = await acceptFederatedEnvelope(body, headers, opts9(world));
  assert.equal(r.status, 403); assert.equal(r.body.code, 'DIRECTORY_LINK_REQUIRED');
});
test('envelope.sender.owner_id disagreeing with relay assertion → 403 SENDER_OWNER_ASSERTION_MISMATCH', async () => {
  const world = worldWithRecipient();
  const envelope = senderEnvelope(world.senderKeys.privateKey, { sender: { owner_id: 'usr_mismatch@primary.example', endpoint_id: `ep_codex@${ORIGIN}`, kind: 'agent' } });
  const { body, headers } = forwardPayload(world, {}, { envelope, senderOwnerId: 'usr_chris@primary.example' });
  const r = await acceptFederatedEnvelope(body, headers, opts9(world));
  assert.equal(r.status, 403); assert.equal(r.body.code, 'SENDER_OWNER_ASSERTION_MISMATCH');
});
test('unknown recipient → 400 RECIPIENT_NOT_FOUND', async () => {
  const world = worldWithRecipient();
  const envelope = senderEnvelope(world.senderKeys.privateKey, { recipient: { owner_id: 'usr_chris@primary.example', endpoint_id: `ep_ghost@${RELAY}`, kind: 'agent' } });
  const { body, headers } = forwardPayload(world, {}, { envelope });
  const r = await acceptFederatedEnvelope(body, headers, opts9(world));
  assert.equal(r.status, 400); assert.equal(r.body.code, 'RECIPIENT_NOT_FOUND');
});
// Brief fixture used created_at a full day before `now`, which trips
// validateEnvelope's created_at clock-skew guard (INVALID_ENVELOPE) before the
// lifetime guard. MESSAGE_EXPIRED in this codebase is the over-long-lifetime
// branch (validate-envelope.mjs:108) -- fixture aligned with Task 3's own
// MESSAGE_EXPIRED test (task-3-brief.md:59): current created_at, >24h lifetime.
test('expired envelope → 422 MESSAGE_EXPIRED', async () => {
  const world = worldWithRecipient();
  const envelope = senderEnvelope(world.senderKeys.privateKey, { created_at: '2026-08-30T12:00:00.000Z', expires_at: '2026-08-31T13:00:00.000Z' });
  const { body, headers } = forwardPayload(world, {}, { envelope });
  const r = await acceptFederatedEnvelope(body, headers, { ...opts9(world), now: new Date('2026-08-30T12:00:30.000Z') });
  assert.equal(r.status, 422); assert.equal(r.body.code, 'MESSAGE_EXPIRED');
});
test('re-POST of an accepted (sender.endpoint_id, idempotency_key) → 202 duplicate:true, no second delivery', async () => {
  const world = worldWithRecipient();
  await seedSelfPairLink(world);
  const { body, headers } = forwardPayload(world);
  await acceptFederatedEnvelope(body, headers, opts9(world));
  // B3: a legitimate peer retry carries a FRESH nonce; the envelope inside is
  // byte-identical, so the idempotency lookup still reports duplicate:true.
  const retry = forwardPayload(world, {}, { nonce: NONCE_2 });
  const r2 = await acceptFederatedEnvelope(retry.body, retry.headers, opts9(world));
  assert.equal(r2.status, 202); assert.equal(r2.body.duplicate, true);
  assert.equal((await world.repo.listInbox(`ep_claude@${RELAY}`, '')).length, 1);
});
test('replay: same message_id under a new idempotency_key → 409 REPLAY_DETECTED', async () => {
  const world = worldWithRecipient();
  await seedSelfPairLink(world);
  const { body, headers } = forwardPayload(world);
  await acceptFederatedEnvelope(body, headers, opts9(world));
  const envelope2 = senderEnvelope(world.senderKeys.privateKey, { idempotency_key: 'idem_2' });
  const p2 = forwardPayload(world, {}, { envelope: envelope2, nonce: NONCE_2 });
  const r = await acceptFederatedEnvelope(p2.body, p2.headers, opts9(world));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'REPLAY_DETECTED');
});

// --- Task 10 / B3: relay-request nonce consumed inside the transaction -------

test('B3: replaying a federated envelope with the same nonce -> 409 RELAY_REPLAYED', async () => {
  const world = worldWithRecipient('usr_chris@primary.example');
  await seedSelfPairLink(world);
  const { body, headers } = forwardPayload(world); // nonce comes from buildForwardRequest
  const first = await acceptFederatedEnvelope(body, headers, opts9(world));
  assert.equal(first.status, 202);
  const second = await acceptFederatedEnvelope(body, headers, { ...opts9(world), request_id: 'req_2' });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'RELAY_REPLAYED');
  // the replay is rejected before any second delivery
  assert.equal((await world.repo.listInbox(`ep_claude@${RELAY}`, '')).length, 1);
});

test('B3: signed_at outside the configured freshness window -> 401 RELAY_REQUEST_STALE, nothing delivered', async () => {
  const world = worldWithRecipient('usr_chris@primary.example');
  await seedSelfPairLink(world);
  const { body, headers } = forwardPayload(world, {}, { signedAt: new Date(SERVER_NOW.getTime() - 300_000) });
  const r = await acceptFederatedEnvelope(body, headers, { ...opts9(world), relayRequestFreshnessMs: 60_000 });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'RELAY_REQUEST_STALE');
  assert.equal((await world.repo.listInbox(`ep_claude@${RELAY}`, '')).length, 0);
});

test('B3: the stale rejection audits the origin domain AND the signed_at skew', async () => {
  // Spec Section 3 requires the skew on EVERY RELAY_REQUEST_STALE, from either
  // inbound route. The verifier throws before the envelope route's destructure
  // completes, so the audit row can only name an origin domain and a skew if
  // the failure carries the resolved peer and parsed body back out with it.
  const world = worldWithRecipient('usr_chris@primary.example');
  await seedSelfPairLink(world);
  const audits = [];
  const repo = { ...world.repo, recordAuditEvent: async (event) => { audits.push(event); } };
  const { body, headers } = forwardPayload(world, {}, { signedAt: new Date(SERVER_NOW.getTime() - 300_000) });

  const r = await acceptFederatedEnvelope(body, headers, { ...opts9(world), repository: repo, relayRequestFreshnessMs: 60_000 });
  assert.equal(r.status, 401);

  const stale = audits.find((e) => e.reason === 'RELAY_REQUEST_STALE');
  assert.ok(stale, 'a stale inbound relay request must be audited');
  assert.equal(stale.eventType, 'federation.inbound_rejected');
  assert.equal(stale.payload.origin_domain, ORIGIN);
  // The request was signed 300s before the server clock -> +300s of skew.
  assert.equal(stale.payload.signed_at_skew_seconds, 300);
});

// --- Task 12: step 8 active-link second pass --------------------------------
// The #3 tests run with the receiver relay on `b.example` and the sending peer
// on `a.example`. These cases invert that orientation (receiver `a.example`,
// sender `b.example`) so a link triple reads naturally as
// `(local=recipient owner, remote=sender owner, remote_domain=b.example)`.
// `seedFederatedInboundFixture` returns the repo (to seed a link row) and a
// `deliverForwardBody` that POSTs one signed inbound forward -> { status, body }.
const RECV_DOMAIN = 'a.example';
const SEND_DOMAIN = 'b.example';

async function seedFederatedInboundFixture({ recipient }) {
  const relayKeys = crypto.generateKeyPairSync('ed25519');
  const relayIdentity = { key_id: 'relay-b-2026-08', private_key_pem: relayKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const relayPub = relayKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const registry = new Map([[recipient.endpoint_id, {
    endpoint_id: recipient.endpoint_id, owner_id: recipient.owner_id,
    key_id: `key_${recipient.endpoint_id}`, kind: 'agent', status: 'active',
    public_key: crypto.generateKeyPairSync('ed25519').publicKey,
  }]]);
  const repository = createMemoryRepository({ registry });
  repository.upsertPeer({ domain: SEND_DOMAIN, relayUrl: 'https://b.example/relay', keys: [{ kid: relayIdentity.key_id, alg: 'Ed25519', publicKey: relayPub }], trustMode: 'tofu' });

  async function deliverForwardBody({ senderOwnerId, senderEndpoint }) {
    const senderKeys = crypto.generateKeyPairSync('ed25519');
    const senderPub = senderKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const base = {
      protocol: 'sigil/1', message_id: 'msg_fed_1', conversation_id: 'conv_1', message_type: 'chat.message',
      sender: { owner_id: senderOwnerId, endpoint_id: senderEndpoint, kind: 'agent' },
      recipient: { owner_id: recipient.owner_id, endpoint_id: recipient.endpoint_id, kind: 'agent' },
      body: { text: 'hi' }, context_refs: [], capabilities: [], idempotency_key: 'idem_1',
      created_at: '2026-08-30T12:00:00.000Z', expires_at: '2026-08-30T12:10:00.000Z',
    };
    const value = crypto.sign(null, signedBytes({ ...base, signature: undefined }), senderKeys.privateKey).toString('base64url');
    const envelope = { ...base, signature: { algorithm: 'Ed25519', key_id: `key_${senderEndpoint}`, value } };
    const { body } = buildForwardRequest(envelope, {
      originDomain: SEND_DOMAIN,
      senderKey: { kid: `key_${senderEndpoint}`, alg: 'Ed25519', publicKey: senderPub },
      senderOwnerId,
      now: SIGNED_AT,
      nonce: NONCE_OK,
    });
    const { signature, keyId } = signForwardRequest(canonicalJsonBytes(body), relayIdentity);
    const res = await acceptFederatedEnvelope(body, { 'sigil-relay-signature': signature, 'sigil-relay-key-id': keyId }, {
      repository, registered: registry, relayDomain: RECV_DOMAIN, request_id: 'req_1', now: SERVER_NOW,
    });
    return { status: res.status, body: res.body };
  }

  return { repository, deliverForwardBody };
}

test('step 8: cross-owner + an active federation directory link -> delivered and inbox-visible', async () => {
  const { repository, deliverForwardBody } = await seedFederatedInboundFixture({
    recipient: { endpoint_id: 'ep_claude@a.example', owner_id: 'usr_chris@a.example' },
  });
  await repository.createFederationDirectoryLink({
    linkRef: crypto.randomUUID(),
    localOwnerId: 'usr_chris@a.example', localEndpointId: 'ep_claude@a.example',
    remoteOwnerId: 'usr_bob@b.example', remoteEndpointId: 'ep_codex@b.example', remoteDomain: 'b.example',
    role: 'redeemer', status: 'active', localConfirmedAt: new Date(), remoteConfirmedAt: new Date(),
    sourceInviteId: null, peerDomain: 'b.example',
  }, null);
  const res = await deliverForwardBody({ senderOwnerId: 'usr_bob@b.example', senderEndpoint: 'ep_codex@b.example' });
  assert.equal(res.status, 202);
  assert.equal(res.body.code, 'ACCEPTED');
  const inbox = await repository.listInbox('ep_claude@a.example');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].envelope.message_id, 'msg_fed_1');
});

test('step 8: cross-owner + a pending / revoked / expired link, or no row -> 403 DIRECTORY_LINK_REQUIRED with reason', async () => {
  for (const linkStatus of ['pending', 'revoked', 'expired', null]) {
    const { repository, deliverForwardBody } = await seedFederatedInboundFixture({
      recipient: { endpoint_id: 'ep_claude@a.example', owner_id: 'usr_chris@a.example' },
    });
    if (linkStatus) {
      await repository.createFederationDirectoryLink({
        linkRef: crypto.randomUUID(), localOwnerId: 'usr_chris@a.example', localEndpointId: 'ep_claude@a.example',
        remoteOwnerId: 'usr_bob@b.example', remoteEndpointId: 'ep_codex@b.example', remoteDomain: 'b.example',
        role: 'redeemer', status: linkStatus, localConfirmedAt: null, remoteConfirmedAt: null,
        sourceInviteId: null, peerDomain: 'b.example',
      }, null);
    }
    const res = await deliverForwardBody({ senderOwnerId: 'usr_bob@b.example', senderEndpoint: 'ep_codex@b.example' });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'DIRECTORY_LINK_REQUIRED');
    assert.equal(res.body.details.reason, 'no_active_federation_directory_link');
  }
});

test('step 8: an active link for one remote owner does not authorise a different remote owner on the same domain', async () => {
  const { repository, deliverForwardBody } = await seedFederatedInboundFixture({
    recipient: { endpoint_id: 'ep_claude@a.example', owner_id: 'usr_chris@a.example' },
  });
  await repository.createFederationDirectoryLink({
    linkRef: crypto.randomUUID(), localOwnerId: 'usr_chris@a.example', localEndpointId: 'ep_claude@a.example',
    remoteOwnerId: 'usr_bob@b.example', remoteEndpointId: 'ep_codex@b.example', remoteDomain: 'b.example',
    role: 'redeemer', status: 'active', localConfirmedAt: new Date(), remoteConfirmedAt: new Date(),
    sourceInviteId: null, peerDomain: 'b.example',
  }, null);
  const res = await deliverForwardBody({ senderOwnerId: 'usr_dave@b.example', senderEndpoint: 'ep_dave@b.example' });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'DIRECTORY_LINK_REQUIRED');
  assert.equal(res.body.details.reason, 'no_active_federation_directory_link');
});

test('step 8 / B1: same-owner with NO link row -> 403 (exemption removed); with an active self-pair link -> 202', async () => {
  const noLink = await seedFederatedInboundFixture({
    recipient: { endpoint_id: 'ep_claude@a.example', owner_id: 'usr_shared@a.example' },
  });
  const rejected = await noLink.deliverForwardBody({ senderOwnerId: 'usr_shared@a.example', senderEndpoint: 'ep_codex@b.example' });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.code, 'DIRECTORY_LINK_REQUIRED');

  const withLink = await seedFederatedInboundFixture({
    recipient: { endpoint_id: 'ep_claude@a.example', owner_id: 'usr_shared@a.example' },
  });
  await withLink.repository.createFederationDirectoryLink({
    linkRef: crypto.randomUUID(),
    localOwnerId: 'usr_shared@a.example', localEndpointId: 'ep_claude@a.example',
    remoteOwnerId: 'usr_shared@a.example', remoteEndpointId: 'ep_codex@b.example',
    remoteDomain: 'b.example', role: 'issuer', initiatedVia: 'self_pair', status: 'active',
    localConfirmedAt: new Date(), remoteConfirmedAt: new Date(), sourceInviteId: null, peerDomain: 'b.example',
  }, null);
  const delivered = await withLink.deliverForwardBody({ senderOwnerId: 'usr_shared@a.example', senderEndpoint: 'ep_codex@b.example' });
  assert.equal(delivered.status, 202);
});
