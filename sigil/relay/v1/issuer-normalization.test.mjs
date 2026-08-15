import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIssuer } from './issuer-normalization.mjs';

test('lowercases scheme and host', () => {
  assert.equal(normalizeIssuer('https://IDP.Example.COM/'), 'https://idp.example.com');
});

test('strips the default HTTPS port', () => {
  assert.equal(normalizeIssuer('https://idp.example.com:443/'), 'https://idp.example.com');
});

test('keeps a non-default port', () => {
  assert.equal(normalizeIssuer('https://idp.example.com:8443/tenant'), 'https://idp.example.com:8443/tenant');
});

test('collapses a trailing slash but preserves a root path as empty', () => {
  assert.equal(normalizeIssuer('https://idp.example.com/tenant/'), 'https://idp.example.com/tenant');
  assert.equal(normalizeIssuer('https://idp.example.com/'), 'https://idp.example.com');
  assert.equal(normalizeIssuer('https://idp.example.com'), 'https://idp.example.com');
});

test('resolves dot-segments in the path', () => {
  assert.equal(normalizeIssuer('https://idp.example.com/a/./b/../c/'), 'https://idp.example.com/a/c');
});

test('two issuer strings that differ only cosmetically normalize identically', () => {
  const a = normalizeIssuer('https://IDP.Example.com:443/tenant/./sub/../');
  const b = normalizeIssuer('https://idp.example.com/tenant');
  assert.equal(a, b);
});

test('rejects a non-HTTPS scheme', () => {
  assert.throws(() => normalizeIssuer('http://idp.example.com/'), { code: 'INVALID_ISSUER' });
});

test('rejects an unparseable string', () => {
  assert.throws(() => normalizeIssuer('not a url'), { code: 'INVALID_ISSUER' });
});

test('rejects userinfo in the issuer', () => {
  assert.throws(() => normalizeIssuer('https://user:pass@idp.example.com/'), { code: 'INVALID_ISSUER' });
});

test('rejects a query string', () => {
  assert.throws(() => normalizeIssuer('https://idp.example.com/?x=1'), { code: 'INVALID_ISSUER' });
});

test('rejects a fragment', () => {
  assert.throws(() => normalizeIssuer('https://idp.example.com/#frag'), { code: 'INVALID_ISSUER' });
});

test('rejects empty or non-string input', () => {
  assert.throws(() => normalizeIssuer(''), { code: 'INVALID_ISSUER' });
  assert.throws(() => normalizeIssuer('   '), { code: 'INVALID_ISSUER' });
  assert.throws(() => normalizeIssuer(undefined), { code: 'INVALID_ISSUER' });
  assert.throws(() => normalizeIssuer(null), { code: 'INVALID_ISSUER' });
});
