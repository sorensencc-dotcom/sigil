import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRoomHumanSigner } from './room-human-signer.mjs';
import { wrapPrivateKey } from './key-wrap.mjs';

const WRAP_KEY = crypto.randomBytes(32);

function identityFixture(endpointId = 'ep_human') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { identity: { endpoint_id: endpointId, owner_id: 'own_human', key_id: 'key_1', kind: 'human', _publicKey: publicKey, _privateKey: privateKey }, publicKey, privateKey };
}
const keysOf = (identity) => ({ privateKey: identity._privateKey, publicKey: identity._publicKey });

function entry(endpointId, keyId, publicKey, extra = {}) {
  return { endpoint_id: endpointId, owner_id: 'own_human', kind: 'human', status: 'active', keys: new Map([[keyId, { key_id: keyId, public_key: publicKey, status: 'active' }]]), ...extra };
}

function fakeRepository(entries, wrapped = new Map()) {
  const counters = { lookups: 0, loads: 0 };
  return {
    counters,
    async lookupTrustedEndpoint(endpointId) { counters.lookups += 1; return entries.get(endpointId) ?? null; },
    async loadWrappedSigningKey(keyId) { counters.loads += 1; return wrapped.get(keyId) ?? null; },
  };
}

function provisioned(endpointId = 'ep_other', keyId = 'key_other') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const wrapped = wrapPrivateKey({ wrapKey: WRAP_KEY, endpointId, keyId, privateKey });
  return { endpointId, keyId, publicKey, privateKey, wrapped };
}

test('the operator endpoint signs from the identity file without touching the repository', async () => {
  const { identity, publicKey } = identityFixture();
  const repository = fakeRepository(new Map([['ep_human', entry('ep_human', 'key_1', publicKey)]]));
  const signer = createRoomHumanSigner({ identity, repository, identityKeys: keysOf });
  assert.equal(signer.endpointId, 'ep_human');
  assert.equal(signer.ownerId, 'own_human');
  const signed = await signer.signForEndpoint('ep_human');
  assert.equal(signed.privateKey, identity._privateKey);
  assert.deepEqual(signed.endpoint, { owner_id: 'own_human', endpoint_id: 'ep_human', key_id: 'key_1', kind: 'human' });
  assert.equal(repository.counters.lookups, 0);
});

test('a provisioned endpoint signs with its unwrapped custodial key', async () => {
  const { identity } = identityFixture();
  const p = provisioned();
  const repository = fakeRepository(new Map([[p.endpointId, entry(p.endpointId, p.keyId, p.publicKey, { owner_id: 'own_other' })]]), new Map([[p.keyId, p.wrapped]]));
  const signer = createRoomHumanSigner({ identity, repository, wrapKey: WRAP_KEY, identityKeys: keysOf });
  const signed = await signer.signForEndpoint(p.endpointId);
  assert.deepEqual(signed.endpoint, { owner_id: 'own_other', endpoint_id: p.endpointId, key_id: p.keyId, kind: 'human' });
  const signature = crypto.sign(null, Buffer.from('payload'), signed.privateKey);
  assert.equal(crypto.verify(null, Buffer.from('payload'), p.publicKey, signature), true);
});

test('the key match check runs once per process per key while trust state is re-read', async () => {
  const { identity } = identityFixture();
  const p = provisioned();
  let exports = 0;
  const counted = new Proxy(p.publicKey, { get: (target, prop) => (prop === 'export' ? (...args) => { exports += 1; return target.export(...args); } : Reflect.get(target, prop)) });
  const repository = fakeRepository(new Map([[p.endpointId, entry(p.endpointId, p.keyId, counted)]]), new Map([[p.keyId, p.wrapped]]));
  const signer = createRoomHumanSigner({ identity, repository, wrapKey: WRAP_KEY, identityKeys: keysOf });
  await signer.signForEndpoint(p.endpointId);
  assert.equal(exports, 1);
  await signer.signForEndpoint(p.endpointId);
  assert.equal(exports, 1, 'second call does not recompare the key');
  assert.equal(repository.counters.lookups, 2, 'revocation is still seen on every call');
});

test('an unwrapped key that differs from the endpoint key throws KEY_MISMATCH', async () => {
  const { identity } = identityFixture();
  const p = provisioned();
  const other = crypto.generateKeyPairSync('ed25519');
  const repository = fakeRepository(new Map([[p.endpointId, entry(p.endpointId, p.keyId, other.publicKey)]]), new Map([[p.keyId, p.wrapped]]));
  const signer = createRoomHumanSigner({ identity, repository, wrapKey: WRAP_KEY, identityKeys: keysOf });
  await assert.rejects(signer.signForEndpoint(p.endpointId), (e) => e.code === 'KEY_MISMATCH' && e.message.includes(p.endpointId) && !/PRIVATE|BEGIN/.test(e.message));
});

test('an endpoint without a stored key, or an unknown endpoint, throws NO_SIGNING_KEY', async () => {
  const { identity } = identityFixture();
  const p = provisioned();
  const repository = fakeRepository(new Map([[p.endpointId, entry(p.endpointId, p.keyId, p.publicKey)]]));
  const signer = createRoomHumanSigner({ identity, repository, wrapKey: WRAP_KEY, identityKeys: keysOf });
  await assert.rejects(signer.signForEndpoint(p.endpointId), (e) => e.code === 'NO_SIGNING_KEY');
  await assert.rejects(signer.signForEndpoint('ep_nobody'), (e) => e.code === 'NO_SIGNING_KEY');
});

test('a revoked endpoint throws NO_SIGNING_KEY even when a wrapped key exists', async () => {
  const { identity } = identityFixture();
  const p = provisioned();
  const repository = fakeRepository(new Map([[p.endpointId, entry(p.endpointId, p.keyId, p.publicKey, { status: 'revoked' })]]), new Map([[p.keyId, p.wrapped]]));
  const signer = createRoomHumanSigner({ identity, repository, wrapKey: WRAP_KEY, identityKeys: keysOf });
  await assert.rejects(signer.signForEndpoint(p.endpointId), (e) => e.code === 'NO_SIGNING_KEY');
});

test('provisioned signing without a wrap key throws WRAP_KEY_UNAVAILABLE and the operator still signs', async () => {
  const { identity } = identityFixture();
  const p = provisioned();
  const repository = fakeRepository(new Map([[p.endpointId, entry(p.endpointId, p.keyId, p.publicKey)]]), new Map([[p.keyId, p.wrapped]]));
  const signer = createRoomHumanSigner({ identity, repository, identityKeys: keysOf });
  await assert.rejects(signer.signForEndpoint(p.endpointId), (e) => e.code === 'WRAP_KEY_UNAVAILABLE');
  assert.equal((await signer.signForEndpoint('ep_human')).privateKey, identity._privateKey);
});

test('verifyOperator accepts the matching active human endpoint', async () => {
  const { identity, publicKey } = identityFixture();
  const repository = fakeRepository(new Map([['ep_human', entry('ep_human', 'key_1', publicKey)]]));
  await createRoomHumanSigner({ identity, repository, identityKeys: keysOf }).verifyOperator();
});

test('verifyOperator refuses a key that differs from the registry key', async () => {
  const { identity } = identityFixture();
  const other = crypto.generateKeyPairSync('ed25519');
  const repository = fakeRepository(new Map([['ep_human', entry('ep_human', 'key_1', other.publicKey)]]));
  await assert.rejects(createRoomHumanSigner({ identity, repository, identityKeys: keysOf }).verifyOperator(), (e) => e.code === 'ROOM_HUMAN_KEY_MISMATCH');
  const wrongKeyId = fakeRepository(new Map([['ep_human', entry('ep_human', 'key_2', identity._publicKey)]]));
  await assert.rejects(createRoomHumanSigner({ identity, repository: wrongKeyId, identityKeys: keysOf }).verifyOperator(), (e) => e.code === 'ROOM_HUMAN_KEY_MISMATCH');
});

test('verifyOperator refuses an unknown, inactive, or non-human endpoint', async () => {
  const { identity, publicKey } = identityFixture();
  const run = (e) => createRoomHumanSigner({ identity, repository: fakeRepository(new Map(e ? [['ep_human', e]] : [])), identityKeys: keysOf }).verifyOperator();
  await assert.rejects(run(null), (e) => e.code === 'ROOM_HUMAN_ENDPOINT_UNKNOWN');
  await assert.rejects(run(entry('ep_human', 'key_1', publicKey, { status: 'revoked' })), (e) => e.code === 'ROOM_HUMAN_ENDPOINT_UNKNOWN');
  await assert.rejects(run(entry('ep_human', 'key_1', publicKey, { kind: 'agent' })), (e) => e.code === 'ROOM_HUMAN_ENDPOINT_UNKNOWN');
});

test('the signer object exposes no key material', async () => {
  const { identity, publicKey } = identityFixture();
  const repository = fakeRepository(new Map([['ep_human', entry('ep_human', 'key_1', publicKey)]]));
  const signer = createRoomHumanSigner({ identity, repository, wrapKey: WRAP_KEY, identityKeys: keysOf });
  assert.deepEqual(Object.keys(signer).sort(), ['endpointId', 'ownerId', 'signForEndpoint', 'verifyOperator']);
  assert.equal(JSON.stringify(signer).includes('PRIVATE'), false);
});
