import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonicalManifest } from './plugin-manifest.mjs';
import { createPackageRegistry } from './package-registry.mjs';

function signedManifest(privateKey, overrides = {}) {
  const manifest = { package_id: 'sigil.codex.connector', contract: 'sigil.connector/v1', host: 'codex', permissions: ['sigil.task/*'], executable_digest: 'a'.repeat(64), publisher_key_id: 'publisher-1', ...overrides };
  return { ...manifest, signature: crypto.sign(null, Buffer.from(canonicalManifest(manifest)), privateKey).toString('base64url') };
}

test('package registry installs verified package and enforces digest conflict', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); const registry = createPackageRegistry({ publisherKeys: new Map([['publisher-1', publicKey]]) });
  assert.equal(registry.install(signedManifest(privateKey)).status, 'active');
  assert.throws(() => registry.install(signedManifest(privateKey, { executable_digest: 'b'.repeat(64) })), (error) => error.code === 'PACKAGE_CONFLICT');
});

test('package registry revokes package and rejects unknown package', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); const registry = createPackageRegistry({ publisherKeys: new Map([['publisher-1', publicKey]]) }); registry.install(signedManifest(privateKey));
  assert.equal(registry.revoke('sigil.codex.connector').status, 'revoked'); assert.equal(registry.isActive('sigil.codex.connector'), false);
  assert.throws(() => registry.revoke('sigil.missing'), (error) => error.code === 'PACKAGE_NOT_FOUND');
});
