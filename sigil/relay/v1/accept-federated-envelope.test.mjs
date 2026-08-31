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
test('checks 1-5 pass → reaches the stub (replaced in Task 9)', async () => {
  const world = makeWorld();
  const { body, headers } = forwardPayload(world);
  const r = await acceptFederatedEnvelope(body, headers, baseOpts(world.repo));
  assert.notEqual(r.status, 400);
  assert.notEqual(r.status, 401);
  assert.notEqual(r.status, 403);
});
