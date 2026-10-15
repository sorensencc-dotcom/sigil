import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newCookieSecret, hashCookie, parseCookies, setCookie, clearCookie, SESSION_COOKIE } from './cookies.mjs';

test('secret is 256 bits and hash is its sha256', () => {
  const { value, hash } = newCookieSecret();
  assert.equal(Buffer.from(value, 'base64url').length, 32);
  assert.equal(hash, crypto.createHash('sha256').update(value, 'utf8').digest('hex'));
  assert.equal(hashCookie(value), hash);
});
test('set and clear carry the __Host- attributes', () => {
  for (const header of [setCookie(SESSION_COOKIE, 'v', { maxAge: 10 }), clearCookie(SESSION_COOKIE)]) {
    for (const attr of ['Secure', 'Path=/', 'HttpOnly', 'SameSite=Lax']) assert.match(header, new RegExp(attr));
    assert.doesNotMatch(header, /Domain/i);
  }
  assert.match(clearCookie(SESSION_COOKIE), /Max-Age=0/);
});
test('parseCookies tolerates junk', () => {
  assert.deepEqual(parseCookies('a=1; b=2;;  c'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies(undefined), {});
});
