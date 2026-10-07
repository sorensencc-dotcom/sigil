import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRoomHumanSigner } from './room-human-signer.mjs';

function identityFixture(endpointId = 'ep_human') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { identity: { endpoint_id: endpointId, owner_id: 'own_human', key_id: 'key_1', kind: 'human', _publicKey: publicKey, _privateKey: privateKey }, publicKey, privateKey };
}
const keysOf = (identity) => ({ privateKey: identity._privateKey, publicKey: identity._publicKey });

test('signForEndpoint returns the signer for the loaded endpoint only', () => {
  const { identity, publicKey } = identityFixture();
  const registry = new Map([['ep_human', { endpoint_id: 'ep_human', owner_id: 'own_human', key_id: 'key_1', status: 'active', public_key: publicKey }]]);
  const signer = createRoomHumanSigner({ identity, registry, identityKeys: keysOf });
  assert.equal(signer.endpointId, 'ep_human');
  assert.ok(signer.signForEndpoint('ep_human').privateKey);
  assert.throws(() => signer.signForEndpoint('ep_other'), (e) => e.code === 'NO_SIGNING_KEY');
});

test('construction refuses a key that differs from the registry key', () => {
  const { identity } = identityFixture();
  const other = crypto.generateKeyPairSync('ed25519');
  const registry = new Map([['ep_human', { endpoint_id: 'ep_human', owner_id: 'own_human', key_id: 'key_1', status: 'active', public_key: other.publicKey }]]);
  assert.throws(() => createRoomHumanSigner({ identity, registry, identityKeys: keysOf }), (e) => e.code === 'ROOM_HUMAN_KEY_MISMATCH');
});

test('construction refuses an endpoint the registry does not hold or that is not active', () => {
  const { identity, publicKey } = identityFixture();
  assert.throws(() => createRoomHumanSigner({ identity, registry: new Map(), identityKeys: keysOf }), (e) => e.code === 'ROOM_HUMAN_ENDPOINT_UNKNOWN');
  const revoked = new Map([['ep_human', { status: 'revoked', public_key: publicKey, key_id: 'key_1' }]]);
  assert.throws(() => createRoomHumanSigner({ identity, registry: revoked, identityKeys: keysOf }), (e) => e.code === 'ROOM_HUMAN_ENDPOINT_UNKNOWN');
});

test('construction refuses an agent endpoint', () => {
  const { identity, publicKey } = identityFixture();
  const registry = new Map([['ep_human', { status: 'active', kind: 'agent', public_key: publicKey, key_id: 'key_1' }]]);
  assert.throws(() => createRoomHumanSigner({ identity, registry, identityKeys: keysOf }), (e) => e.code === 'ROOM_HUMAN_ENDPOINT_UNKNOWN');
});

test('error messages and the signer object never contain key material', () => {
  const { identity, publicKey } = identityFixture();
  const registry = new Map([['ep_human', { status: 'active', key_id: 'key_1', public_key: publicKey }]]);
  const signer = createRoomHumanSigner({ identity, registry, identityKeys: keysOf });
  assert.equal(JSON.stringify(signer).includes('PRIVATE'), false);
  assert.deepEqual(Object.keys(signer).sort(), ['endpointId', 'ownerId', 'signForEndpoint']);
  try { signer.signForEndpoint('ep_other'); } catch (e) { assert.equal(/PRIVATE|BEGIN/.test(e.message), false); }
});
