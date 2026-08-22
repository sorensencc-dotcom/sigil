import test from 'node:test';
import assert from 'node:assert/strict';
import { generateInviteCode, hashMatchTarget, attemptDirectoryMatchOnOidcLogin } from './directory-trust.mjs';
import { boundedDirectoryExpiry, DIRECTORY_EXPIRY_MIN_MS, DIRECTORY_EXPIRY_MAX_MS } from './auth-policy.mjs';

test('generateInviteCode returns a high-entropy code and its sha256 hash', () => {
  const { code, codeHash } = generateInviteCode();
  assert.equal(typeof code, 'string');
  assert.ok(code.length >= 32);
  assert.equal(codeHash.length, 64);
  assert.notEqual(code, codeHash);
});

test('generateInviteCode never repeats across calls', () => {
  const first = generateInviteCode();
  const second = generateInviteCode();
  assert.notEqual(first.code, second.code);
});

test('hashMatchTarget is deterministic and never returns the raw value', () => {
  const a = hashMatchTarget('person@example.com');
  const b = hashMatchTarget('person@example.com');
  assert.equal(a, b);
  assert.notEqual(a, 'person@example.com');
});

test('boundedDirectoryExpiry defaults to 24h from now', () => {
  const now = new Date('2026-08-21T00:00:00Z');
  const expiry = boundedDirectoryExpiry({ now });
  assert.equal(expiry.toISOString(), '2026-08-22T00:00:00.000Z');
});

test('boundedDirectoryExpiry accepts a value within [1h, 7d]', () => {
  const now = new Date('2026-08-21T00:00:00Z');
  const expiry = boundedDirectoryExpiry({ now, expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000) });
  assert.equal(expiry.getTime(), now.getTime() + 2 * 60 * 60 * 1000);
});

test('boundedDirectoryExpiry rejects below the 1h floor', () => {
  const now = new Date('2026-08-21T00:00:00Z');
  assert.throws(() => boundedDirectoryExpiry({ now, expiresAt: new Date(now.getTime() + 30 * 60 * 1000) }), { code: 'DIRECTORY_EXPIRY_INVALID' });
});

test('boundedDirectoryExpiry rejects above the 7d ceiling', () => {
  const now = new Date('2026-08-21T00:00:00Z');
  assert.throws(() => boundedDirectoryExpiry({ now, expiresAt: new Date(now.getTime() + DIRECTORY_EXPIRY_MAX_MS + 1) }), { code: 'DIRECTORY_EXPIRY_INVALID' });
});

test('boundedDirectoryExpiry rejects a non-positive duration', () => {
  const now = new Date('2026-08-21T00:00:00Z');
  assert.throws(() => boundedDirectoryExpiry({ now, expiresAt: now }), { code: 'DIRECTORY_EXPIRY_INVALID' });
});

test('DIRECTORY_EXPIRY_MIN_MS and MAX_MS match spec §7 bounds', () => {
  assert.equal(DIRECTORY_EXPIRY_MIN_MS, 60 * 60 * 1000);
  assert.equal(DIRECTORY_EXPIRY_MAX_MS, 7 * 24 * 60 * 60 * 1000);
});

test('attemptDirectoryMatchOnOidcLogin forwards a verified email as the match target to claimDirectoryMatch', async () => {
  const calls = [];
  const repository = { claimDirectoryMatch: async (args) => { calls.push(args); return { request_id: 'dreq_1' }; } };
  const now = new Date('2026-08-22T00:00:00Z');
  const result = await attemptDirectoryMatchOnOidcLogin({ repository, issuer: 'https://issuer.example', verifiedEmail: 'person@example.com', matchedHumanId: 'usr_a', now });
  assert.deepEqual(result, { request_id: 'dreq_1' });
  assert.deepEqual(calls, [{ issuer: 'https://issuer.example', matchTarget: 'person@example.com', matchedHumanId: 'usr_a', now }]);
});

test('attemptDirectoryMatchOnOidcLogin is a no-op without a verified email or matched human', async () => {
  const repository = { claimDirectoryMatch: async () => { throw new Error('must not be called'); } };
  assert.equal(await attemptDirectoryMatchOnOidcLogin({ repository, issuer: 'https://issuer.example', verifiedEmail: null, matchedHumanId: 'usr_a' }), null);
  assert.equal(await attemptDirectoryMatchOnOidcLogin({ repository, issuer: 'https://issuer.example', verifiedEmail: 'person@example.com', matchedHumanId: null }), null);
});

test('attemptDirectoryMatchOnOidcLogin is a no-op when the repository has no claimDirectoryMatch method', async () => {
  const result = await attemptDirectoryMatchOnOidcLogin({ repository: {}, issuer: 'https://issuer.example', verifiedEmail: 'person@example.com', matchedHumanId: 'usr_a' });
  assert.equal(result, null);
});
