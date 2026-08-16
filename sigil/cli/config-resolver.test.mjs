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
