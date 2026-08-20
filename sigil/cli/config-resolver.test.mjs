import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfigFile, resolveConfig } from './config-resolver.mjs';

test('resolveConfig applies flag over env over config over defaults for every field', () => {
  const config = {
    relay_url: 'http://config.example.test',
    stream_url: 'ws://config.example.test/stream',
    default_identity: 'config.identity.json',
  };
  const env = {
    SIGIL_RELAY_URL: 'http://env.example.test',
    SIGIL_STREAM_URL: 'ws://env.example.test/stream',
    SIGIL_IDENTITY: 'env.identity.json',
  };

  assert.deepEqual(resolveConfig({ flags: {
    relayUrl: 'http://flag.example.test',
    streamUrl: 'ws://flag.example.test/stream',
    identity: 'flag.identity.json',
  }, env, config }), {
    relayUrl: 'http://flag.example.test',
    streamUrl: 'ws://flag.example.test/stream',
    identityPath: 'flag.identity.json',
  });

  assert.deepEqual(resolveConfig({ flags: {}, env, config }), {
    relayUrl: 'http://env.example.test',
    streamUrl: 'ws://env.example.test/stream',
    identityPath: 'env.identity.json',
  });

  assert.deepEqual(resolveConfig({ flags: {}, env: {}, config }), {
    relayUrl: 'http://config.example.test',
    streamUrl: 'ws://config.example.test/stream',
    identityPath: 'config.identity.json',
  });

  assert.deepEqual(resolveConfig({ flags: {}, env: {}, config: {} }), {
    relayUrl: 'http://127.0.0.1:8791',
    streamUrl: null,
    identityPath: null,
  });
});

test('resolveConfig fills in the /v1/stream path only when no path was given at all', () => {
  assert.equal(
    resolveConfig({ flags: { streamUrl: 'ws://127.0.0.1:8793' }, env: {}, config: {} }).streamUrl,
    'ws://127.0.0.1:8793/v1/stream',
    'a bare host:port stream-url (no path) must resolve to the real stream path, not 400 at handshake time'
  );
  assert.equal(
    resolveConfig({ flags: { streamUrl: 'ws://127.0.0.1:8793/' }, env: {}, config: {} }).streamUrl,
    'ws://127.0.0.1:8793/v1/stream',
    'a bare trailing-slash stream-url counts as no path'
  );
});

test('resolveConfig preserves an explicit custom stream-url path instead of overwriting it -- needed for reverse-proxy multi-machine setups', () => {
  assert.equal(
    resolveConfig({ flags: { streamUrl: 'wss://proxy.example.test/sigil-stream' }, env: {}, config: {} }).streamUrl,
    'wss://proxy.example.test/sigil-stream',
    'an operator-configured custom path (e.g. behind a fronting reverse proxy) must not be silently clobbered'
  );
});

test('resolveConfig treats an explicit empty stream-url as not-provided, not a broken empty string', () => {
  assert.equal(
    resolveConfig({ flags: { streamUrl: '' }, env: {}, config: {} }).streamUrl,
    null,
    'an explicit empty --stream-url must normalize to null so callers\' `?? computeDefault()` fallback still fires, instead of silently propagating an empty string as the connection target'
  );
  assert.equal(resolveConfig({ flags: {}, env: {}, config: { stream_url: '' } }).streamUrl, null);
});

test('resolveConfig raises a clear, attributed error for a malformed stream-url instead of an opaque URL-parser exception', () => {
  assert.throws(
    () => resolveConfig({ flags: { streamUrl: 'not a url' }, env: {}, config: {} }),
    /Invalid --stream-url\/SIGIL_STREAM_URL\/stream_url value "not a url"/
  );
});

test('loadConfigFile returns an empty object for missing and invalid files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-config-test-'));
  const missingPath = path.join(directory, 'missing.json');
  const invalidPath = path.join(directory, 'invalid.json');
  fs.writeFileSync(invalidPath, '{not valid json', 'utf8');

  try {
    assert.deepEqual(loadConfigFile(missingPath), {});
    assert.deepEqual(loadConfigFile(invalidPath), {});
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
