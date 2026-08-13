import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { registerEndpoint } from './endpoint-registry.mjs';

const publicKey = crypto.generateKeyPairSync('ed25519').publicKey;

test('registers endpoint for a known active human owner', () => {
  const endpoints = new Map();
  const response = registerEndpoint({ endpoint_id: 'ep_codex', owner_id: 'usr_1', installation_id: 'install_1', runtime: 'codex', key_id: 'key_1', public_key: publicKey }, { humans: new Map([['usr_1', { status: 'active' }]]), endpoints });
  assert.equal(response.status, 201);
  assert.equal(endpoints.get('ep_codex').status, 'active');
});

test('rejects unknown owner, inactive owner, and duplicate endpoint', () => {
  const endpoints = new Map();
  const unknown = registerEndpoint({ endpoint_id: 'ep_1', owner_id: 'usr_missing', installation_id: 'i', runtime: 'codex', key_id: 'k', public_key: publicKey }, { humans: new Map(), endpoints });
  assert.equal(unknown.body.code, 'UNKNOWN_ENDPOINT');
  const humans = new Map([['usr_1', { status: 'active' }]]);
  registerEndpoint({ endpoint_id: 'ep_1', owner_id: 'usr_1', installation_id: 'i', runtime: 'codex', key_id: 'k', public_key: publicKey }, { humans, endpoints });
  const duplicate = registerEndpoint({ endpoint_id: 'ep_1', owner_id: 'usr_1', installation_id: 'i2', runtime: 'codex', key_id: 'k2', public_key: publicKey }, { humans, endpoints });
  assert.equal(duplicate.status, 409);
  const inactive = registerEndpoint({ endpoint_id: 'ep_2', owner_id: 'usr_2', installation_id: 'i', runtime: 'codex', key_id: 'k', public_key: publicKey }, { humans: new Map([['usr_2', { status: 'revoked' }]]), endpoints: new Map() });
  assert.equal(inactive.body.code, 'ROUTE_NOT_AUTHORIZED');
});

test('rejects incomplete registration', () => {
  const response = registerEndpoint({ endpoint_id: 'ep_1' }, { humans: new Map(), endpoints: new Map() });
  assert.equal(response.status, 400);
});

test('rejects non-Ed25519 or non-public key registration', () => {
  const humans = new Map([['usr_1', { status: 'active' }]]);
  const input = { endpoint_id: 'ep_1', owner_id: 'usr_1', installation_id: 'i', runtime: 'codex', key_id: 'k', public_key: publicKey };
  assert.equal(registerEndpoint({ ...input, algorithm: 'RSA' }, { humans, endpoints: new Map() }).status, 400);
  assert.equal(registerEndpoint({ ...input, public_key: { type: 'private' } }, { humans, endpoints: new Map() }).status, 400);
});
