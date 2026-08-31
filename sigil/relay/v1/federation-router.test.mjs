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

import { postForward } from './federation-router.mjs';

const peer = { relayUrl: 'https://b.example/relay' };
const bytes = Buffer.from('{"x":1}', 'utf8');
const sig = { signature: 'SIG', keyId: 'k1' };
const res = ({ status, body = '', json }) => ({
  status, ok: status >= 200 && status < 300,
  text: async () => body,
  json: async () => (json ?? JSON.parse(body)),
});

test('2xx → ok:true and target URL is peer.relayUrl', async () => {
  let seenUrl, seenOpts;
  const fetchImpl = async (url, opts) => { seenUrl = url; seenOpts = opts; return res({ status: 202 }); };
  const out = await postForward(peer, bytes, sig, { fetchImpl });
  assert.deepEqual(out, { ok: true, status: 202 });
  assert.equal(String(seenUrl), 'https://b.example/relay/v1/federation/envelopes');
  assert.equal(seenOpts.redirect, 'error');
  assert.equal(seenOpts.headers['Sigil-Relay-Signature'], 'SIG');
  assert.equal(seenOpts.headers['Sigil-Relay-Key-Id'], 'k1');
});
test('4xx with well-formed { code } → ok:false + peerCode', async () => {
  const fetchImpl = async () => res({ status: 403, body: JSON.stringify({ code: 'DIRECTORY_LINK_REQUIRED', message: 'nope' }) });
  assert.deepEqual(await postForward(peer, bytes, sig, { fetchImpl }), { ok: false, status: 403, peerCode: 'DIRECTORY_LINK_REQUIRED' });
});
test('4xx with non-JSON body → ok:false, peerCode omitted', async () => {
  const fetchImpl = async () => res({ status: 400, body: '<html>bad</html>' });
  assert.deepEqual(await postForward(peer, bytes, sig, { fetchImpl }), { ok: false, status: 400 });
});
test('4xx with a code that fails the shape regex → peerCode omitted', async () => {
  const fetchImpl = async () => res({ status: 400, body: JSON.stringify({ code: 'not-a-code' }) });
  assert.deepEqual(await postForward(peer, bytes, sig, { fetchImpl }), { ok: false, status: 400 });
});
test('4xx body over 4 KiB → peerCode omitted', async () => {
  const big = JSON.stringify({ code: 'REAL_CODE', pad: 'x'.repeat(5000) });
  const fetchImpl = async () => res({ status: 400, body: big });
  assert.deepEqual(await postForward(peer, bytes, sig, { fetchImpl }), { ok: false, status: 400 });
});
test('5xx → throws FORWARD_TRANSPORT_FAILED', async () => {
  const fetchImpl = async () => res({ status: 503, body: 'nope' });
  await assert.rejects(() => postForward(peer, bytes, sig, { fetchImpl }), (e) => e.code === 'FORWARD_TRANSPORT_FAILED');
});
test('fetch rejection (timeout/transport) → throws FORWARD_TRANSPORT_FAILED', async () => {
  const fetchImpl = async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); };
  await assert.rejects(() => postForward(peer, bytes, sig, { fetchImpl }), (e) => e.code === 'FORWARD_TRANSPORT_FAILED');
});

import { verifyRelaySignature } from './federation-router.mjs';

function keyEntry(kid, publicKeyObj) {
  return { kid, alg: 'Ed25519', publicKey: publicKeyObj.export({ type: 'spki', format: 'der' }).toString('base64url') };
}

test('verifyRelaySignature: valid signature over canonical bytes verifies after re-canonicalization', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const body = { b: 2, a: 1 }; // deliberately non-canonical key order
  const signature = crypto.sign(null, canonicalJsonBytes(body), privateKey).toString('base64url');
  const peer = { keys: [keyEntry('k1', publicKey)] };
  assert.equal(verifyRelaySignature(body, { signature, keyId: 'k1', peer }), true);
});
test('tampered body → false', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signature = crypto.sign(null, canonicalJsonBytes({ a: 1 }), privateKey).toString('base64url');
  assert.equal(verifyRelaySignature({ a: 2 }, { signature, keyId: 'k1', peer: { keys: [keyEntry('k1', publicKey)] } }), false);
});
test('unknown keyId → false', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signature = crypto.sign(null, canonicalJsonBytes({ a: 1 }), privateKey).toString('base64url');
  assert.equal(verifyRelaySignature({ a: 1 }, { signature, keyId: 'nope', peer: { keys: [keyEntry('k1', publicKey)] } }), false);
});
test('kid reused with a swapped publicKey → false', () => {
  const a = crypto.generateKeyPairSync('ed25519');
  const b = crypto.generateKeyPairSync('ed25519');
  const signature = crypto.sign(null, canonicalJsonBytes({ a: 1 }), a.privateKey).toString('base64url');
  assert.equal(verifyRelaySignature({ a: 1 }, { signature, keyId: 'k1', peer: { keys: [keyEntry('k1', b.publicKey)] } }), false);
});
test('signature made over non-canonical bytes → false', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const badBytes = Buffer.from(JSON.stringify({ b: 2, a: 1 }), 'utf8'); // not JCS-ordered
  const signature = crypto.sign(null, badBytes, privateKey).toString('base64url');
  assert.equal(verifyRelaySignature({ b: 2, a: 1 }, { signature, keyId: 'k1', peer: { keys: [keyEntry('k1', publicKey)] } }), false);
});
