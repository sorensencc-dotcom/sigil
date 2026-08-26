import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverPeer } from './peer-discovery.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { resolvePeer, rotatePeer } from './peer-discovery.mjs';
import { validatePeerDocument } from './peer-discovery.mjs';

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

function makeFetch(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

const BODY_V1 = {
  domain: 'relay.example.com',
  relay: { endpoint: 'https://relay.example.com/v1' },
  keys: [{ kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' }],
};

test('resolvePeer TOFU-pins on first resolve and audits peer.tofu_pinned', async () => {
  const repository = createMemoryRepository();
  const record = await resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(BODY_V1) });
  assert.equal(record.trustMode, 'tofu');
  assert.deepEqual(record.keys, BODY_V1.keys);
  const events = repository._debugGetAuditEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'peer.tofu_pinned');
  assert.equal(events[0].object_id, 'relay.example.com');
});

test('resolvePeer is a silent no-op re-confirmation when the key set is unchanged', async () => {
  const repository = createMemoryRepository();
  await resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(BODY_V1) });
  await resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(BODY_V1) });
  const events = repository._debugGetAuditEvents();
  assert.equal(events.length, 1); // only the original tofu_pinned -- no second audit event
});

test('resolvePeer rejects a kid reused with a different publicKey (spoofing) and leaves the record untouched', async () => {
  const repository = createMemoryRepository();
  await resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(BODY_V1) });
  const spoofedBody = { ...BODY_V1, keys: [{ kid: 'k1', alg: 'Ed25519', publicKey: 'attacker-pub' }] };
  await assert.rejects(
    () => resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(spoofedBody) }),
    (error) => error.code === 'PEER_KEY_MISMATCH',
  );
  const stored = await repository.getPeerByDomain('relay.example.com');
  assert.deepEqual(stored.keys, BODY_V1.keys);
  const events = repository._debugGetAuditEvents();
  assert.equal(events[events.length - 1].event_type, 'peer.key_mismatch_rejected');
});

test('resolvePeer rejects when the previously pinned key is entirely absent from the new set', async () => {
  const repository = createMemoryRepository();
  await resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(BODY_V1) });
  const differentBody = { ...BODY_V1, keys: [{ kid: 'k9', alg: 'Ed25519', publicKey: 'pub-9' }] };
  await assert.rejects(
    () => resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(differentBody) }),
    (error) => error.code === 'PEER_KEY_MISMATCH',
  );
});

test('resolvePeer rejects a key-set change even when the previously pinned key is still present (no silent grace-accept)', async () => {
  const repository = createMemoryRepository();
  await resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(BODY_V1) });
  const widenedBody = { ...BODY_V1, keys: [...BODY_V1.keys, { kid: 'k2', alg: 'Ed25519', publicKey: 'pub-2' }] };
  await assert.rejects(
    () => resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(widenedBody) }),
    (error) => error.code === 'PEER_KEY_MISMATCH',
  );
  const stored = await repository.getPeerByDomain('relay.example.com');
  assert.deepEqual(stored.keys, BODY_V1.keys); // untouched -- only "sigil peer rotate --confirm" can accept a new key set
});

test('resolvePeer rejects an endpoint-only change (relayUrl differs, keys unchanged) -- endpoint is exactly as unauthenticated as a key', async () => {
  const repository = createMemoryRepository();
  await resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(BODY_V1) });
  const movedBody = { ...BODY_V1, relay: { endpoint: 'https://relay.example.com/v2' } };
  await assert.rejects(
    () => resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(movedBody) }),
    (error) => error.code === 'PEER_KEY_MISMATCH' && error.endpointChanged === true && error.keysChanged === false,
  );
  const stored = await repository.getPeerByDomain('relay.example.com');
  assert.equal(stored.relayUrl, 'https://relay.example.com/v1'); // untouched -- only "sigil peer rotate --confirm" can accept
  const events = repository._debugGetAuditEvents();
  assert.equal(events[events.length - 1].event_type, 'peer.key_mismatch_rejected');
  assert.equal(events[events.length - 1].payload.endpointChanged, true);
});

test('resolvePeer never fetches or overwrites a static-pinned record', async () => {
  const repository = createMemoryRepository();
  await repository.upsertPeer({ domain: 'relay.example.com', relayUrl: 'https://static.example.com/v1', keys: BODY_V1.keys, trustMode: 'static' });
  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => BODY_V1 }; };
  const record = await resolvePeer('relay.example.com', repository, { fetchImpl });
  assert.equal(fetchCalled, false);
  assert.equal(record.relayUrl, 'https://static.example.com/v1');
});

test('rotatePeer force-overwrites regardless of a prior key mismatch and audits forced: true', async () => {
  const repository = createMemoryRepository();
  await resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(BODY_V1) });
  const newBody = { ...BODY_V1, keys: [{ kid: 'k9', alg: 'Ed25519', publicKey: 'pub-9' }] };
  const record = await rotatePeer('relay.example.com', repository, { fetchImpl: makeFetch(newBody) });
  assert.deepEqual(record.keys, newBody.keys);
  const events = repository._debugGetAuditEvents();
  assert.equal(events[events.length - 1].event_type, 'peer.rotated');
  assert.equal(events[events.length - 1].payload.forced, true);
});

test('validatePeerDocument accepts a well-formed document with no domain check', () => {
  const result = validatePeerDocument(VALID_BODY);
  assert.deepEqual(result, {
    domain: 'relay.example.com',
    relayUrl: 'https://relay.example.com:8443/v1',
    wsUrl: 'wss://relay.example.com:8443/v1/stream',
    keys: VALID_BODY.keys,
  });
});

test('validatePeerDocument checks self-match only when expectedDomain is given', () => {
  assert.throws(() => validatePeerDocument(VALID_BODY, { expectedDomain: 'attacker.example.com' }), { code: 'PEER_DOMAIN_MISMATCH' });
  assert.doesNotThrow(() => validatePeerDocument(VALID_BODY, { expectedDomain: 'relay.example.com' }));
});

test('validatePeerDocument rejects an invalid key entry, same as discoverPeer', () => {
  assert.throws(() => validatePeerDocument({ ...VALID_BODY, keys: [{ kid: 'k1', alg: 'RSA', publicKey: 'x' }] }), { code: 'PEER_INVALID_KEY' });
});

test('validatePeerDocument rejects a non-object/null input', () => {
  assert.throws(() => validatePeerDocument(null), { code: 'PEER_MALFORMED_RESPONSE' });
});
