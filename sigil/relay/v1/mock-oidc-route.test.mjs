import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';
import { signMockIdToken } from './mock-oidc.mjs';
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

const FIXED_NOW = new Date('2026-08-22T00:00:00Z');

function fakeRepository(overrides = {}) {
  return {
    async withTransaction(fn) { return fn(null); },
    async consumeLoginJti() {},
    async createHumanSession({ sessionId, humanId }) { return { session_id: sessionId, human_id: humanId, authentication_method: 'mock_oidc', assurance: 'standard', issued_at: FIXED_NOW.toISOString(), expires_at: FIXED_NOW.toISOString(), revoked_at: null }; },
    async recordAuditEvent() { return {}; },
    async claimDirectoryMatch() { return null; },
    ...overrides,
  };
}

test('enableMockOidc: false (default) -- route does not exist, returns 404', async () => {
  await withServer({ repository: fakeRepository(), authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }) }, async (port) => {
    const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
    const result = await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: token } });
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'CONTEXT_NOT_FOUND');
  });
});

test('success path creates a session and returns match: null when nothing pending', async () => {
  await withServer({ enableMockOidc: true, repository: fakeRepository(), authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW }, async (port) => {
    const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
    const result = await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: token } });
    assert.equal(result.status, 201);
    assert.equal(result.body.code, 'OK');
    assert.equal(result.body.session.human_id, 'usr_1');
    assert.equal(result.body.match, null);
  });
});

test('success path fires a match when one is pending', async () => {
  const repository = fakeRepository({ async claimDirectoryMatch() { return { request_id: 'dreq_1' }; } });
  await withServer({ enableMockOidc: true, repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW }, async (port) => {
    const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
    const result = await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: token } });
    assert.equal(result.status, 201);
    assert.equal(result.body.match.request_id, 'dreq_1');
  });
});

test('missing principal.human_id -- 403 HUMAN_CONTEXT_REQUIRED, no writes performed', async () => {
  let writes = 0;
  const repository = fakeRepository({ async consumeLoginJti() { writes++; }, async createHumanSession() { writes++; return {}; } });
  await withServer({ enableMockOidc: true, repository, authenticate: async () => ({ endpoint_id: 'ep_1' }), now: () => FIXED_NOW }, async (port) => {
    const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
    const result = await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: token } });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'HUMAN_CONTEXT_REQUIRED');
    assert.equal(writes, 0);
  });
});

test('bad token (tampered signature) -- 401 INVALID_ID_TOKEN, no writes performed', async () => {
  let writes = 0;
  const repository = fakeRepository({ async consumeLoginJti() { writes++; }, async createHumanSession() { writes++; return {}; } });
  await withServer({ enableMockOidc: true, repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW }, async (port) => {
    const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
    const tampered = token.slice(0, -4) + (token.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    const result = await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: tampered } });
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'INVALID_ID_TOKEN');
    assert.equal(writes, 0);
  });
});

test('replayed jti -- second call returns 401 TOKEN_REPLAYED', async () => {
  const usedJtis = new Set();
  const repository = fakeRepository({
    async consumeLoginJti(jti) {
      if (usedJtis.has(jti)) throw Object.assign(new Error('replayed'), { code: 'TOKEN_REPLAYED' });
      usedJtis.add(jti);
    },
  });
  await withServer({ enableMockOidc: true, repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW }, async (port) => {
    const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
    const first = await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: token } });
    assert.equal(first.status, 201);
    const second = await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: token } });
    assert.equal(second.status, 401);
    assert.equal(second.body.code, 'TOKEN_REPLAYED');
  });
});

test('oversized request body returns 413, same as every other route', async () => {
  await withServer({ enableMockOidc: true, repository: fakeRepository(), authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW }, async (port) => {
    const oversized = 'a'.repeat(1024 * 1024 + 1);
    const result = await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: oversized } });
    assert.equal(result.status, 413);
  });
});

test('audit event payload matches the created session', async () => {
  const audits = [];
  const repository = fakeRepository({ async recordAuditEvent(event) { audits.push(event); return {}; } });
  await withServer({ enableMockOidc: true, repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW }, async (port) => {
    const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
    await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: token } });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].eventType, 'human_session.created');
    assert.equal(audits[0].actorHumanId, 'usr_1');
    assert.equal(audits[0].endpointId, 'ep_1');
    assert.equal(audits[0].outcome, 'success');
  });
});

test('a token signed with a different issuer is rejected with 401 INVALID_ID_TOKEN', async () => {
  let writes = 0;
  const repository = fakeRepository({ async consumeLoginJti() { writes++; }, async createHumanSession() { writes++; return {}; } });
  await withServer({ enableMockOidc: true, repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW }, async (port) => {
    const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', issuer: 'https://attacker.example/forged', now: FIXED_NOW });
    const result = await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: token } });
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'INVALID_ID_TOKEN');
    assert.equal(writes, 0);
  });
});

// Regression test for a bug the hand-rolled fakeRepository() above hid: it
// already defines recordAuditEvent, so it never exercised the real
// createMemoryRepository() (sigil/cli/memory-repository.mjs) -- the
// no-Postgres default `sigil relay up --enable-mock-oidc` uses -- which had
// no recordAuditEvent method at all, throwing a TypeError on every call.
test('full success flow against the real in-memory repository records an audit event', async () => {
  const repository = createMemoryRepository();
  await withServer({ enableMockOidc: true, repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW }, async (port) => {
    const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
    const result = await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: token } });
    assert.equal(result.status, 201);
    assert.equal(result.body.code, 'OK');
    assert.equal(result.body.session.human_id, 'usr_1');
    const audits = repository._debugGetAuditEvents();
    assert.equal(audits.length, 1);
    assert.equal(audits[0].event_type, 'human_session.created');
    assert.equal(audits[0].actor_human_id, 'usr_1');
    assert.equal(audits[0].endpoint_id, 'ep_1');
    assert.equal(audits[0].outcome, 'success');
  });
});
