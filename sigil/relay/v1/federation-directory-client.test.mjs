import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonicalJsonBytes } from './jcs.mjs';
import {
  buildRedemptionRequest, buildConfirmationRequest, buildRevocationRequest,
  signRelayRequest, postDirectory,
} from './federation-directory-client.mjs';

const NOW = new Date('2026-09-02T12:00:00.000Z');

test('buildRedemptionRequest: canonicalBytes is both the wire body and the signing input', () => {
  const { body, canonicalBytes } = buildRedemptionRequest({
    linkRef: 'L1', code: 'sigil-fed-invite:a.example:L1:SEG',
    redeemer: { owner_id: 'usr_bob@b.example', endpoint_id: 'ep_c@b.example' },
    redeemerDomain: 'b.example', now: NOW,
  });
  assert.deepEqual(body, {
    link_ref: 'L1', code: 'sigil-fed-invite:a.example:L1:SEG',
    redeemer: { owner_id: 'usr_bob@b.example', endpoint_id: 'ep_c@b.example' },
    redeemer_domain: 'b.example', requested_at: '2026-09-02T12:00:00.000Z',
  });
  assert.deepEqual(canonicalBytes, canonicalJsonBytes(body));
});

test('buildConfirmationRequest / buildRevocationRequest shapes', () => {
  assert.deepEqual(buildConfirmationRequest({ linkRef: 'L1', now: NOW }).body, { link_ref: 'L1', confirmed_at: '2026-09-02T12:00:00.000Z' });
  assert.deepEqual(buildRevocationRequest({ linkRef: 'L1', now: NOW }).body, { link_ref: 'L1', revoked_at: '2026-09-02T12:00:00.000Z' });
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
