import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { peerIdFromPublicKey, peerIdFromIdentity } from './peer-id.mjs';

test('peerIdFromPublicKey is deterministic for the same key', async () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const first = await peerIdFromPublicKey(publicKey);
  const second = await peerIdFromPublicKey(publicKey);
  assert.equal(first.toString(), second.toString());
});

test('peerIdFromPublicKey differs for different keys', async () => {
  const a = crypto.generateKeyPairSync('ed25519').publicKey;
  const b = crypto.generateKeyPairSync('ed25519').publicKey;
  const peerA = await peerIdFromPublicKey(a);
  const peerB = await peerIdFromPublicKey(b);
  assert.notEqual(peerA.toString(), peerB.toString());
});

test('peerIdFromIdentity matches peerIdFromPublicKey for the same key', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const identity = {
    public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }),
    private_key_pem: privateKey.export({ type: 'pkcs8', format: 'pem' })
  };
  const fromIdentity = await peerIdFromIdentity(identity);
  const fromKeyObject = await peerIdFromPublicKey(publicKey);
  assert.equal(fromIdentity.toString(), fromKeyObject.toString());
});
