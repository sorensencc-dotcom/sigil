import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonicalManifest, validatePluginManifest, verifyPluginManifest } from './plugin-manifest.mjs';

const valid = {
  package_id: 'sigil.codex.connector', contract: 'sigil.connector/v1', host: 'codex',
  permissions: ['sigil.task/submit'], executable_digest: 'a'.repeat(64), publisher_key_id: 'publisher-1'
};

test('plugin manifest validates and returns frozen normalized metadata', () => {
  const manifest = validatePluginManifest(valid);
  assert.equal(manifest.contract_major, 1);
  assert.equal(Object.isFrozen(manifest), true);
});

test('plugin manifest rejects unsupported contract and revoked publisher', () => {
  assert.throws(() => validatePluginManifest({ ...valid, contract: 'sigil.connector/v2' }), /VERSION_UNSUPPORTED|unsupported connector/);
  assert.throws(() => validatePluginManifest(valid, { revokedPublisherKeys: new Set(['publisher-1']) }), /PUBLISHER_REVOKED|publisher is revoked/);
});

test('plugin manifest rejects malformed identity, digest, and permissions', () => {
  assert.throws(() => validatePluginManifest({ ...valid, executable_digest: 'bad' }), /invalid executable_digest/);
  assert.throws(() => validatePluginManifest({ ...valid, permissions: ['read'] }), /invalid permissions/);
  assert.throws(() => validatePluginManifest({ ...valid, host: 'unknown' }), /invalid host/);
});

test('plugin manifest verifies publisher signature over canonical unsigned fields', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signature = crypto.sign(null, Buffer.from(canonicalManifest(valid)), privateKey).toString('base64url');
  const signed = { ...valid, signature };
  assert.equal(verifyPluginManifest(signed, { publisherKeys: new Map([['publisher-1', publicKey]]) }).contract_major, 1);
  assert.throws(() => verifyPluginManifest({ ...signed, host: 'claude' }, { publisherKeys: new Map([['publisher-1', publicKey]]) }), (error) => error.code === 'PUBLISHER_SIGNATURE_INVALID');
});

test('plugin manifest rejects missing or revoked publisher signatures', () => {
  assert.throws(() => verifyPluginManifest(valid, { publisherKeys: new Map() }), (error) => error.code === 'PUBLISHER_SIGNATURE_REQUIRED');
  assert.throws(() => verifyPluginManifest(valid, { revokedPublisherKeys: new Set(['publisher-1']) }), (error) => error.code === 'PUBLISHER_REVOKED');
});
