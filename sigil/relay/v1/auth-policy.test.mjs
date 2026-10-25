import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_LINK_TTL_MS, assertAccountLinkCeremony, assertAllowedIssuer, assertAssurance, boundedTokenExpiry, boundedCapabilityGrantExpiry, CAPABILITY_GRANT_MAX_LIFETIME_MS } from './auth-policy.mjs';

test('auth policy requires configured OIDC allow-list', () => {
  assert.throws(() => assertAllowedIssuer('https://idp.example', new Set()), (error) => error.code === 'OIDC_PROVIDER_NOT_CONFIGURED');
  assert.equal(assertAllowedIssuer('https://idp.example', new Set(['https://idp.example'])), 'https://idp.example');
  assert.throws(() => assertAllowedIssuer('https://evil.example', new Set(['https://idp.example'])), (error) => error.code === 'OIDC_PROVIDER_NOT_ALLOWED');
});

test('auth policy bounds endpoint tokens to 24 hours', () => {
  const now = new Date('2026-01-01T00:00:00Z'); assert.equal(boundedTokenExpiry({ now }).getTime() - now.getTime(), 24 * 60 * 60 * 1000);
  assert.throws(() => boundedTokenExpiry({ now, expiresAt: '2026-01-02T00:00:01Z' }), (error) => error.code === 'TOKEN_LIFETIME_INVALID');
});

test('auth policy bounds capability grants to 24 hours', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const validExpiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000); // 12 hours
  const maxExpiresAt = new Date(now.getTime() + CAPABILITY_GRANT_MAX_LIFETIME_MS); // exactly 24 hours

  assert.equal(boundedCapabilityGrantExpiry({ now, expiresAt: validExpiresAt }).getTime(), validExpiresAt.getTime());
  assert.equal(boundedCapabilityGrantExpiry({ now, expiresAt: maxExpiresAt }).getTime(), maxExpiresAt.getTime());

  assert.throws(() => boundedCapabilityGrantExpiry({ now, expiresAt: new Date(now.getTime() + CAPABILITY_GRANT_MAX_LIFETIME_MS + 1) }), (error) => error.code === 'GRANT_LIFETIME_INVALID');
  assert.throws(() => boundedCapabilityGrantExpiry({ now, expiresAt: now }), (error) => error.code === 'GRANT_LIFETIME_INVALID');
  assert.throws(() => boundedCapabilityGrantExpiry({ now, expiresAt: new Date(now.getTime() - 1000) }), (error) => error.code === 'GRANT_LIFETIME_INVALID');
  assert.throws(() => boundedCapabilityGrantExpiry({ now, expiresAt: 'invalid' }), (error) => error.code === 'GRANT_LIFETIME_INVALID');
});

test('auth policy restricts assurance and account-link ceremony lifetime', () => {
  assert.equal(assertAssurance('high'), 'high'); assert.throws(() => assertAssurance('admin'), (error) => error.code === 'ASSURANCE_LEVEL_INVALID');
  const now = new Date('2026-01-01T00:00:00Z'); assert.equal(assertAccountLinkCeremony({ nonceHash: 'n', stateHash: 's', issuedAt: now, expiresAt: new Date(now.getTime() + ACCOUNT_LINK_TTL_MS), now }), true);
  assert.throws(() => assertAccountLinkCeremony({ nonceHash: 'n', stateHash: 's', issuedAt: now, expiresAt: new Date(now.getTime() + ACCOUNT_LINK_TTL_MS + 1), now }), (error) => error.code === 'ACCOUNT_LINK_CEREMONY_INVALID');
});
