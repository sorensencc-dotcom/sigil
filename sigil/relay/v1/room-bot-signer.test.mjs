import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRoomBotSigner } from './room-bot-signer.mjs';
import { wrapPrivateKey } from './key-wrap.mjs';

const WRAP_KEY = crypto.randomBytes(32);

function entry(endpointId, keyId, publicKey, extra = {}) {
  return { endpoint_id: endpointId, owner_id: 'own_bot', kind: 'agent', status: 'active', keys: new Map([[keyId, { key_id: keyId, public_key: publicKey, status: 'active' }]]), ...extra };
}

// Two separate key tables, as in Postgres: bot_signing_keys and human_signing_keys.
function fakeRepository(entries, { bot = new Map(), human = new Map() } = {}) {
  const counters = { lookups: 0, loads: 0 };
  return {
    counters,
    async lookupTrustedEndpoint(endpointId) { counters.lookups += 1; return entries.get(endpointId) ?? null; },
    async loadWrappedBotSigningKey(keyId) { counters.loads += 1; return bot.get(keyId) ?? null; },
    async loadWrappedSigningKey(keyId) { return human.get(keyId) ?? null; },
  };
}

function provisioned(endpointId = 'ep_bot', keyId = 'key_bot') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const wrapped = wrapPrivateKey({ wrapKey: WRAP_KEY, endpointId, keyId, privateKey });
  return { endpointId, keyId, publicKey, privateKey, wrapped };
}

function setup(extra = {}, opts = {}) {
  const p = provisioned();
  const repository = fakeRepository(new Map([[p.endpointId, entry(p.endpointId, p.keyId, p.publicKey, extra)]]), { bot: new Map([[p.keyId, p.wrapped]]), ...opts });
  return { p, repository };
}

test('a wrapped key round trip yields a private key matching the registered public key', async () => {
  const { p, repository } = setup();
  const signed = await createRoomBotSigner({ repository, wrapKey: WRAP_KEY }).signForBot(p.endpointId);
  assert.deepEqual(signed.endpoint, { owner_id: 'own_bot', endpoint_id: p.endpointId, key_id: p.keyId, kind: 'agent' });
  const signature = crypto.sign(null, Buffer.from('payload'), signed.privateKey);
  assert.equal(crypto.verify(null, Buffer.from('payload'), p.publicKey, signature), true);
});

test('the signer reads bot_signing_keys only: a human key is not found, and a bot key is invisible to the human path', async () => {
  const p = provisioned();
  const humanOnly = fakeRepository(new Map([[p.endpointId, entry(p.endpointId, p.keyId, p.publicKey)]]), { human: new Map([[p.keyId, p.wrapped]]) });
  await assert.rejects(createRoomBotSigner({ repository: humanOnly, wrapKey: WRAP_KEY }).signForBot(p.endpointId), (e) => e.code === 'NO_SIGNING_KEY');
  const botOnly = fakeRepository(new Map(), { bot: new Map([[p.keyId, p.wrapped]]) });
  assert.equal(await botOnly.loadWrappedSigningKey(p.keyId), null);
});

test('an inactive endpoint throws ENDPOINT_REVOKED', async () => {
  const { p, repository } = setup({ status: 'revoked' });
  await assert.rejects(createRoomBotSigner({ repository, wrapKey: WRAP_KEY }).signForBot(p.endpointId), (e) => e.code === 'ENDPOINT_REVOKED' && e.message.includes(p.endpointId));
});

test('a kind other than agent throws NO_SIGNING_KEY', async () => {
  const { p, repository } = setup({ kind: 'human' });
  await assert.rejects(createRoomBotSigner({ repository, wrapKey: WRAP_KEY }).signForBot(p.endpointId), (e) => e.code === 'NO_SIGNING_KEY');
});

test('an unknown endpoint, or one with no active key or stored key, throws NO_SIGNING_KEY', async () => {
  const { p, repository } = setup();
  const signer = createRoomBotSigner({ repository, wrapKey: WRAP_KEY });
  await assert.rejects(signer.signForBot('ep_nobody'), (e) => e.code === 'NO_SIGNING_KEY');
  const noKey = fakeRepository(new Map([[p.endpointId, entry(p.endpointId, p.keyId, p.publicKey)]]));
  await assert.rejects(createRoomBotSigner({ repository: noKey, wrapKey: WRAP_KEY }).signForBot(p.endpointId), (e) => e.code === 'NO_SIGNING_KEY');
  const inactiveKey = entry(p.endpointId, p.keyId, p.publicKey);
  inactiveKey.keys.get(p.keyId).status = 'revoked';
  const noActive = fakeRepository(new Map([[p.endpointId, inactiveKey]]), { bot: new Map([[p.keyId, p.wrapped]]) });
  await assert.rejects(createRoomBotSigner({ repository: noActive, wrapKey: WRAP_KEY }).signForBot(p.endpointId), (e) => e.code === 'NO_SIGNING_KEY');
});

test('a missing wrap key throws WRAP_KEY_UNAVAILABLE', async () => {
  const { p, repository } = setup();
  await assert.rejects(createRoomBotSigner({ repository }).signForBot(p.endpointId), (e) => e.code === 'WRAP_KEY_UNAVAILABLE' && e.message.includes(p.endpointId));
});

test('a stored key that differs from the registered public key throws KEY_MISMATCH without key material', async () => {
  const p = provisioned();
  const other = crypto.generateKeyPairSync('ed25519');
  const repository = fakeRepository(new Map([[p.endpointId, entry(p.endpointId, p.keyId, other.publicKey)]]), { bot: new Map([[p.keyId, p.wrapped]]) });
  await assert.rejects(createRoomBotSigner({ repository, wrapKey: WRAP_KEY }).signForBot(p.endpointId), (e) => e.code === 'KEY_MISMATCH' && e.message.includes(p.endpointId) && !/PRIVATE|BEGIN/.test(e.message));
});

test('the wrong wrap key, and a swapped endpoint id (AAD), both fail to unwrap', async () => {
  const { p, repository } = setup();
  await assert.rejects(createRoomBotSigner({ repository, wrapKey: crypto.randomBytes(32) }).signForBot(p.endpointId));
  // Same wrapped blob and key id registered under a different endpoint id.
  const swapped = fakeRepository(new Map([['ep_other', entry('ep_other', p.keyId, p.publicKey)]]), { bot: new Map([[p.keyId, p.wrapped]]) });
  await assert.rejects(createRoomBotSigner({ repository: swapped, wrapKey: WRAP_KEY }).signForBot('ep_other'));
});

test('trust state is re-read every call while the key match check is memoized', async () => {
  const p = provisioned();
  let exports = 0;
  const counted = new Proxy(p.publicKey, { get: (target, prop) => (prop === 'export' ? (...args) => { exports += 1; return target.export(...args); } : Reflect.get(target, prop)) });
  const entries = new Map([[p.endpointId, entry(p.endpointId, p.keyId, counted)]]);
  const repository = fakeRepository(entries, { bot: new Map([[p.keyId, p.wrapped]]) });
  const signer = createRoomBotSigner({ repository, wrapKey: WRAP_KEY });
  await signer.signForBot(p.endpointId);
  assert.equal(exports, 1);
  await signer.signForBot(p.endpointId);
  assert.equal(exports, 1, 'second call does not recompare the key');
  assert.equal(repository.counters.lookups, 2);
  entries.get(p.endpointId).status = 'revoked';
  await assert.rejects(signer.signForBot(p.endpointId), (e) => e.code === 'ENDPOINT_REVOKED');
  assert.equal(repository.counters.lookups, 3);
});

test('the signer object exposes no key material', () => {
  const { repository } = setup();
  const signer = createRoomBotSigner({ repository, wrapKey: WRAP_KEY });
  assert.deepEqual(Object.keys(signer), ['signForBot']);
  assert.equal(JSON.stringify(signer).includes('PRIVATE'), false);
});
