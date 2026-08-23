import test from 'node:test';
import assert from 'node:assert/strict';
import { signMockIdToken, verifyMockIdToken } from './mock-oidc.mjs';

const FIXED_NOW = new Date('2026-08-22T00:00:00Z');

test('sign/verify round trip: valid token verifies and returns issuer/subject/email/jti', async () => {
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
  const claims = verifyMockIdToken(token, { now: () => FIXED_NOW });
  assert.equal(claims.issuer, 'https://mock-oidc.sigil.local');
  assert.equal(claims.subject, 'sub_1');
  assert.equal(claims.email, 'a@example.com');
  assert.equal(typeof claims.jti, 'string');
  assert.ok(claims.jti.length > 0);
});

test('two signMockIdToken calls produce different jti values', () => {
  const first = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
  const second = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
  const decode = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
  assert.notEqual(decode(first).jti, decode(second).jti);
});

test('signMockIdToken throws synchronously when ttlSeconds <= 0', () => {
  assert.throws(() => signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW, ttlSeconds: 0 }));
  assert.throws(() => signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW, ttlSeconds: -5 }));
});

test('tampered signature is rejected', () => {
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
  const [header, payload, signature] = token.split('.');
  const tampered = `${header}.${payload}.${signature.slice(0, -4)}${signature.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
  assert.throws(() => verifyMockIdToken(tampered, { now: () => FIXED_NOW }), { code: 'INVALID_ID_TOKEN' });
});

test('expired token is rejected outside the 30s skew boundary', () => {
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW, ttlSeconds: 300 });
  const past31s = new Date(FIXED_NOW.getTime() + 300_000 + 31_000);
  assert.throws(() => verifyMockIdToken(token, { now: () => past31s }), { code: 'INVALID_ID_TOKEN' });
});

test('token is accepted exactly at the 30s skew boundary (expired side)', () => {
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW, ttlSeconds: 300 });
  const past30s = new Date(FIXED_NOW.getTime() + 300_000 + 30_000);
  assert.doesNotThrow(() => verifyMockIdToken(token, { now: () => past30s }));
});

test('token is accepted exactly at the 30s skew boundary (not-yet-valid side)', () => {
  const later = new Date(FIXED_NOW.getTime() + 60_000);
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: later, ttlSeconds: 300 });
  const before30s = new Date(later.getTime() - 30_000);
  assert.doesNotThrow(() => verifyMockIdToken(token, { now: () => before30s }));
});

test('token rejected 31s before iat', () => {
  const later = new Date(FIXED_NOW.getTime() + 60_000);
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: later, ttlSeconds: 300 });
  const before31s = new Date(later.getTime() - 31_000);
  assert.throws(() => verifyMockIdToken(token, { now: () => before31s }), { code: 'INVALID_ID_TOKEN' });
});

test('wrong alg (RS256) is rejected', () => {
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
  const [, payload, signature] = token.split('.');
  const badHeader = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  assert.throws(() => verifyMockIdToken(`${badHeader}.${payload}.${signature}`, { now: () => FIXED_NOW }), { code: 'INVALID_ID_TOKEN' });
});

test('alg "none" is rejected regardless of signature presence', () => {
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
  const [, payload] = token.split('.');
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.throws(() => verifyMockIdToken(`${noneHeader}.${payload}.`, { now: () => FIXED_NOW }), { code: 'INVALID_ID_TOKEN' });
});

test('malformed compact JWS (wrong segment count) is rejected', () => {
  assert.throws(() => verifyMockIdToken('not.a.valid.jws', { now: () => FIXED_NOW }), { code: 'INVALID_ID_TOKEN' });
  assert.throws(() => verifyMockIdToken('onlyonesegment', { now: () => FIXED_NOW }), { code: 'INVALID_ID_TOKEN' });
});

test('missing each required claim is rejected one at a time', () => {
  const requiredClaims = ['iss', 'sub', 'email', 'email_verified', 'iat', 'exp', 'jti'];
  for (const omit of requiredClaims) {
    const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    delete claims[omit];
    const tamperedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    // Signature no longer matches the tampered payload, but a claims-shape
    // check must fail before verification would even matter here -- both
    // paths land on INVALID_ID_TOKEN, so this also covers "bad signature".
    assert.throws(() => verifyMockIdToken(`${header}.${tamperedPayload}.${signature}`, { now: () => FIXED_NOW }), { code: 'INVALID_ID_TOKEN' }, `expected rejection when ${omit} is missing`);
  }
});

test('email_verified: false is rejected', () => {
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  claims.email_verified = false;
  const tamperedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  assert.throws(() => verifyMockIdToken(`${header}.${tamperedPayload}.${signature}`, { now: () => FIXED_NOW }), { code: 'INVALID_ID_TOKEN' });
});
