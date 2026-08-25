import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDomain, parseFederatedId, formatFederatedId, isLocalDomain, resolveDomainOrThrow } from './federated-id.mjs';

test('parseDomain accepts a simple dotted hostname', () => {
  assert.deepEqual(parseDomain('relay.example.com'), { host: 'relay.example.com', port: null });
});

test('parseDomain accepts a hostname with a valid port', () => {
  assert.deepEqual(parseDomain('relay.example.com:8443'), { host: 'relay.example.com', port: 8443 });
});

test('parseDomain accepts the "local" sentinel without dots', () => {
  assert.deepEqual(parseDomain('local'), { host: 'local', port: null });
});

test('parseDomain accepts "localhost" without dots', () => {
  assert.deepEqual(parseDomain('localhost'), { host: 'localhost', port: null });
});

test('parseDomain rejects a bare label that is not local/localhost', () => {
  assert.throws(() => parseDomain('relay'), (error) => error.code === 'INVALID_DOMAIN_SYNTAX');
});

test('parseDomain rejects underscores', () => {
  assert.throws(() => parseDomain('relay_1.example.com'), (error) => error.code === 'INVALID_DOMAIN_SYNTAX');
});

test('parseDomain rejects a label over 63 characters', () => {
  const longLabel = 'a'.repeat(64);
  assert.throws(() => parseDomain(`${longLabel}.example.com`), (error) => error.code === 'INVALID_DOMAIN_SYNTAX');
});

test('parseDomain rejects a domain over 253 characters total', () => {
  const longDomain = Array.from({ length: 40 }, () => 'abcdefg').join('.') + '.com';
  assert.throws(() => parseDomain(longDomain), (error) => error.code === 'INVALID_DOMAIN_SYNTAX');
});

test('parseDomain rejects non-ASCII characters', () => {
  assert.throws(() => parseDomain('relay.exämple.com'), (error) => error.code === 'INVALID_DOMAIN_SYNTAX');
});

test('parseDomain rejects a non-numeric port', () => {
  assert.throws(() => parseDomain('relay.example.com:abc'), (error) => error.code === 'INVALID_PORT');
});

test('parseDomain rejects a port of 0', () => {
  assert.throws(() => parseDomain('relay.example.com:0'), (error) => error.code === 'INVALID_PORT');
});

test('parseDomain rejects a port over 65535', () => {
  assert.throws(() => parseDomain('relay.example.com:70000'), (error) => error.code === 'INVALID_PORT');
});

test('parseFederatedId splits local-part and domain', () => {
  assert.deepEqual(parseFederatedId('ep_codex@relay.example.com'), { localPart: 'ep_codex', domain: 'relay.example.com' });
});

test('parseFederatedId rejects an id with no @', () => {
  assert.throws(() => parseFederatedId('ep_codex'), (error) => error.code === 'MALFORMED_FEDERATED_ID');
});

test('parseFederatedId rejects an id with multiple @', () => {
  assert.throws(() => parseFederatedId('ep_codex@relay@example.com'), (error) => error.code === 'MALFORMED_FEDERATED_ID');
});

test('parseFederatedId rejects an empty local part', () => {
  assert.throws(() => parseFederatedId('@relay.example.com'), (error) => error.code === 'MALFORMED_FEDERATED_ID');
});

test('parseFederatedId rejects an empty domain', () => {
  assert.throws(() => parseFederatedId('ep_codex@'), (error) => error.code === 'MALFORMED_FEDERATED_ID');
});

test('parseFederatedId propagates a bad domain as INVALID_DOMAIN_SYNTAX', () => {
  assert.throws(() => parseFederatedId('ep_codex@relay_1.example.com'), (error) => error.code === 'INVALID_DOMAIN_SYNTAX');
});

test('formatFederatedId joins local-part and domain', () => {
  assert.equal(formatFederatedId({ localPart: 'ep_codex', domain: 'relay.example.com' }), 'ep_codex@relay.example.com');
});

test('formatFederatedId round-trips through parseFederatedId', () => {
  const id = formatFederatedId({ localPart: 'ep_codex', domain: 'relay.example.com:8443' });
  assert.deepEqual(parseFederatedId(id), { localPart: 'ep_codex', domain: 'relay.example.com:8443' });
});

test('isLocalDomain is true when domains match exactly', () => {
  assert.equal(isLocalDomain('ep_codex@relay.example.com', 'relay.example.com'), true);
});

test('isLocalDomain is case-insensitive on the domain', () => {
  assert.equal(isLocalDomain('ep_codex@RELAY.EXAMPLE.COM', 'relay.example.com'), true);
});

test('isLocalDomain is false for a different domain', () => {
  assert.equal(isLocalDomain('ep_codex@other.example.com', 'relay.example.com'), false);
});

test('isLocalDomain treats a present port as significant', () => {
  assert.equal(isLocalDomain('ep_codex@relay.example.com:443', 'relay.example.com'), false);
});

test('isLocalDomain matches when host and port both match, regardless of host case', () => {
  assert.equal(isLocalDomain('ep_codex@RELAY.example.com:443', 'relay.example.com:443'), true);
});

test('isLocalDomain returns false, not a throw, for a malformed id', () => {
  assert.equal(isLocalDomain('ep_codex', 'relay.example.com'), false);
});

test('isLocalDomain never treats local-part case as relevant to locality, but the local part is preserved verbatim by parse/format', () => {
  assert.equal(isLocalDomain('EP_Codex@relay.example.com', 'relay.example.com'), true);
  assert.equal(parseFederatedId('EP_Codex@relay.example.com').localPart, 'EP_Codex');
});

test('resolveDomainOrThrow resolves without throwing when lookupImpl succeeds', async () => {
  await assert.doesNotReject(resolveDomainOrThrow('relay.example.com', {
    lookupImpl: async (host) => { assert.equal(host, 'relay.example.com'); return { address: '10.0.0.1' }; },
  }));
});

test('resolveDomainOrThrow strips the port before calling lookupImpl', async () => {
  let receivedHost;
  await resolveDomainOrThrow('relay.example.com:8443', {
    lookupImpl: async (host) => { receivedHost = host; return { address: '10.0.0.1' }; },
  });
  assert.equal(receivedHost, 'relay.example.com');
});

test('resolveDomainOrThrow skips lookupImpl entirely for the "local" sentinel', async () => {
  let called = false;
  await resolveDomainOrThrow('local', { lookupImpl: async () => { called = true; return {}; } });
  assert.equal(called, false);
});

test('resolveDomainOrThrow classifies ENOTFOUND as DNS_NOT_FOUND with structured fields', async () => {
  await assert.rejects(
    resolveDomainOrThrow('nowhere.example.com', {
      lookupImpl: async () => { throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); },
    }),
    (error) => error.code === 'DNS_NOT_FOUND' && error.domain === 'nowhere.example.com' && error.timeoutMs === 5000,
  );
});

test('resolveDomainOrThrow classifies an unrelated lookup failure as DNS_LOOKUP_FAILED with cause', async () => {
  const original = new Error('boom');
  await assert.rejects(
    resolveDomainOrThrow('relay.example.com', { lookupImpl: async () => { throw original; } }),
    (error) => error.code === 'DNS_LOOKUP_FAILED' && error.cause === original,
  );
});

test('resolveDomainOrThrow times out instead of hanging when lookupImpl never settles', async () => {
  await assert.rejects(
    resolveDomainOrThrow('relay.example.com', { timeoutMs: 20, lookupImpl: () => new Promise(() => {}) }),
    (error) => error.code === 'DNS_TIMEOUT' && error.timeoutMs === 20,
  );
});
