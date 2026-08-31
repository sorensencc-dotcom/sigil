import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { acceptFederatedEnvelope } from './accept-federated-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { buildForwardRequest, signForwardRequest } from './federation-router.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

const ORIGIN = 'a.example';
const RELAY = 'b.example';

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
  const { body, canonicalBytes } = buildForwardRequest(envelope, {
    originDomain: opts.originDomain ?? ORIGIN,
    senderKey: { kid: `key_ep_codex@${ORIGIN}`, alg: 'Ed25519', publicKey: opts.senderPub ?? world.senderPub },
    senderOwnerId: opts.senderOwnerId ?? 'usr_chris@primary.example',
    now: new Date('2026-08-30T12:00:05.000Z'),
  });
  const { signature, keyId } = signForwardRequest(canonicalBytes, opts.relayIdentity ?? world.relayIdentity);
  return { body, headers: { 'sigil-relay-signature': signature, 'sigil-relay-key-id': keyId } };
}

const baseOpts = (repo) => ({ repository: repo, registered: new Map(), relayDomain: RELAY, request_id: 'req_1', now: new Date('2026-08-30T12:00:30.000Z') });

test('check 1: structural garbage → 400 INVALID_FEDERATION_REQUEST', async () => {
  const world = makeWorld();
  const r = await acceptFederatedEnvelope({ origin_domain: 'not a domain', envelope: null }, {}, baseOpts(world.repo));
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
const opts9 = (world) => ({ repository: world.repo, registered: world.registered, relayDomain: RELAY, request_id: 'req_1', now: new Date('2026-08-30T12:00:30.000Z') });

test('same-owner exemption: relay-attested owner == recipient registry owner → 202 delivered, federation_hop stored', async () => {
  const world = worldWithRecipient('usr_chris@primary.example');
  const { body, headers } = forwardPayload(world);
  const r = await acceptFederatedEnvelope(body, headers, opts9(world));
  assert.equal(r.status, 202); assert.equal(r.body.code, 'ACCEPTED'); assert.equal(r.body.duplicate, false);
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
  const { body, headers } = forwardPayload(world);
  await acceptFederatedEnvelope(body, headers, opts9(world));
  const r2 = await acceptFederatedEnvelope(body, headers, opts9(world));
  assert.equal(r2.status, 202); assert.equal(r2.body.duplicate, true);
  assert.equal((await world.repo.listInbox(`ep_claude@${RELAY}`, '')).length, 1);
});
test('replay: same message_id under a new idempotency_key → 409 REPLAY_DETECTED', async () => {
  const world = worldWithRecipient();
  const { body, headers } = forwardPayload(world);
  await acceptFederatedEnvelope(body, headers, opts9(world));
  const envelope2 = senderEnvelope(world.senderKeys.privateKey, { idempotency_key: 'idem_2' });
  const p2 = forwardPayload(world, {}, { envelope: envelope2 });
  const r = await acceptFederatedEnvelope(p2.body, p2.headers, opts9(world));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'REPLAY_DETECTED');
});
