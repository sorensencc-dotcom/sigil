import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { validateOAuthConfig, resolvePublicPort, buildOAuthStack, readBody } from './wiring.mjs';

const GOOD = {
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

test('buildOAuthStack: mock oauth needs no credentials but real mode does', () => {
  const base = { repository: {}, publicOrigin: 'https://rooms.test', wrapKey: Buffer.alloc(32), operatorHumanId: 'h', ticketStore: {}, stream: {}, roomRouteContext: () => ({}) };
  const stack = buildOAuthStack({ ...base, env: { SIGIL_MOCK_OAUTH_BASE_URL: 'http://127.0.0.1:1' }, enableMockOAuth: true });
  assert.ok(stack.providers.github);
});

test('readBody rejects on overflow and returns small bodies', async () => {
  assert.equal(await readBody(Readable.from(['abc']), 10), 'abc');
  await assert.rejects(readBody(Readable.from(['x'.repeat(20)]), 10), (e) => e.code === 'REQUEST_TOO_LARGE');
});
