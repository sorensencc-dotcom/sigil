import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { validateEnvelope, signedBytes } from './validate-envelope.mjs';

function signedEnvelope(privateKey, keyId, overrides = {}) {
  const base = {
    protocol: 'sigil/1', message_id: 'msg_fed_1', conversation_id: 'conv_1', message_type: 'chat.message',
    sender: { owner_id: 'usr_chris@primary.example', endpoint_id: 'ep_codex@a.example', kind: 'agent' },
    recipient: { owner_id: 'usr_chris@primary.example', endpoint_id: 'ep_claude@b.example', kind: 'agent' },
    body: { text: 'hi' }, context_refs: [], capabilities: [], idempotency_key: 'idem_1',
    created_at: '2026-08-30T12:00:00.000Z', expires_at: '2026-08-30T12:10:00.000Z',
    ...overrides,
  };
  const sig = crypto.sign(null, signedBytes({ ...base, signature: undefined }), privateKey).toString('base64url');
  return { ...base, signature: { algorithm: 'Ed25519', key_id: keyId, value: sig } };
}

test('skipSenderRegistration lets an unregistered federated sender validate against a supplied key', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = 'key_ep_codex@a.example';
  const envelope = signedEnvelope(privateKey, keyId);
  const registered = new Map([[envelope.sender.endpoint_id, {
    endpoint_id: envelope.sender.endpoint_id, owner_id: 'usr_other@a.example', key_id: keyId, status: 'active', public_key: publicKey,
  }]]);
  const result = validateEnvelope(envelope, {
    now: new Date('2026-08-30T12:00:30.000Z'), registered, relayDomain: 'b.example', skipSenderRegistration: true,
  });
  assert.equal(result.accepted, true);
});

test('without skipSenderRegistration an unregistered sender is still UNKNOWN_ENDPOINT', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = signedEnvelope(privateKey, 'key_ep_codex@a.example');
  assert.throws(
    () => validateEnvelope(envelope, { now: new Date('2026-08-30T12:00:30.000Z'), registered: new Map(), relayDomain: 'b.example' }),
    (err) => err.code === 'UNKNOWN_ENDPOINT',
  );
});

test('skipSenderRegistration still enforces the expiry window', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = 'key_ep_codex@a.example';
  const envelope = signedEnvelope(privateKey, keyId, { created_at: '2026-08-30T12:00:00.000Z', expires_at: '2026-08-31T13:00:00.000Z' });
  const registered = new Map([[envelope.sender.endpoint_id, {
    endpoint_id: envelope.sender.endpoint_id, owner_id: envelope.sender.owner_id, key_id: keyId, status: 'active', public_key: publicKey,
  }]]);
  assert.throws(
    () => validateEnvelope(envelope, { now: new Date('2026-08-30T12:00:30.000Z'), registered, relayDomain: 'b.example', skipSenderRegistration: true }),
    (err) => err.code === 'MESSAGE_EXPIRED',
  );
});

test('skipSenderRegistration still fails closed on signature when the synthetic entry is missing', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = 'key_ep_codex@a.example';
  const envelope = signedEnvelope(privateKey, keyId);
  assert.throws(
    () => validateEnvelope(envelope, {
      now: new Date('2026-08-30T12:00:30.000Z'), registered: new Map(), relayDomain: 'b.example', skipSenderRegistration: true,
    }),
    (err) => err.code === 'INVALID_SIGNATURE',
  );
});

test('skipSenderRegistration skips ENDPOINT_REVOKED for a non-active synthetic entry', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = 'key_ep_codex@a.example';
  const envelope = signedEnvelope(privateKey, keyId);
  const registered = new Map([[envelope.sender.endpoint_id, {
    endpoint_id: envelope.sender.endpoint_id, owner_id: envelope.sender.owner_id, status: 'revoked',
    keys: [{ key_id: keyId, public_key: publicKey, status: 'active' }],
  }]]);
  const result = validateEnvelope(envelope, {
    now: new Date('2026-08-30T12:00:30.000Z'), registered, relayDomain: 'b.example', skipSenderRegistration: true,
  });
  assert.equal(result.accepted, true);
  assert.throws(
    () => validateEnvelope(envelope, { now: new Date('2026-08-30T12:00:30.000Z'), registered, relayDomain: 'b.example' }),
    (err) => err.code === 'ENDPOINT_REVOKED',
  );
});
