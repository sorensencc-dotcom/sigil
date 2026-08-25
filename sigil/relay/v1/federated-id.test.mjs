import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDomain, parseFederatedId, formatFederatedId, isLocalDomain } from './federated-id.mjs';

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
