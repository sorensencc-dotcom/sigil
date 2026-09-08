import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonicalJsonBytes } from './jcs.mjs';
import { verifyInboundRelayRequest } from './federation-relay-auth.mjs';

function makePeer() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const kid = 'kid-b-1';
  const peer = { domain: 'b.example', relayUrl: 'https://relay.b.example', keys: [{ kid, alg: 'Ed25519', publicKey: spki }] };
  return { peer, privateKey, kid };
}
function sign(privateKey, bytes) { return crypto.sign(null, bytes, privateKey).toString('base64url'); }

const NONCE_OK = 'abcdefghijklmnopqrstuv'; // 22 chars, base64url alphabet

function signedBody(extra = {}) {
  return { link_ref: '11111111-1111-1111-1111-111111111111', nonce: NONCE_OK, signed_at: new Date('2026-09-06T12:00:00.000Z').toISOString(), ...extra };
}

test('a valid signed request passes and reports originDomain from the kid', async () => {
  const { peer, privateKey, kid } = makePeer();
  const body = { link_ref: '11111111-1111-1111-1111-111111111111', confirmed_at: '2026-09-02T00:00:00.000Z', nonce: NONCE_OK, signed_at: new Date().toISOString() };
  const raw = Buffer.from(JSON.stringify(body));
  const headers = { 'sigil-relay-signature': sign(privateKey, canonicalJsonBytes(body)), 'sigil-relay-key-id': kid };
  const getPeerByKid = async (k) => (k === kid ? peer : null);
  const res = await verifyInboundRelayRequest(raw, headers, { getPeerByKid });
  assert.equal(res.ok, true);
  assert.equal(res.originDomain, 'b.example');
  assert.deepEqual(res.parsedBody, body);
});

test('malformed JSON body -> 400 INVALID_FEDERATION_REQUEST', async () => {
  await assert.rejects(
    verifyInboundRelayRequest(Buffer.from('{not json'), { 'sigil-relay-key-id': 'x' }, { getPeerByKid: async () => null }),
    (e) => e.code === 'INVALID_FEDERATION_REQUEST' && e.httpStatus === 400,
  );
});

test('absent Sigil-Relay-Key-Id -> 401 RELAY_SIGNATURE_INVALID', async () => {
  await assert.rejects(
    verifyInboundRelayRequest(Buffer.from('{}'), {}, { getPeerByKid: async () => null }),
    (e) => e.code === 'RELAY_SIGNATURE_INVALID' && e.httpStatus === 401,
  );
});

test('kid names no pinned peer -> 403 PEER_NOT_TRUSTED', async () => {
  await assert.rejects(
    verifyInboundRelayRequest(Buffer.from('{}'), { 'sigil-relay-key-id': 'nope', 'sigil-relay-signature': 'x' }, { getPeerByKid: async () => null }),
    (e) => e.code === 'PEER_NOT_TRUSTED' && e.httpStatus === 403,
  );
});

test('tampered body fails signature -> 401', async () => {
  const { peer, privateKey, kid } = makePeer();
  const signed = { link_ref: 'a', confirmed_at: 'b' };
  const headers = { 'sigil-relay-signature': sign(privateKey, canonicalJsonBytes(signed)), 'sigil-relay-key-id': kid };
  const tampered = Buffer.from(JSON.stringify({ link_ref: 'a', confirmed_at: 'DIFFERENT' }));
  await assert.rejects(
    verifyInboundRelayRequest(tampered, headers, { getPeerByKid: async () => peer }),
    (e) => e.code === 'RELAY_SIGNATURE_INVALID',
  );
});

test('kid reused with a swapped publicKey fails closed', async () => {
  const { peer, kid } = makePeer();
  const other = crypto.generateKeyPairSync('ed25519');
  const body = { link_ref: 'a' };
  const headers = { 'sigil-relay-signature': sign(other.privateKey, canonicalJsonBytes(body)), 'sigil-relay-key-id': kid };
  await assert.rejects(
    verifyInboundRelayRequest(Buffer.from(JSON.stringify(body)), headers, { getPeerByKid: async () => peer }),
    (e) => e.code === 'RELAY_SIGNATURE_INVALID',
  );
});

test('valid request returns nonce and signedAtMs', async () => {
  const { peer, privateKey, kid } = makePeer();
  const body = signedBody();
  const headers = { 'sigil-relay-signature': sign(privateKey, canonicalJsonBytes(body)), 'sigil-relay-key-id': kid };
  const res = await verifyInboundRelayRequest(Buffer.from(JSON.stringify(body)), headers, {
    getPeerByKid: async () => peer, now: new Date('2026-09-06T12:00:10.000Z'), freshnessMs: 300_000,
  });
  assert.equal(res.nonce, NONCE_OK);
  assert.equal(res.signedAtMs, Date.parse(body.signed_at));
});

test('signed_at outside the freshness window -> 401 RELAY_REQUEST_STALE', async () => {
  const { peer, privateKey, kid } = makePeer();
  const body = signedBody();
  const headers = { 'sigil-relay-signature': sign(privateKey, canonicalJsonBytes(body)), 'sigil-relay-key-id': kid };
  await assert.rejects(
    verifyInboundRelayRequest(Buffer.from(JSON.stringify(body)), headers, {
      getPeerByKid: async () => peer, now: new Date('2026-09-06T13:00:00.000Z'), freshnessMs: 300_000,
    }),
    (e) => e.code === 'RELAY_REQUEST_STALE' && e.httpStatus === 401,
  );
});

test('nonce with a wrong length or non-base64url char -> 400 INVALID_FEDERATION_REQUEST', async () => {
  const { peer, privateKey, kid } = makePeer();
  for (const bad of ['tooshort', 'abcdefghijklmnopqrstu+', 'abcdefghijklmnopqrstuvw']) {
    const body = signedBody({ nonce: bad });
    const headers = { 'sigil-relay-signature': sign(privateKey, canonicalJsonBytes(body)), 'sigil-relay-key-id': kid };
    await assert.rejects(
      verifyInboundRelayRequest(Buffer.from(JSON.stringify(body)), headers, {
        getPeerByKid: async () => peer, now: new Date('2026-09-06T12:00:10.000Z'), freshnessMs: 300_000,
      }),
      (e) => e.code === 'INVALID_FEDERATION_REQUEST' && e.httpStatus === 400,
    );
  }
});
