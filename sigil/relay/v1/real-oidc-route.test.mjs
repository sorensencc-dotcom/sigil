import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRelayServer } from './http-server.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

function request(port, { method, path, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method, path, headers: { 'content-type': 'application/json' } }, (response) => {
      let text = ''; response.on('data', (chunk) => text += chunk); response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function withServer(options, fn) {
  const server = createRelayServer(options);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try { return await fn(port); } finally { await new Promise((resolve) => server.close(resolve)); }
}

const FIXED_NOW = new Date('2026-08-23T00:00:00Z');
const ISSUER = 'https://idp.example';
const CLIENT_ID = 'sigil-client-1';
const JWKS_URI = 'https://idp.example/jwks.json';

function b64url(buffer) { return buffer.toString('base64url'); }
function signToken({ privateKey, alg = 'RS256', header = {}, payload }) {
  const fullHeader = { alg, typ: 'JWT', ...header };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(fullHeader)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const options = alg === 'ES256' ? { key: privateKey, dsaEncoding: 'ieee-p1363' } : { key: privateKey };
  const signature = crypto.sign(alg === 'ES256' ? 'sha256' : 'RSA-SHA256', Buffer.from(signingInput), options);
  return `${signingInput}.${b64url(signature)}`;
}

const rsaKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaJwk = { ...rsaKeyPair.publicKey.export({ format: 'jwk' }), kid: 'rsa-key-1' };

function basePayload(overrides = {}) {
  const iat = Math.floor(FIXED_NOW.getTime() / 1000);
  return { iss: ISSUER, sub: 'sub_1', email: 'a@example.com', email_verified: true, aud: CLIENT_ID, iat, exp: iat + 300, jti: crypto.randomUUID(), ...overrides };
}

function makeToken(overrides = {}) {
  return signToken({ privateKey: rsaKeyPair.privateKey, header: { kid: rsaJwk.kid }, payload: basePayload(overrides) });
}

function fetchImplFor(keys = [rsaJwk]) {
  return async (url) => {
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return { ok: true, status: 200, json: async () => ({ issuer: ISSUER, jwks_uri: JWKS_URI }) };
    }
    if (url === JWKS_URI) {
      return { ok: true, status: 200, json: async () => ({ keys }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

async function repositoryWithIssuer() {
  const repository = createMemoryRepository();
  repository._debugSeedOidcIssuer({ issuer: ISSUER, clientId: CLIENT_ID, enabled: true });
  return repository;
}

test('unrecognized issuer -- 401, no outbound fetch attempted', async () => {
  const repository = createMemoryRepository(); // no issuer seeded
  let fetchCalls = 0;
  const fetchImpl = async (...args) => { fetchCalls++; return fetchImplFor()(...args); };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImpl }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: makeToken() } });
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'INVALID_ID_TOKEN');
    assert.equal(fetchCalls, 0);
  });
});

test('success path creates a session and returns match: null when nothing pending', async () => {
  const repository = await repositoryWithIssuer();
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImplFor() }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: makeToken() } });
    assert.equal(result.status, 201);
    assert.equal(result.body.session.human_id, 'usr_1');
    assert.equal(result.body.match, null);
  });
});

test('missing principal.human_id -- 403, no writes performed', async () => {
  const repository = await repositoryWithIssuer();
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImplFor() }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: makeToken() } });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'HUMAN_CONTEXT_REQUIRED');
  });
});

test('disabled issuer -- 401 and no outbound fetch attempted', async () => {
  const repository = createMemoryRepository();
  repository._debugSeedOidcIssuer({ issuer: ISSUER, clientId: CLIENT_ID, enabled: false });
  let fetchCalls = 0;
  const fetchImpl = async (...args) => { fetchCalls++; return fetchImplFor()(...args); };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImpl }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: makeToken() } });
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'INVALID_ID_TOKEN');
    assert.equal(fetchCalls, 0);
  });
});

test('allow-listed issuer without client ID -- 401 and no outbound fetch attempted', async () => {
  const repository = createMemoryRepository();
  repository._debugSeedOidcIssuer({ issuer: ISSUER, enabled: true });
  let fetchCalls = 0;
  const fetchImpl = async (...args) => { fetchCalls++; return fetchImplFor()(...args); };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImpl }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: makeToken() } });
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'INVALID_ID_TOKEN');
    assert.equal(fetchCalls, 0);
  });
});
test('bad token (wrong aud) -- 401 INVALID_ID_TOKEN', async () => {
  const repository = await repositoryWithIssuer();
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImplFor() }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: makeToken({ aud: 'someone-else' }) } });
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'INVALID_ID_TOKEN');
  });
});

test('replayed token (same jti twice) -- second call 401 TOKEN_REPLAYED', async () => {
  const repository = await repositoryWithIssuer();
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImplFor() }, async (port) => {
    const token = makeToken();
    const first = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: token } });
    assert.equal(first.status, 201);
    const second = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: token } });
    assert.equal(second.status, 401);
    assert.equal(second.body.code, 'TOKEN_REPLAYED');
  });
});

test('token with no jti: first login succeeds, replaying the same token fails, a fresh token for the same subject succeeds', async () => {
  const repository = await repositoryWithIssuer();
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImplFor() }, async (port) => {
    const payload = basePayload(); delete payload.jti;
    const token = signToken({ privateKey: rsaKeyPair.privateKey, header: { kid: rsaJwk.kid }, payload });
    const first = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: token } });
    assert.equal(first.status, 201);
    const replay = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: token } });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.code, 'TOKEN_REPLAYED');
    const payload2 = basePayload({ iat: payload.iat + 1, exp: payload.exp + 1 }); delete payload2.jti;
    const token2 = signToken({ privateKey: rsaKeyPair.privateKey, header: { kid: rsaJwk.kid }, payload: payload2 });
    const second = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: token2 } });
    assert.equal(second.status, 201);
  });
});

test('IdP discovery endpoint unreachable -- 401, not a 5xx', async () => {
  const repository = await repositoryWithIssuer();
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImpl }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: makeToken() } });
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'INVALID_ID_TOKEN');
  });
});

test('login transaction failure returns a generic 500 without leaking raw database error text', async () => {
  const repository = await repositoryWithIssuer();
  repository.withTransaction = async () => { throw new Error('secret postgres connection string and SQLSTATE 23505'); };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImplFor() }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: makeToken() } });
    assert.equal(result.status, 500);
    assert.equal(result.body.code, 'REAL_LOGIN_FAILED');
    assert.equal(result.body.message, 'Login failed');
    assert.deepEqual(result.body.details, {});
    assert.doesNotMatch(JSON.stringify(result.body), /secret postgres connection string|23505/);
  });
});

test('allow-list lookup failure returns 503 without leaking raw database error text', async () => {
  const repository = createMemoryRepository();
  repository.getOidcIssuerAllowlistEntry = async () => { throw new Error('secret database host:5432 password=not-for-clients'); };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImplFor() }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: makeToken() } });
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'REAL_LOGIN_UNAVAILABLE');
    assert.equal(result.body.message, 'OIDC issuer allowlist lookup failed');
    assert.deepEqual(result.body.details, {});
    assert.doesNotMatch(JSON.stringify(result.body), /secret database host|password=not-for-clients/);
  });
});
// Regression test for the issuer-normalization gap (finding #1): the
// allow-list is seeded under the *normalized* issuer (as the real
// oidc_issuer_allowlist table always is), but the raw token's `iss` claim
// carries a trailing slash -- a form normalizeIssuer treats as identical to
// ISSUER, but which the pre-fix route compared un-normalized. Login must
// still succeed, proving the route normalizes the issuer before every
// downstream use (allow-list lookup, discovery, directory-match).
test('token iss claim has a trailing slash (non-normalized) but allow-list is seeded under the normalized issuer -- login still succeeds', async () => {
  const repository = await repositoryWithIssuer(); // seeded under ISSUER = 'https://idp.example' (normalized)
  const fetchImpl = async (url) => {
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return { ok: true, status: 200, json: async () => ({ issuer: `${ISSUER}/`, jwks_uri: JWKS_URI }) };
    }
    if (url === JWKS_URI) return { ok: true, status: 200, json: async () => ({ keys: [rsaJwk] }) };
    throw new Error(`Unexpected fetch: ${url}`);
  };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImpl }, async (port) => {
    const token = makeToken({ iss: `${ISSUER}/` });
    const result = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: token } });
    assert.equal(result.status, 201);
    assert.equal(result.body.session.human_id, 'usr_1');
  });
});

// Regression test for finding #2: proves the directory-match hook actually
// fires end-to-end through the real /v1/auth/login route (not just at the
// normalization-function level) -- mirrors mock-oidc-route.test.mjs's
// "success path fires a match when one is pending" pattern, but against a
// real, in-memory-repository-backed pending match request.
test('success path fires a pending directory match when one exists for this issuer/target', async () => {
  const repository = await repositoryWithIssuer();
  const pending = await repository.createDirectoryMatchRequest({
    issuerEndpointId: 'ep_other', issuerHumanId: 'usr_other', issuer: ISSUER, matchTarget: 'a@example.com',
    expiresAt: new Date(FIXED_NOW.getTime() + 3600_000), homeRelay: 'local', now: FIXED_NOW,
  });
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImplFor() }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: makeToken({ email: 'a@example.com' }) } });
    assert.equal(result.status, 201);
    assert.ok(result.body.match);
    assert.equal(result.body.match.request_id, pending.request_id);
  });
});

// Regression test for finding #4: discovery must be cached the same way
// JWKS is -- a second login for the same issuer must not trigger a second
// outbound discovery fetch.
test('a second login for the same issuer does not trigger a second discovery fetch', async () => {
  const repository = await repositoryWithIssuer();
  let discoveryCalls = 0;
  const fetchImpl = async (url) => {
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      discoveryCalls++;
      return { ok: true, status: 200, json: async () => ({ issuer: ISSUER, jwks_uri: JWKS_URI }) };
    }
    if (url === JWKS_URI) return { ok: true, status: 200, json: async () => ({ keys: [rsaJwk] }) };
    throw new Error(`Unexpected fetch: ${url}`);
  };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImpl }, async (port) => {
    const first = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: makeToken() } });
    assert.equal(first.status, 201);
    const second = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: makeToken() } });
    assert.equal(second.status, 201);
    assert.equal(discoveryCalls, 1);
  });
});
