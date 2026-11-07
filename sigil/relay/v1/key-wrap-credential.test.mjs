import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadWrapKey } from './key-wrap.mjs';
import { setMemoryCredentialStore } from '../../cli/credential-store.mjs';

test('loadWrapKey resolves 32-byte base64 key from cred: URI', () => {
  const store = new Map();
  const sampleKey = crypto.randomBytes(32).toString('base64');
  store.set('sigil/bot-wrap-key', sampleKey);
  setMemoryCredentialStore(store);

  try {
    const loaded = loadWrapKey('cred:sigil/bot-wrap-key');
    assert.equal(loaded.length, 32);
    assert.equal(loaded.toString('base64'), sampleKey);

    const loadedLongPrefix = loadWrapKey('credential:sigil/bot-wrap-key');
    assert.equal(loadedLongPrefix.length, 32);
  } finally {
    setMemoryCredentialStore(null);
  }
});

test('loadWrapKey throws WRAP_KEY_UNAVAILABLE when cred: target is not found in store', () => {
  const store = new Map();
  setMemoryCredentialStore(store);

  try {
    assert.throws(
      () => loadWrapKey('cred:sigil/nonexistent-key'),
      { code: 'WRAP_KEY_UNAVAILABLE' }
    );
  } finally {
    setMemoryCredentialStore(null);
  }
});

test('loadWrapKey throws WRAP_KEY_INVALID when cred: target contains wrong length key', () => {
  const store = new Map();
  store.set('sigil/short-key', Buffer.alloc(16).toString('base64'));
  setMemoryCredentialStore(store);

  try {
    assert.throws(
      () => loadWrapKey('cred:sigil/short-key'),
      { code: 'WRAP_KEY_INVALID' }
    );
  } finally {
    setMemoryCredentialStore(null);
  }
});

test('loadWrapKey preserves environment variable resolution when ref is not a cred: URI', () => {
  const sampleKey = crypto.randomBytes(32).toString('base64');
  const env = { SIGIL_CUSTOM_KEY: sampleKey };

  const loaded = loadWrapKey('SIGIL_CUSTOM_KEY', env);
  assert.equal(loaded.length, 32);
  assert.equal(loaded.toString('base64'), sampleKey);
});
