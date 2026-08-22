import test from 'node:test';
import assert from 'node:assert/strict';
import { generateInviteCode, hashMatchTarget } from './directory-trust.mjs';
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
