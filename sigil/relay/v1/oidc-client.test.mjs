import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { discoverIssuer, createJwksCache, verifyRealIdToken, createDiscoveryCache } from './oidc-client.mjs';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

// --- Test-only signer helper for verifyRealIdToken fixtures --------------
// Signs tokens the same way a real IdP would, purely so tests have real
// tokens to verify against. Never exported from oidc-client.mjs itself.

function b64url(buffer) { return buffer.toString('base64url'); }

function signToken({ privateKey, alg, header = {}, payload }) {
  const fullHeader = { alg, typ: 'JWT', ...header };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(fullHeader)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const options = alg === 'ES256' ? { key: privateKey, dsaEncoding: 'ieee-p1363' } : { key: privateKey };
  const signature = crypto.sign(alg === 'ES256' ? 'sha256' : 'RSA-SHA256', Buffer.from(signingInput), options);
  return `${signingInput}.${b64url(signature)}`;
}

const rsaKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ecKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsaJwk = { ...rsaKeyPair.publicKey.export({ format: 'jwk' }), kid: 'rsa-key-1' };
const ecJwk = { ...ecKeyPair.publicKey.export({ format: 'jwk' }), kid: 'ec-key-1' };

const ISSUER = 'https://idp.example';
const CLIENT_ID = 'sigil-client-1';
const JWKS_URI = 'https://idp.example/jwks.json';

function makeCache(keys) {
  return createJwksCache({ fetchImpl: async () => jwksResponse(keys) });
}

const FIXED_NOW = new Date('2026-08-23T00:00:00Z');

function basePayload(overrides = {}) {
  const iat = Math.floor(FIXED_NOW.getTime() / 1000);
  return { iss: ISSUER, sub: 'sub_1', email: 'a@example.com', email_verified: true, aud: CLIENT_ID, iat, exp: iat + 300, jti: crypto.randomUUID(), ...overrides };
}

test('discoverIssuer rejects a non-https issuer', async () => {
  await assert.rejects(() => discoverIssuer('http://idp.example'), { code: 'INVALID_ID_TOKEN' });
});

test('discoverIssuer fetches the well-known discovery doc and returns jwksUri', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://idp.example/.well-known/openid-configuration');
    return jsonResponse({ issuer: 'https://idp.example', jwks_uri: 'https://idp.example/jwks.json' });
  };
  const result = await discoverIssuer('https://idp.example', { fetchImpl });
  assert.equal(result.jwksUri, 'https://idp.example/jwks.json');
});

test('discoverIssuer rejects when the discovery doc issuer does not match', async () => {
  const fetchImpl = async () => jsonResponse({ issuer: 'https://attacker.example', jwks_uri: 'https://idp.example/jwks.json' });
  await assert.rejects(() => discoverIssuer('https://idp.example', { fetchImpl }), { code: 'INVALID_ID_TOKEN' });
});

test('discoverIssuer rejects on a network error', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(() => discoverIssuer('https://idp.example', { fetchImpl }), { code: 'INVALID_ID_TOKEN' });
});

test('discoverIssuer rejects on a non-ok HTTP status', async () => {
  const fetchImpl = async () => jsonResponse({}, { ok: false, status: 500 });
  await assert.rejects(() => discoverIssuer('https://idp.example', { fetchImpl }), { code: 'INVALID_ID_TOKEN' });
});

test('discoverIssuer rejects on malformed JSON', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
  await assert.rejects(() => discoverIssuer('https://idp.example', { fetchImpl }), { code: 'INVALID_ID_TOKEN' });
});

test('discoverIssuer accepts a discovery doc issuer that differs only by trailing slash from the (already-normalized) requested issuer', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://idp.example/.well-known/openid-configuration');
    return jsonResponse({ issuer: 'https://idp.example/', jwks_uri: 'https://idp.example/jwks.json' });
  };
  const result = await discoverIssuer('https://idp.example', { fetchImpl });
  assert.equal(result.jwksUri, 'https://idp.example/jwks.json');
});

test('discoverIssuer and fetchJwks pass a timeout signal and redirect:"error" through to fetchImpl', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/.well-known/openid-configuration')) return jsonResponse({ issuer: 'https://idp.example', jwks_uri: 'https://idp.example/jwks.json' });
    return jsonResponse({ keys: [{ kid: 'some-kid', kty: 'RSA' }] });
  };
  await discoverIssuer('https://idp.example', { fetchImpl });
  const cache = createJwksCache({ fetchImpl });
  await cache.getKey('https://idp.example/jwks.json', 'some-kid', new Date());
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

function jwksResponse(keys) {
  return jsonResponse({ keys });
}

test('createJwksCache fetches and returns a key by kid', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount++; return jwksResponse([{ kid: 'key-1', kty: 'RSA' }]); };
  const cache = createJwksCache({ fetchImpl });
  const key = await cache.getKey('https://idp.example/jwks.json', 'key-1', new Date());
  assert.equal(key.kid, 'key-1');
  assert.equal(fetchCount, 1);
});

test('createJwksCache returns null when the kid is not found even after one refetch', async () => {
  const fetchImpl = async () => jwksResponse([{ kid: 'key-1', kty: 'RSA' }]);
  const cache = createJwksCache({ fetchImpl });
  const key = await cache.getKey('https://idp.example/jwks.json', 'missing-kid', new Date());
  assert.equal(key, null);
});

test('createJwksCache serves from cache within TTL without refetching', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount++; return jwksResponse([{ kid: 'key-1', kty: 'RSA' }]); };
  const cache = createJwksCache({ fetchImpl, ttlMs: 3600_000 });
  const t0 = new Date('2026-08-23T00:00:00Z');
  await cache.getKey('https://idp.example/jwks.json', 'key-1', t0);
  await cache.getKey('https://idp.example/jwks.json', 'key-1', new Date(t0.getTime() + 1000));
  assert.equal(fetchCount, 1);
});

test('createJwksCache refetches after TTL expiry', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount++; return jwksResponse([{ kid: 'key-1', kty: 'RSA' }]); };
  const cache = createJwksCache({ fetchImpl, ttlMs: 1000 });
  const t0 = new Date('2026-08-23T00:00:00Z');
  await cache.getKey('https://idp.example/jwks.json', 'key-1', t0);
  await cache.getKey('https://idp.example/jwks.json', 'key-1', new Date(t0.getTime() + 1001));
  assert.equal(fetchCount, 2);
});

test('createJwksCache refetches once on a kid miss even within TTL (rotation)', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount++;
    return fetchCount === 1 ? jwksResponse([{ kid: 'old-key', kty: 'RSA' }]) : jwksResponse([{ kid: 'new-key', kty: 'RSA' }]);
  };
  const cache = createJwksCache({ fetchImpl, ttlMs: 3600_000 });
  const t0 = new Date('2026-08-23T00:00:00Z');
  await cache.getKey('https://idp.example/jwks.json', 'old-key', t0);
  const key = await cache.getKey('https://idp.example/jwks.json', 'new-key', new Date(t0.getTime() + 1000));
  assert.equal(key.kid, 'new-key');
  assert.equal(fetchCount, 2);
});

test('createJwksCache does not refetch a second time for a kid miss within the cooldown window', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount++; return jwksResponse([{ kid: 'key-1', kty: 'RSA' }]); };
  const cache = createJwksCache({ fetchImpl, ttlMs: 3600_000, missCooldownMs: 10_000 });
  const t0 = new Date('2026-08-23T00:00:00Z');
  await cache.getKey('https://idp.example/jwks.json', 'missing', t0); // fetch #1 (initial), fetch #2 (miss refetch)
  await cache.getKey('https://idp.example/jwks.json', 'missing', new Date(t0.getTime() + 1000)); // within cooldown: no fetch #3
  assert.equal(fetchCount, 2);
});

test('createJwksCache allows a refetch again once the cooldown has elapsed', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount++; return jwksResponse([{ kid: 'key-1', kty: 'RSA' }]); };
  const cache = createJwksCache({ fetchImpl, ttlMs: 3600_000, missCooldownMs: 10_000 });
  const t0 = new Date('2026-08-23T00:00:00Z');
  await cache.getKey('https://idp.example/jwks.json', 'missing', t0); // fetch #1, #2
  await cache.getKey('https://idp.example/jwks.json', 'missing', new Date(t0.getTime() + 10_001)); // cooldown elapsed: fetch #3
  assert.equal(fetchCount, 3);
});

test('verifyRealIdToken: RS256 round trip succeeds and returns issuer/subject/email/jti', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload: basePayload() });
  const claims = await verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW });
  assert.equal(claims.issuer, ISSUER);
  assert.equal(claims.subject, 'sub_1');
  assert.equal(claims.email, 'a@example.com');
  assert.equal(typeof claims.jti, 'string');
});

test('verifyRealIdToken: ES256 round trip succeeds with a raw r||s signature', async () => {
  const token = signToken({ privateKey: ecKeyPair.privateKey, alg: 'ES256', header: { kid: ecJwk.kid }, payload: basePayload() });
  const claims = await verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([ecJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW });
  assert.equal(claims.subject, 'sub_1');
});

test('verifyRealIdToken: rejects alg/kty mismatch (RS256 header, EC key)', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: ecJwk.kid }, payload: basePayload() });
  await assert.rejects(
    () => verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([ecJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW }),
    { code: 'INVALID_ID_TOKEN' }
  );
});

test('verifyRealIdToken: rejects an unsupported alg (none)', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid, alg: 'none' }, payload: basePayload() });
  // Force header.alg to 'none' after signing so the signature itself is irrelevant to this check.
  const [, payloadSeg, sigSeg] = token.split('.');
  const noneHeader = b64url(Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: rsaJwk.kid })));
  const tampered = `${noneHeader}.${payloadSeg}.${sigSeg}`;
  await assert.rejects(
    () => verifyRealIdToken(tampered, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW }),
    { code: 'INVALID_ID_TOKEN' }
  );
});

test('verifyRealIdToken: rejects when kid is not found in the JWKS', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: 'unknown-kid' }, payload: basePayload() });
  await assert.rejects(
    () => verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW }),
    { code: 'INVALID_ID_TOKEN' }
  );
});

test('verifyRealIdToken: rejects a tampered signature', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload: basePayload() });
  const [header, payload, signature] = token.split('.');
  const tampered = `${header}.${payload}.${signature.slice(0, -4)}${signature.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
  await assert.rejects(
    () => verifyRealIdToken(tampered, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW }),
    { code: 'INVALID_ID_TOKEN' }
  );
});

test('verifyRealIdToken: rejects wrong aud', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload: basePayload({ aud: 'someone-else' }) });
  await assert.rejects(
    () => verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW }),
    { code: 'INVALID_ID_TOKEN' }
  );
});

test('verifyRealIdToken: accepts aud as an array containing clientId', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload: basePayload({ aud: ['other-app', CLIENT_ID] }) });
  const claims = await verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW });
  assert.equal(claims.subject, 'sub_1');
});

test('verifyRealIdToken: rejects mismatched azp even when aud matches', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload: basePayload({ aud: [CLIENT_ID], azp: 'a-different-app' }) });
  await assert.rejects(
    () => verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW }),
    { code: 'INVALID_ID_TOKEN' }
  );
});

test('verifyRealIdToken: rejects an expired token outside the 30s skew window', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload: basePayload() });
  const past = new Date(FIXED_NOW.getTime() + 300_000 + 31_000);
  await assert.rejects(
    () => verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => past }),
    { code: 'INVALID_ID_TOKEN' }
  );
});

test('verifyRealIdToken: rejects a token whose iat is in the future outside the 30s skew window', async () => {
  const futureIat = Math.floor(FIXED_NOW.getTime() / 1000) + 31;
  const token = signToken({
    privateKey: rsaKeyPair.privateKey,
    alg: 'RS256',
    header: { kid: rsaJwk.kid },
    payload: basePayload({ iat: futureIat, exp: futureIat + 300 })
  });
  await assert.rejects(
    () => verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW }),
    { code: 'INVALID_ID_TOKEN' }
  );
});

test('verifyRealIdToken: rejects email_verified: false', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload: basePayload({ email_verified: false }) });
  await assert.rejects(
    () => verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW }),
    { code: 'INVALID_ID_TOKEN' }
  );
});

test('verifyRealIdToken: accepts a token with no jti claim, returning jti: undefined', async () => {
  const payload = basePayload();
  delete payload.jti;
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload });
  const claims = await verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW });
  assert.equal(claims.jti, undefined);
});

test('verifyRealIdToken: returns exp as a number, for the caller to size the replay-guard TTL from', async () => {
  const payload = basePayload();
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload });
  const claims = await verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW });
  assert.equal(claims.exp, payload.exp);
});

// Regression test for the issuer-normalization gap: a real token's raw
// `iss` claim can differ from its normalized form only in ways
// normalizeIssuer treats as identical (here, a trailing slash). The caller
// (the /v1/auth/login route) normalizes the issuer once up front and passes
// that normalized value in as `issuer`; verifyRealIdToken must normalize
// payload.iss the same way before comparing, or every real token whose raw
// iss has a trailing slash would be rejected.
test('verifyRealIdToken: accepts a raw iss claim with a trailing slash when issuer is already normalized', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload: basePayload({ iss: `${ISSUER}/` }) });
  const claims = await verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW });
  assert.equal(claims.issuer, ISSUER);
});

test('verifyRealIdToken: rejects a malformed iss claim instead of crashing', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload: basePayload({ iss: 'not-a-url' }) });
  await assert.rejects(
    () => verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW }),
    { code: 'INVALID_ID_TOKEN' }
  );
});

// --- createDiscoveryCache -- mirrors createJwksCache's TTL/reuse tests ----

test('createDiscoveryCache fetches and returns a jwksUri', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount++; return jsonResponse({ issuer: ISSUER, jwks_uri: JWKS_URI }); };
  const cache = createDiscoveryCache({ fetchImpl });
  const jwksUri = await cache.getJwksUri(ISSUER, new Date());
  assert.equal(jwksUri, JWKS_URI);
  assert.equal(fetchCount, 1);
});

test('createDiscoveryCache serves from cache within TTL without a second discovery fetch', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount++; return jsonResponse({ issuer: ISSUER, jwks_uri: JWKS_URI }); };
  const cache = createDiscoveryCache({ fetchImpl, ttlMs: 3600_000 });
  const t0 = new Date('2026-08-23T00:00:00Z');
  await cache.getJwksUri(ISSUER, t0);
  await cache.getJwksUri(ISSUER, new Date(t0.getTime() + 1000));
  assert.equal(fetchCount, 1);
});

test('createDiscoveryCache refetches after TTL expiry', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount++; return jsonResponse({ issuer: ISSUER, jwks_uri: JWKS_URI }); };
  const cache = createDiscoveryCache({ fetchImpl, ttlMs: 1000 });
  const t0 = new Date('2026-08-23T00:00:00Z');
  await cache.getJwksUri(ISSUER, t0);
  await cache.getJwksUri(ISSUER, new Date(t0.getTime() + 1001));
  assert.equal(fetchCount, 2);
});

test('createDiscoveryCache caches per issuer independently', async () => {
  let fetchCount = 0;
  const otherIssuer = 'https://other.example';
  const fetchImpl = async (url) => {
    fetchCount++;
    return jsonResponse({ issuer: url.includes('other.example') ? otherIssuer : ISSUER, jwks_uri: JWKS_URI });
  };
  const cache = createDiscoveryCache({ fetchImpl, ttlMs: 3600_000 });
  const t0 = new Date('2026-08-23T00:00:00Z');
  await cache.getJwksUri(ISSUER, t0);
  await cache.getJwksUri(otherIssuer, t0);
  assert.equal(fetchCount, 2);
});
