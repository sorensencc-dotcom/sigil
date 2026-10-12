import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { wrapPrivateKey, unwrapPrivateKey, loadWrapKey } from './key-wrap.mjs';

const wrapKey = crypto.randomBytes(32);
const { privateKey } = crypto.generateKeyPairSync('ed25519');
const pkcs8 = (k) => k.export({ type: 'pkcs8', format: 'der' });

test('round trip returns the same PKCS8 key', () => {
  const wrapped = wrapPrivateKey({ wrapKey, endpointId: 'ep_a', keyId: 'k_a', privateKey });
  assert.equal(wrapped.length, 12 + 16 + pkcs8(privateKey).length);
  const out = unwrapPrivateKey({ wrapKey, endpointId: 'ep_a', keyId: 'k_a', wrapped });
  assert.ok(pkcs8(out).equals(pkcs8(privateKey)));
});
test('wrong key fails', () => {
  const wrapped = wrapPrivateKey({ wrapKey, endpointId: 'ep_a', keyId: 'k_a', privateKey });
  assert.throws(() => unwrapPrivateKey({ wrapKey: crypto.randomBytes(32), endpointId: 'ep_a', keyId: 'k_a', wrapped }));
});
test('ciphertext swapped to another endpoint fails (AAD)', () => {
  const wrapped = wrapPrivateKey({ wrapKey, endpointId: 'ep_a', keyId: 'k_a', privateKey });
  assert.throws(() => unwrapPrivateKey({ wrapKey, endpointId: 'ep_b', keyId: 'k_a', wrapped }));
  assert.throws(() => unwrapPrivateKey({ wrapKey, endpointId: 'ep_a', keyId: 'k_b', wrapped }));
});
test('IV is fresh per wrap', () => {
  const a = wrapPrivateKey({ wrapKey, endpointId: 'e', keyId: 'k', privateKey });
  const b = wrapPrivateKey({ wrapKey, endpointId: 'e', keyId: 'k', privateKey });
  assert.notDeepEqual(a.subarray(0, 12), b.subarray(0, 12));
});
test('loadWrapKey: absent throws WRAP_KEY_UNAVAILABLE, wrong length rejected, valid base64 accepted', () => {
  assert.throws(() => loadWrapKey('SIGIL_WRAP', {}), { code: 'WRAP_KEY_UNAVAILABLE' });
  assert.throws(() => loadWrapKey('SIGIL_WRAP', { SIGIL_WRAP: Buffer.alloc(16).toString('base64') }), { code: 'WRAP_KEY_INVALID' });
  assert.equal(loadWrapKey('SIGIL_WRAP', { SIGIL_WRAP: wrapKey.toString('base64') }).length, 32);
});
