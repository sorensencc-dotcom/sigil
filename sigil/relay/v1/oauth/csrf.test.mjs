import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCookieCsrf, checkStartOrigin } from './csrf.mjs';

const O = 'https://rooms.example.com';
const req = (method, headers = {}) => ({ method, headers });

test('checkCookieCsrf table', () => {
  const cases = [
    ['POST right origin + header', req('POST', { origin: O, 'x-sigil-csrf': '1' }), true],
    ['POST missing header', req('POST', { origin: O }), false],
    ['POST wrong origin', req('POST', { origin: 'https://evil.example', 'x-sigil-csrf': '1' }), false],
    ['POST missing origin', req('POST', { 'x-sigil-csrf': '1' }), false],
    ['POST wrong header value', req('POST', { origin: O, 'x-sigil-csrf': '0' }), false],
    ['GET neither', req('GET'), true],
    ['HEAD neither', req('HEAD'), true],
  ];
  for (const [name, r, want] of cases) assert.equal(checkCookieCsrf(r, O), want, name);
});

test('checkStartOrigin table', () => {
  const cases = [
    ['foreign origin', req('POST', { origin: 'https://evil.example' }), false],
    ['missing origin', req('POST'), false],
    ['cross-site', req('POST', { origin: O, 'sec-fetch-site': 'cross-site' }), false],
    ['same-site', req('POST', { origin: O, 'sec-fetch-site': 'same-site' }), false],
    ['same-origin', req('POST', { origin: O, 'sec-fetch-site': 'same-origin' }), true],
    ['absent sec-fetch-site', req('POST', { origin: O }), true],
  ];
  for (const [name, r, want] of cases) assert.equal(checkStartOrigin(r, O), want, name);
});
