// sigil/relay/v1/federation-regression.test.mjs
//
// Task 19 regression sweep for the inter-relay routing sub-project. Locks in
// three "federation stays opt-in" invariants on the origin accept path plus
// one case-sensitivity invariant on the federated-inbound recipient lookup.
//
// Fixture helpers are copied verbatim from the tests that already build them:
//   - `signedEnvelope`        <- validate-envelope.skip-sender.test.mjs (Task 3)
//   - `senderEnvelope` / `forwardPayload` / `worldWithRecipient` / `opts9`
//                             <- accept-federated-envelope.test.mjs (Tasks 8-9)
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { acceptFederatedEnvelope } from './accept-federated-envelope.mjs';
import { buildForwardRequest, signForwardRequest } from './federation-router.mjs';
import { canonicalJsonBytes } from './jcs.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

// --- verbatim from validate-envelope.skip-sender.test.mjs ---------------------
function signedEnvelope(privateKey, keyId, overrides = {}) {
  const base = {
    protocol: 'sigil/1', message_id: 'msg_fed_1', conversation_id: 'conv_1', message_type: 'chat.message',
    sender: { owner_id: 'usr_chris@primary.example', endpoint_id: 'ep_codex@a.example', kind: 'agent' },
    recipient: { owner_id: 'usr_chris@primary.example', endpoint_id: 'ep_claude@b.example', kind: 'agent' },
    body: { text: 'hi' }, context_refs: [], capabilities: [], idempotency_key: 'idem_1',
    created_at: '2026-08-30T12:00:00.000Z', expires_at: '2026-08-30T12:10:00.000Z',
    ...overrides,
  };
  const sig = crypto.sign(null, signedBytes({ ...base, signature: undefined }), privateKey).toString('base64url');
  return { ...base, signature: { algorithm: 'Ed25519', key_id: keyId, value: sig } };
}

const NOW = new Date('2026-08-30T12:00:30.000Z');
// Task 4: the inbound relay verifier requires a fresh signed_at plus a 22-char
// base64url nonce on every relay request body. Task 10 threads `options.now`
// into the verifier, so `signed_at` is stamped from SIGNED_AT (25s before the
// pinned NOW) rather than wall-clock time, and each request in a test that
// posts more than once needs its own nonce.
const NONCE_OK = 'abcdefghijklmnopqrstuv';
const NONCE_2 = 'bcdefghijklmnopqrstuvw';
const SIGNED_AT = new Date('2026-08-30T12:00:05.000Z');

test('a --domain relay with NO --federation-mode still rejects a foreign recipient RECIPIENT_NOT_LOCAL', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = 'key_ep_codex@a.example';
  const envelope = signedEnvelope(privateKey, keyId); // recipient ep_claude@b.example
  const registered = new Map([['ep_codex@a.example', {
    endpoint_id: 'ep_codex@a.example', owner_id: 'usr_chris@primary.example', key_id: keyId, status: 'active', public_key: publicKey,
  }]]);
  const repository = createMemoryRepository({ registry: new Map() });

  const res = await acceptEnvelopeAsync(envelope, {
    repository, registered, relayDomain: 'a.example', now: NOW, request_id: 'req_1',
    // no federationMode: decideRoute must fall straight back to checkRecipientLocality
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'RECIPIENT_NOT_LOCAL');
});

test('a --domain relay with NO --federation-mode still accepts a matching-domain recipient', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = 'key_ep_codex@a.example';
  const envelope = signedEnvelope(privateKey, keyId, {
    recipient: { owner_id: 'usr_chris@primary.example', endpoint_id: 'ep_claude@a.example', kind: 'agent' },
  });
  const registered = new Map([
    ['ep_codex@a.example', { endpoint_id: 'ep_codex@a.example', owner_id: 'usr_chris@primary.example', key_id: keyId, status: 'active', public_key: publicKey }],
    ['ep_claude@a.example', { endpoint_id: 'ep_claude@a.example', owner_id: 'usr_chris@primary.example', status: 'active' }],
  ]);
  const repository = createMemoryRepository({
    registry: new Map([['ep_claude@a.example', { endpoint_id: 'ep_claude@a.example', owner_id: 'usr_chris@primary.example', status: 'active' }]]),
  });

  const res = await acceptEnvelopeAsync(envelope, {
    repository, registered, relayDomain: 'a.example', now: NOW, request_id: 'req_1',
  });

  assert.equal(res.status, 202);
  assert.equal(res.body.code, 'ACCEPTED');
});

test('a relay with NO --domain runs no federation logic (bare ids still work)', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = 'key_ep_codex';
  const envelope = signedEnvelope(privateKey, keyId, {
    sender: { owner_id: 'usr_chris@primary.example', endpoint_id: 'ep_codex', kind: 'agent' },
    recipient: { owner_id: 'usr_chris@primary.example', endpoint_id: 'ep_claude', kind: 'agent' },
  });
  const registered = new Map([
    ['ep_codex', { endpoint_id: 'ep_codex', owner_id: 'usr_chris@primary.example', key_id: keyId, status: 'active', public_key: publicKey }],
    ['ep_claude', { endpoint_id: 'ep_claude', owner_id: 'usr_chris@primary.example', status: 'active' }],
  ]);
  const repository = createMemoryRepository({
    registry: new Map([['ep_claude', { endpoint_id: 'ep_claude', owner_id: 'usr_chris@primary.example', status: 'active' }]]),
  });

  const res = await acceptEnvelopeAsync(envelope, {
    repository, registered, now: NOW, request_id: 'req_1',
    // no relayDomain, no federationMode
  });

  assert.equal(res.status, 202);
  assert.equal(res.body.code, 'ACCEPTED');
});

// --- verbatim from accept-federated-envelope.test.mjs ------------------------
const ORIGIN = 'a.example';
const RELAY = 'b.example';

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
const opts9 = (world) => ({ repository: world.repo, registered: world.registered, relayDomain: RELAY, request_id: 'req_1', now: NOW });

test('two federated recipients differing only in local-part case stay distinct through the federated-inbound registry lookup', async () => {
  const world = worldWithRecipient('usr_chris@primary.example'); // ep_claude@b.example -> usr_chris@primary.example
  // Second entry: identical but for the capital "C" in the local part, owned by
  // a different human. A case-folding lookup would collapse the two.
  world.registered.set(`ep_Claude@${RELAY}`, {
    endpoint_id: `ep_Claude@${RELAY}`, owner_id: 'usr_other@b.example', key_id: `key_ep_Claude@${RELAY}`,
    kind: 'agent', status: 'active', public_key: crypto.generateKeyPairSync('ed25519').publicKey,
  });
  assert.notEqual(world.registered.get(`ep_claude@${RELAY}`), world.registered.get(`ep_Claude@${RELAY}`));
  assert.equal(world.registered.size, 2);

  // A: lower-case recipient, same owner as the relay-attested sender. The
  // same-owner exemption is gone (B1), so an active self-pair directory link
  // authorises the delivery -> 202 ACCEPTED.
  await world.repo.createFederationDirectoryLink({
    linkRef: crypto.randomUUID(),
    localOwnerId: 'usr_chris@primary.example', localEndpointId: `ep_claude@${RELAY}`,
    remoteOwnerId: 'usr_chris@primary.example', remoteEndpointId: `ep_codex@${ORIGIN}`,
    remoteDomain: ORIGIN, role: 'issuer', initiatedVia: 'self_pair', status: 'active',
    localConfirmedAt: new Date(), remoteConfirmedAt: new Date(), sourceInviteId: null, peerDomain: ORIGIN,
  }, null);
  const a = forwardPayload(world);
  const ra = await acceptFederatedEnvelope(a.body, a.headers, opts9(world));
  assert.equal(ra.status, 202);
  assert.equal(ra.body.code, 'ACCEPTED');

  // B: capitalised recipient resolves to the *other* registry entry (owner
  // usr_other@b.example) -> cross-owner -> 403 DIRECTORY_LINK_REQUIRED. A
  // different outcome for an id that differs only in case proves the lookup
  // kept the two entries distinct.
  const envelopeB = senderEnvelope(world.senderKeys.privateKey, {
    message_id: 'msg_fed_2', idempotency_key: 'idem_2',
    recipient: { owner_id: 'usr_chris@primary.example', endpoint_id: `ep_Claude@${RELAY}`, kind: 'agent' },
  });
  const b = forwardPayload(world, {}, { envelope: envelopeB, nonce: NONCE_2 });
  const rb = await acceptFederatedEnvelope(b.body, b.headers, opts9(world));
  assert.equal(rb.status, 403);
  assert.equal(rb.body.code, 'DIRECTORY_LINK_REQUIRED');
});

test('federated envelope: body origin_domain disagreeing with the signing kid -> 403 PEER_NOT_TRUSTED', async () => {
  const world = worldWithRecipient('usr_chris@primary.example');
  // Pin a second peer c.example with its own distinct relay key so the body's
  // mutated origin_domain still resolves under the (pre-refactor) domain-pinned
  // check. The signing kid, however, stays a.example's relay key.
  const cKeys = crypto.generateKeyPairSync('ed25519');
  await world.repo.upsertPeer({
    domain: 'c.example', relayUrl: 'https://c.example/relay',
    keys: [{ kid: 'relay-c-2026-08', alg: 'Ed25519', publicKey: cKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') }],
    trustMode: 'tofu',
  });

  // Well-formed forward body from a.example, then origin_domain is mutated to
  // "c.example" and the request is re-signed by a.example's relay key. The kid
  // resolves to a.example while the body claims c.example.
  const envelope = senderEnvelope(world.senderKeys.privateKey);
  const { body } = buildForwardRequest(envelope, {
    originDomain: ORIGIN,
    senderKey: { kid: `key_ep_codex@${ORIGIN}`, alg: 'Ed25519', publicKey: world.senderPub },
    senderOwnerId: 'usr_chris@primary.example',
    now: SIGNED_AT,
    nonce: NONCE_OK,
  });
  body.origin_domain = 'c.example';
  const raw = Buffer.from(canonicalJsonBytes(body));
  const { signature, keyId } = signForwardRequest(raw, world.relayIdentity);

  const res = await acceptFederatedEnvelope(
    body,
    { 'sigil-relay-signature': signature, 'sigil-relay-key-id': keyId },
    { ...opts9(world), rawBody: raw },
  );

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'PEER_NOT_TRUSTED');
});
