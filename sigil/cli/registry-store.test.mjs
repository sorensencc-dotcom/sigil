import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { toRegistryMap } from './registry-store.mjs';

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
