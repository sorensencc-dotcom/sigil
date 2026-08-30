import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildPeerDocument } from './well-known-document.mjs';
import { validatePeerDocument } from './peer-discovery.mjs';

function fixtureIdentity({ endpointId = 'relay', ownerId = 'owner_1' } = {}) {
  const keys = crypto.generateKeyPairSync('ed25519');
  return {
    owner_id: ownerId,
    endpoint_id: endpointId,
    key_id: `key_${endpointId}`,
    kind: 'human',
    status: 'active',
    public_key_pem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    private_key_pem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

test('buildPeerDocument maps identity, domain, and endpoints into the .well-known/sigil shape', () => {
  const identity = fixtureIdentity({ endpointId: 'relay' });
  const doc = buildPeerDocument({
    identity,
    domain: 'relay.example.com',
    endpoint: 'https://relay.example.com/v1',
    wsEndpoint: 'wss://relay.example.com/v1/stream',
  });

  assert.equal(doc.domain, 'relay.example.com');
  assert.deepEqual(doc.relay, {
    endpoint: 'https://relay.example.com/v1',
    ws_endpoint: 'wss://relay.example.com/v1/stream',
  });
  assert.equal(doc.keys.length, 1);
  assert.equal(doc.keys[0].kid, 'key_relay');
  assert.equal(doc.keys[0].alg, 'Ed25519');
  assert.equal(typeof doc.keys[0].publicKey, 'string');
  assert.ok(doc.keys[0].publicKey.length > 0);
});

test('buildPeerDocument publicKey is base64url DER SPKI that round-trips to the identity key', () => {
  const identity = fixtureIdentity();
  const doc = buildPeerDocument({
    identity,
    domain: 'relay.example.com',
    endpoint: 'https://relay.example.com/v1',
  });

  const restored = crypto.createPublicKey({
    key: Buffer.from(doc.keys[0].publicKey, 'base64url'),
    format: 'der',
    type: 'spki',
  });
  assert.equal(
    restored.export({ type: 'spki', format: 'pem' }),
    identity.public_key_pem,
  );
});

test('buildPeerDocument omits relay.ws_endpoint when wsEndpoint is not given', () => {
  const identity = fixtureIdentity();
  const doc = buildPeerDocument({
    identity,
    domain: 'relay.example.com',
    endpoint: 'https://relay.example.com/v1',
  });
  assert.equal('ws_endpoint' in doc.relay, false);
});

test('buildPeerDocument output passes the consumer validatePeerDocument for the same domain', () => {
  const identity = fixtureIdentity();
  const doc = buildPeerDocument({
    identity,
    domain: 'relay.example.com',
    endpoint: 'https://relay.example.com/v1',
    wsEndpoint: 'wss://relay.example.com/v1/stream',
  });
  assert.doesNotThrow(() => validatePeerDocument(doc, { expectedDomain: 'relay.example.com' }));
});

test('buildPeerDocument throws when the identity has no public key', () => {
  const identity = fixtureIdentity();
  delete identity.public_key_pem;
  assert.throws(
    () => buildPeerDocument({ identity, domain: 'relay.example.com', endpoint: 'https://relay.example.com/v1' }),
    /public key/i,
  );
});

test('buildPeerDocument throws when the identity key is not Ed25519', () => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const identity = {
    key_id: 'key_relay',
    public_key_pem: rsa.publicKey.export({ type: 'spki', format: 'pem' }),
  };
  assert.throws(
    () => buildPeerDocument({ identity, domain: 'relay.example.com', endpoint: 'https://relay.example.com/v1' }),
    /Ed25519/,
  );
});

test('buildPeerDocument throws when domain is missing', () => {
  const identity = fixtureIdentity();
  assert.throws(
    () => buildPeerDocument({ identity, endpoint: 'https://relay.example.com/v1' }),
    /domain/i,
  );
});

test('buildPeerDocument throws when endpoint is missing', () => {
  const identity = fixtureIdentity();
  assert.throws(
    () => buildPeerDocument({ identity, domain: 'relay.example.com' }),
    /endpoint/i,
  );
});
