import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverPeer } from './peer-discovery.mjs';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

const VALID_BODY = {
  domain: 'relay.example.com',
  relay: { endpoint: 'https://relay.example.com:8443/v1', ws_endpoint: 'wss://relay.example.com:8443/v1/stream' },
  keys: [{ kid: 'key-2026-08', alg: 'Ed25519', publicKey: 'pubkey-a' }],
};

test('discoverPeer fetches .well-known/sigil and returns the parsed record', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://relay.example.com/.well-known/sigil');
    assert.equal(options.redirect, 'error');
    return jsonResponse(VALID_BODY);
  };
  const result = await discoverPeer('relay.example.com', { fetchImpl });
  assert.deepEqual(result, {
    domain: 'relay.example.com',
    relayUrl: 'https://relay.example.com:8443/v1',
    wsUrl: 'wss://relay.example.com:8443/v1/stream',
    keys: [{ kid: 'key-2026-08', alg: 'Ed25519', publicKey: 'pubkey-a' }],
  });
});

test('discoverPeer defaults wsUrl to null when ws_endpoint is omitted', async () => {
  const body = { domain: 'relay.example.com', relay: { endpoint: 'https://relay.example.com/v1' }, keys: VALID_BODY.keys };
  const fetchImpl = async () => jsonResponse(body);
  const result = await discoverPeer('relay.example.com', { fetchImpl });
  assert.equal(result.wsUrl, null);
});

test('discoverPeer rejects a non-wss ws_endpoint (an https:// URL is not a valid WebSocket scheme)', async () => {
  const fetchImpl = async () => jsonResponse({ ...VALID_BODY, relay: { ...VALID_BODY.relay, ws_endpoint: 'https://relay.example.com/stream' } });
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_INVALID_ENDPOINT' });
});

test('discoverPeer rejects a malformed domain before making any fetch call', async () => {
  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return jsonResponse(VALID_BODY); };
  await assert.rejects(() => discoverPeer('not a domain/with path', { fetchImpl }), { code: 'INVALID_DOMAIN_SYNTAX' });
  assert.equal(fetchCalled, false);
});

test('discoverPeer rejects on a network error', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_DISCOVERY_FAILED' });
});

test('discoverPeer rejects on a non-ok HTTP status', async () => {
  const fetchImpl = async () => jsonResponse({}, { ok: false, status: 500 });
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_DISCOVERY_FAILED' });
});

test('discoverPeer rejects on malformed JSON', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_MALFORMED_RESPONSE' });
});

test('discoverPeer rejects when the response domain does not match the requested domain', async () => {
  const fetchImpl = async () => jsonResponse({ ...VALID_BODY, domain: 'attacker.example.com' });
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_DOMAIN_MISMATCH' });
});

test('discoverPeer rejects a non-https relay.endpoint in production', async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const fetchImpl = async () => jsonResponse({ ...VALID_BODY, relay: { endpoint: 'http://relay.example.com/v1' } });
    await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_INVALID_ENDPOINT' });
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test('discoverPeer accepts a non-https relay.endpoint outside production', async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const fetchImpl = async () => jsonResponse({ ...VALID_BODY, relay: { endpoint: 'http://relay.example.com/v1' } });
    const result = await discoverPeer('relay.example.com', { fetchImpl });
    assert.equal(result.relayUrl, 'http://relay.example.com/v1');
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test('discoverPeer rejects a malformed relay.endpoint URL', async () => {
  const fetchImpl = async () => jsonResponse({ ...VALID_BODY, relay: { endpoint: 'not a url' } });
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_INVALID_ENDPOINT' });
});

test('discoverPeer rejects a missing relay object entirely', async () => {
  const fetchImpl = async () => jsonResponse({ domain: 'relay.example.com', keys: VALID_BODY.keys });
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_INVALID_ENDPOINT' });
});

test('discoverPeer rejects an empty keys array', async () => {
  const fetchImpl = async () => jsonResponse({ ...VALID_BODY, keys: [] });
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_NO_KEYS' });
});

test('discoverPeer rejects a key entry with a non-Ed25519 alg', async () => {
  const fetchImpl = async () => jsonResponse({ ...VALID_BODY, keys: [{ kid: 'k1', alg: 'RSA', publicKey: 'x' }] });
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_INVALID_KEY' });
});

test('discoverPeer rejects a key entry with an empty kid', async () => {
  const fetchImpl = async () => jsonResponse({ ...VALID_BODY, keys: [{ kid: '', alg: 'Ed25519', publicKey: 'x' }] });
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_INVALID_KEY' });
});

test('discoverPeer rejects when JSON parses to null', async () => {
  const fetchImpl = async () => jsonResponse(null);
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_MALFORMED_RESPONSE' });
});

test('discoverPeer rejects when JSON parses to a primitive number', async () => {
  const fetchImpl = async () => jsonResponse(42);
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_MALFORMED_RESPONSE' });
});

test('discoverPeer rejects when JSON parses to a primitive string', async () => {
  const fetchImpl = async () => jsonResponse('not an object');
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_MALFORMED_RESPONSE' });
});
