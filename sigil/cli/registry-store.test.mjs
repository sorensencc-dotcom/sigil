import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveIdentity } from './identity.mjs';
import { saveRegistryFile, toRegistryMap } from './registry-store.mjs';

const pem = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });

test('toRegistryMap adds a keys Map, keeps legacy top-level key fields, and defaults kind to human', () => {
  const map = toRegistryMap({ endpoints: [{ endpoint_id: 'ep_a', owner_id: 'usr_a', key_id: 'key_a', public_key_pem: pem }] });
  const entry = map.get('ep_a');
  assert.equal(entry.keys.get('key_a').public_key, entry.public_key);
  assert.equal(entry.key_id, 'key_a');
  assert.equal(entry.kind, 'human');
  assert.equal(entry.status, 'active');
});

test('toRegistryMap keeps an explicit kind', () => {
  const map = toRegistryMap({ endpoints: [{ endpoint_id: 'ep_s', owner_id: 'usr_a', key_id: 'key_s', kind: 'system', public_key_pem: pem }] });
  assert.equal(map.get('ep_s').kind, 'system');
});

test('identity and registry files are written with owner-only permissions', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX file mode bits are not available on Windows');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-file-mode-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const identityPath = path.join(dir, 'identity.json');
  const registryPath = path.join(dir, 'registry.json');
  saveIdentity(identityPath, { private_key_pem: 'private' });
  saveRegistryFile(registryPath, { endpoints: [{ relay_token: 'secret' }] });

  assert.equal(fs.statSync(identityPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(registryPath).mode & 0o777, 0o600);
});
