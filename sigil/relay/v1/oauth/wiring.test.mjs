import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { MOCK_OAUTH_ISSUER, validateOAuthConfig, resolvePublicPort, buildOAuthStack, readBody } from './wiring.mjs';
import { SESSION_COOKIE } from './cookies.mjs';

const GOOD = {
  databaseUrl: 'postgres://x/y',
  publicOrigin: 'https://rooms.test', port: 4000, publicPort: undefined,
  roomKeyWrapKey: 'SIGIL_WRAP', roomHumanIdentity: '/tmp/id.json',
  providers: [{ name: 'github', issuer: 'https://github.com' }], oidcIssuerAllowlist: new Set(['https://other.example']),
};

test('validateOAuthConfig accepts a good config', () => {
  assert.doesNotThrow(() => validateOAuthConfig(GOOD));
});

test('validateOAuthConfig rejects http: origin naming --public-origin', () => {
  assert.throws(() => validateOAuthConfig({ ...GOOD, publicOrigin: 'http://rooms.test' }), /--public-origin/);
  assert.throws(() => validateOAuthConfig({ ...GOOD, publicOrigin: 'not a url' }), /--public-origin/);
});

test('validateOAuthConfig rejects an origin with a path or trailing slash', () => {
  assert.throws(() => validateOAuthConfig({ ...GOOD, publicOrigin: 'https://rooms.test/' }), /--public-origin.*origin/);
  assert.throws(() => validateOAuthConfig({ ...GOOD, publicOrigin: 'https://rooms.test/app' }), /--public-origin.*origin/);
});

test('validateOAuthConfig requires --port', () => {
  assert.throws(() => validateOAuthConfig({ ...GOOD, port: 0 }), /--port/);
  assert.throws(() => validateOAuthConfig({ ...GOOD, port: undefined }), /--port/);
});

test('validateOAuthConfig requires wrap key and human identity by flag name', () => {
  assert.throws(() => validateOAuthConfig({ ...GOOD, roomKeyWrapKey: undefined }), /--room-key-wrap-key/);
  assert.throws(() => validateOAuthConfig({ ...GOOD, roomHumanIdentity: '' }), /--room-human-identity/);
});

test('validateOAuthConfig rejects a provider issuer present in the OIDC allowlist', () => {
  assert.throws(() => validateOAuthConfig({ ...GOOD, oidcIssuerAllowlist: new Set(['https://github.com']) }), /https:\/\/github\.com/);
  assert.throws(() => validateOAuthConfig({ ...GOOD, oidcIssuerAllowlist: ['https://github.com'] }), /allowlist/i);
});

test('resolvePublicPort', () => {
  assert.equal(resolvePublicPort({ port: 0 }), 0);
  assert.equal(resolvePublicPort({ port: 4000 }), 4002);
  assert.equal(resolvePublicPort({ port: 4000, publicPort: 5000 }), 5000);
  assert.equal(resolvePublicPort({ port: 4000, publicPort: 0 }), 0);
});

test('buildOAuthStack names the missing GitHub env variable', () => {
  const base = { repository: {}, publicOrigin: 'https://rooms.test', wrapKey: Buffer.alloc(32), operatorHumanId: 'h', ticketStore: {}, stream: {}, roomRouteContext: () => ({}), logger: null };
  assert.throws(() => buildOAuthStack({ ...base, env: { GITHUB_OAUTH_CLIENT_SECRET: 's' } }), /GITHUB_OAUTH_CLIENT_ID/);
  assert.throws(() => buildOAuthStack({ ...base, env: { GITHUB_OAUTH_CLIENT_ID: 'i' } }), /GITHUB_OAUTH_CLIENT_SECRET/);
  const stack = buildOAuthStack({ ...base, env: { GITHUB_OAUTH_CLIENT_ID: 'i', GITHUB_OAUTH_CLIENT_SECRET: 's' } });
  assert.equal(typeof stack.listener.listen, 'function');
  assert.ok(stack.providers.github);
  assert.ok(stack.flowStore);
});

test('buildOAuthStack dispatches authenticated contacts through its public listener', async (t) => {
  const agentLookups = [];
  const repository = {
    pool: {
      query: async () => ({
        rows: [{
          session_id: 'session',
          endpoint_id: 'ep_human',
          human_id: 'usr_human',
          expires_at: new Date(Date.now() + 60_000),
          revoked_at: null,
          last_seen_at: new Date(),
          identity_status: 'active',
          endpoint_kind: 'human',
          endpoint_status: 'active',
          display_name: 'Human',
          human_status: 'active',
        }],
      }),
    },
    lookupTrustedEndpoint: async (endpointId) => {
      agentLookups.push(endpointId);
      return { kind: 'human' };
    },
    listContacts: async () => [],
    createContact: async () => null,
    updateContact: async () => null,
    deleteContact: async () => false,
  };
  const stack = buildOAuthStack({
    repository,
    publicOrigin: 'https://rooms.test',
    wrapKey: Buffer.alloc(32),
    operatorHumanId: 'usr_human',
    ticketStore: {},
    stream: {},
    roomRouteContext: () => ({ registry: new Map(), now: new Date() }),
    env: { GITHUB_OAUTH_CLIENT_ID: 'i', GITHUB_OAUTH_CLIENT_SECRET: 's' },
  });
  await new Promise((resolve) => stack.listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => stack.listener.close(resolve)));

  const response = await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: stack.listener.address().port,
      method: 'GET',
      path: '/v1/me/contacts',
      headers: { cookie: `${SESSION_COOKIE}=session-cookie` },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body).items, []);
  assert.deepEqual(agentLookups, ['ep_human']);
});

const MOCK_BASE = { repository: {}, publicOrigin: 'https://rooms.test', wrapKey: Buffer.alloc(32), operatorHumanId: 'h', ticketStore: {}, stream: {}, roomRouteContext: () => ({}) };

test('validateOAuthConfig requires --database-url', () => {
  assert.throws(() => validateOAuthConfig({ ...GOOD, databaseUrl: undefined }), /--database-url/);
});

test('mock oauth: fixed mock credentials, mock issuer, real secret never sent', async () => {
  const stack = buildOAuthStack({ ...MOCK_BASE, enableMockOAuth: true, env: { SIGIL_MOCK_OAUTH_BASE_URL: 'http://127.0.0.1:9', GITHUB_OAUTH_CLIENT_ID: 'real-id', GITHUB_OAUTH_CLIENT_SECRET: 'REAL-SECRET' } });
  const github = stack.providers.github;
  assert.equal(github.issuer, MOCK_OAUTH_ISSUER);
  assert.ok(!github.authorizeUrl({ state: 's', codeChallenge: 'c', redirectUri: 'r' }).includes('real-id'));
});

test('mock oauth: identity uses the mock issuer and exchange sends mock-secret', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { requests.push({ url: String(url), body: String(init?.body ?? '') }); return { ok: true, json: async () => ({ access_token: 't', id: 7 }) }; };
  try {
    const { providers } = buildOAuthStack({ ...MOCK_BASE, enableMockOAuth: true, env: { SIGIL_MOCK_OAUTH_BASE_URL: 'http://localhost:9', GITHUB_OAUTH_CLIENT_SECRET: 'REAL-SECRET' } });
    await providers.github.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'r' });
    const identity = await providers.github.resolveIdentity({ accessToken: 't' });
    assert.equal(identity.issuer, MOCK_OAUTH_ISSUER);
    assert.ok(requests.every((r) => r.url.startsWith('http://localhost:9')));
    assert.ok(requests.every((r) => !r.body.includes('REAL-SECRET')));
    assert.ok(requests[0].body.includes('mock-secret'));
  } finally { globalThis.fetch = originalFetch; }
});

test('mock oauth: non-loopback or missing base URL rejected', () => {
  for (const base of [undefined, 'https://evil.example', 'http://127.0.0.1.evil.example', 'ftp://127.0.0.1', 'garbage']) {
    assert.throws(() => buildOAuthStack({ ...MOCK_BASE, enableMockOAuth: true, env: { SIGIL_MOCK_OAUTH_BASE_URL: base } }), /SIGIL_MOCK_OAUTH_BASE_URL/);
  }
});

test('readBody rejects on overflow and returns small bodies', async () => {
  assert.equal(await readBody(Readable.from(['abc']), 10), 'abc');
  await assert.rejects(readBody(Readable.from(['x'.repeat(20)]), 10), (e) => e.code === 'REQUEST_TOO_LARGE');
});
