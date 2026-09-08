import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonicalJsonBytes } from './jcs.mjs';
import {
  buildRedemptionRequest, buildConfirmationRequest, buildRevocationRequest,
  signRelayRequest, postDirectory, assertIssuerResponseIdentity,
} from './federation-directory-client.mjs';

const NOW = new Date('2026-09-02T12:00:00.000Z');
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA';

test('buildConfirmationRequest / buildRevocationRequest shapes carry nonce + signed_at, not confirmed_at/revoked_at', () => {
  const c = buildConfirmationRequest({ linkRef: 'L1', now: NOW, nonce: NONCE }).body;
  assert.deepEqual(c, { link_ref: 'L1', nonce: NONCE, signed_at: '2026-09-02T12:00:00.000Z' });
  const r = buildRevocationRequest({ linkRef: 'L1', now: NOW, nonce: NONCE }).body;
  assert.deepEqual(r, { link_ref: 'L1', nonce: NONCE, signed_at: '2026-09-02T12:00:00.000Z' });
});

test('buildRedemptionRequest body carries nonce + signed_at and no requested_at', () => {
  const { body, canonicalBytes } = buildRedemptionRequest({
    linkRef: 'L1', code: 'sigil-fed-invite:a.example:L1:SEG',
    redeemer: { owner_id: 'usr_b@b.example', endpoint_id: 'ep_c@b.example' },
    redeemerDomain: 'b.example', now: NOW, nonce: NONCE,
  });
  assert.equal(body.requested_at, undefined);
  assert.equal(body.nonce, NONCE);
  assert.equal(body.signed_at, '2026-09-02T12:00:00.000Z');
  assert.deepEqual(canonicalBytes, canonicalJsonBytes(body));
});

test('nonce defaults to 22 base64url chars when not provided', () => {
  const { body } = buildConfirmationRequest({ linkRef: 'L1', now: NOW });
  assert.match(body.nonce, /^[A-Za-z0-9_-]{22}$/);
});

test('signRelayRequest signs the exact bytes with the identity key', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const identity = { private_key_pem: privateKey.export({ format: 'pem', type: 'pkcs8' }), key_id: 'kid-a-1' };
  const bytes = canonicalJsonBytes({ link_ref: 'L1' });
  const { signature, keyId } = signRelayRequest(bytes, identity);
  assert.equal(keyId, 'kid-a-1');
  assert.equal(crypto.verify(null, bytes, publicKey, Buffer.from(signature, 'base64url')), true);
});

test('postDirectory: targets peer.relayUrl + path, redirect error, 2xx -> ok', async () => {
  let seenUrl, seenOpts;
  const fetchImpl = async (url, opts) => { seenUrl = url; seenOpts = opts; return { status: 202 }; };
  const res = await postDirectory({ relayUrl: 'https://relay.b.example' }, '/v1/federation/directory/redemptions',
    Buffer.from('{}'), { signature: 'sig', keyId: 'kid' }, { fetchImpl });
  assert.equal(seenUrl, 'https://relay.b.example/v1/federation/directory/redemptions');
  assert.equal(seenOpts.redirect, 'error');
  assert.equal(seenOpts.headers['Sigil-Relay-Key-Id'], 'kid');
  assert.deepEqual(res, { ok: true, status: 202 });
});

test('postDirectory: 4xx with a well-formed code -> peerCode; oversize/non-JSON -> omitted', async () => {
  const withCode = async () => ({ status: 403, body: null, text: async () => JSON.stringify({ code: 'INVALID_FEDERATION_INVITE' }) });
  assert.deepEqual(
    await postDirectory({ relayUrl: 'https://r' }, '/v1/federation/directory/redemptions', Buffer.from('{}'), { signature: 's', keyId: 'k' }, { fetchImpl: withCode }),
    { ok: false, status: 403, peerCode: 'INVALID_FEDERATION_INVITE' },
  );
  const junk = async () => ({ status: 400, body: null, text: async () => 'x'.repeat(5000) });
  assert.deepEqual(
    await postDirectory({ relayUrl: 'https://r' }, '/v1/federation/directory/confirmations', Buffer.from('{}'), { signature: 's', keyId: 'k' }, { fetchImpl: junk }),
    { ok: false, status: 400 },
  );
});

test('postDirectory: transport error / 5xx -> throws FORWARD_TRANSPORT_FAILED', async () => {
  await assert.rejects(
    postDirectory({ relayUrl: 'https://r' }, '/v1/federation/directory/revocations', Buffer.from('{}'), { signature: 's', keyId: 'k' }, { fetchImpl: async () => { throw new Error('econnrefused'); } }),
    (e) => e.code === 'FORWARD_TRANSPORT_FAILED',
  );
  await assert.rejects(
    postDirectory({ relayUrl: 'https://r' }, '/v1/federation/directory/revocations', Buffer.from('{}'), { signature: 's', keyId: 'k' }, { fetchImpl: async () => ({ status: 503 }) }),
    (e) => e.code === 'FORWARD_TRANSPORT_FAILED',
  );
});

test('assertIssuerResponseIdentity: accepts matching domain, rejects a foreign one', () => {
  assert.doesNotThrow(() => assertIssuerResponseIdentity(
    { owner_id: 'usr_x@issuer.example', endpoint_id: 'ep_i@issuer.example' }, 'issuer.example',
  ));
  // case-insensitive on both sides
  assert.doesNotThrow(() => assertIssuerResponseIdentity(
    { owner_id: 'usr_x@Issuer.Example', endpoint_id: 'ep_i@issuer.example' }, 'ISSUER.EXAMPLE',
  ));
  assert.throws(
    () => assertIssuerResponseIdentity({ owner_id: 'usr_x@evil.example', endpoint_id: 'ep_i@issuer.example' }, 'issuer.example'),
    (e) => e.code === 'ISSUER_IDENTITY_DOMAIN_MISMATCH',
  );
  assert.throws(
    () => assertIssuerResponseIdentity({ owner_id: 'usr_x@issuer.example', endpoint_id: 'ep_i@evil.example' }, 'issuer.example'),
    (e) => e.code === 'ISSUER_IDENTITY_DOMAIN_MISMATCH',
  );
  assert.throws(
    () => assertIssuerResponseIdentity({ owner_id: 'not-a-fid', endpoint_id: 'ep_i@issuer.example' }, 'issuer.example'),
    (e) => e.code === 'ISSUER_IDENTITY_DOMAIN_MISMATCH',
  );
});
