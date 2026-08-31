import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRoute } from './federation-router.mjs';

const envelope = (recipientEndpointId) => ({
  recipient: { endpoint_id: recipientEndpointId, owner_id: 'usr_chris@primary.example', kind: 'agent' },
  sender: { endpoint_id: 'ep_codex@a.example', owner_id: 'usr_chris@primary.example', kind: 'agent' },
});
const peers = new Map([['b.example', { domain: 'b.example', relayUrl: 'https://b.example/relay', keys: [{ kid: 'k1', alg: 'Ed25519', publicKey: 'AA' }], trustMode: 'tofu' }]]);
const getPeerByDomain = async (d) => peers.get(d) ?? null;

test('no relayDomain → local', async () => {
  assert.deepEqual(await decideRoute(envelope('ep_claude@b.example'), { relayDomain: undefined, federationMode: 'sync', getPeerByDomain }), { action: 'local' });
});
test('federationMode unset → delegates to checkRecipientLocality (foreign → throws RECIPIENT_NOT_LOCAL)', async () => {
  await assert.rejects(() => decideRoute(envelope('ep_claude@b.example'), { relayDomain: 'a.example', federationMode: undefined, getPeerByDomain }), (e) => e.code === 'RECIPIENT_NOT_LOCAL');
});
test('local-domain recipient → local', async () => {
  assert.deepEqual(await decideRoute(envelope('ep_x@a.example'), { relayDomain: 'a.example', federationMode: 'sync', getPeerByDomain }), { action: 'local' });
});
test('foreign recipient, unpinned → reject PEER_NOT_PINNED', async () => {
  const r = await decideRoute(envelope('ep_z@c.example'), { relayDomain: 'a.example', federationMode: 'sync', getPeerByDomain });
  assert.equal(r.action, 'reject'); assert.equal(r.code, 'PEER_NOT_PINNED'); assert.equal(r.details.recipientDomain, 'c.example');
});
test('foreign recipient, pinned → forward with peer', async () => {
  const r = await decideRoute(envelope('ep_claude@b.example'), { relayDomain: 'a.example', federationMode: 'sync', getPeerByDomain });
  assert.equal(r.action, 'forward'); assert.equal(r.peer.relayUrl, 'https://b.example/relay'); assert.equal(r.recipientDomain, 'b.example');
});
test('malformed federated recipient → MALFORMED_FEDERATED_ID', async () => {
  await assert.rejects(() => decideRoute(envelope('ep_claude_no_domain'), { relayDomain: 'a.example', federationMode: 'sync', getPeerByDomain }), (e) => e.code === 'MALFORMED_FEDERATED_ID');
});
test('stored federation_hop true → reject FEDERATION_HOP_EXCEEDED', async () => {
  const r = await decideRoute(envelope('ep_claude@b.example'), { relayDomain: 'a.example', federationMode: 'sync', getPeerByDomain, storedFederationHop: true });
  assert.equal(r.action, 'reject'); assert.equal(r.code, 'FEDERATION_HOP_EXCEEDED');
});

import crypto from 'node:crypto';
import { buildForwardRequest, signForwardRequest } from './federation-router.mjs';
import { canonicalJsonBytes } from './jcs.mjs';

const senderEnvelope = {
  protocol: 'sigil/1', message_id: 'msg_1', conversation_id: 'conv_1', message_type: 'chat.message',
  sender: { owner_id: 'usr_chris@primary.example', endpoint_id: 'ep_codex@a.example', kind: 'agent' },
  recipient: { owner_id: 'usr_chris@primary.example', endpoint_id: 'ep_claude@b.example', kind: 'agent' },
  body: { text: 'hi' }, context_refs: [], capabilities: [], idempotency_key: 'idem_1',
  created_at: '2026-08-30T12:00:00.000Z', expires_at: '2026-08-30T12:10:00.000Z',
  signature: { algorithm: 'Ed25519', key_id: 'key_ep_codex@a.example', value: 'ZZ' },
};

test('buildForwardRequest: canonicalBytes equals JCS of body and carries forwarded_at', () => {
  const now = new Date('2026-08-30T12:00:05.000Z');
  const { body, canonicalBytes } = buildForwardRequest(senderEnvelope, {
    originDomain: 'a.example', senderKey: { kid: 'key_ep_codex@a.example', alg: 'Ed25519', publicKey: 'PUB' },
    senderOwnerId: 'usr_chris@primary.example', now,
  });
  assert.equal(body.origin_domain, 'a.example');
  assert.equal(body.sender_owner_id, 'usr_chris@primary.example');
  assert.equal(body.forwarded_at, '2026-08-30T12:00:05.000Z');
  assert.deepEqual(body.envelope, senderEnvelope);
  assert.ok(Buffer.isBuffer(canonicalBytes));
  assert.equal(canonicalBytes.toString('utf8'), canonicalJsonBytes(body).toString('utf8'));
});

test('signForwardRequest: verifies against identity public key over canonicalBytes', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const identity = { key_id: 'key_ep_codex@a.example', private_key_pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const { canonicalBytes } = buildForwardRequest(senderEnvelope, {
    originDomain: 'a.example', senderKey: { kid: identity.key_id, alg: 'Ed25519', publicKey: 'PUB' },
    senderOwnerId: 'usr_chris@primary.example', now: new Date('2026-08-30T12:00:05.000Z'),
  });
  const { signature, keyId } = signForwardRequest(canonicalBytes, identity);
  assert.equal(keyId, 'key_ep_codex@a.example');
  assert.equal(crypto.verify(null, canonicalBytes, publicKey, Buffer.from(signature, 'base64url')), true);
});
