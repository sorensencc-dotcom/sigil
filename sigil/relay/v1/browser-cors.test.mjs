import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBrowserCors } from './browser-cors.mjs';

function res() {
  const headers = {};
  return { headers, statusCode: null, setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, writeHead(code, h = {}) { this.statusCode = code; Object.entries(h).forEach(([k, v]) => { headers[k.toLowerCase()] = v; }); }, end() { this.ended = true; } };
}
const req = (method, origin, extra = {}) => ({ method, headers: { ...(origin ? { origin } : {}), ...extra } });
const allowed = ['https://app.example'];

test('allowlisted origin gets CORS headers on a normal request', () => {
  const r = res();
  assert.equal(applyBrowserCors(req('POST', 'https://app.example'), r, allowed), 'continue');
  assert.equal(r.headers['access-control-allow-origin'], 'https://app.example');
  assert.match(r.headers.vary, /Origin/);
});

test('allowlisted preflight answers 204 with methods and headers', () => {
  const r = res();
  assert.equal(applyBrowserCors(req('OPTIONS', 'https://app.example', { 'access-control-request-method': 'POST' }), r, allowed), 'preflight');
  assert.equal(r.statusCode, 204);
  assert.match(r.headers['access-control-allow-methods'], /POST/);
  assert.match(r.headers['access-control-allow-headers'], /authorization/i);
});

test('another origin gets no CORS headers, and its preflight is refused', () => {
  const r = res();
  assert.equal(applyBrowserCors(req('GET', 'https://evil.example'), r, allowed), 'continue');
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  const p = res();
  assert.equal(applyBrowserCors(req('OPTIONS', 'https://evil.example', { 'access-control-request-method': 'POST' }), p, allowed), 'preflight');
  assert.equal(p.statusCode, 403);
  assert.equal(p.headers['access-control-allow-origin'], undefined);
});

test('no Origin header: untouched', () => {
  const r = res();
  assert.equal(applyBrowserCors(req('POST', null), r, allowed), 'continue');
  assert.deepEqual(r.headers, {});
});

test('with an empty allowlist no browser origin works', () => {
  const r = res();
  applyBrowserCors(req('GET', 'https://app.example'), r, []);
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

test('the origin is matched exactly: a different port or scheme does not match', () => {
  for (const origin of ['https://app.example:8443', 'http://app.example', 'https://app.example.evil.test']) {
    const r = res();
    applyBrowserCors(req('GET', origin), r, allowed);
    assert.equal(r.headers['access-control-allow-origin'], undefined, origin);
  }
});
