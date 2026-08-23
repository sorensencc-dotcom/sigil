import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverIssuer, createJwksCache } from './oidc-client.mjs';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
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
