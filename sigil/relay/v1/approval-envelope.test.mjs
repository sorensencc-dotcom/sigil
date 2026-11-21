import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { bindChallengeEnvelope, envelopeHash } from './approval-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { entryFromRegistryRow } from './trusted-endpoint.mjs';

const NOW = new Date('2026-10-02T12:01:00.000Z');

function world() {
  const keys = crypto.generateKeyPairSync('ed25519');
  const entry = entryFromRegistryRow({ endpoint_id: 'ep_codex', owner_id: 'usr_chris', status: 'active', key_id: 'key_codex', public_key: keys.publicKey });
  const envelope = {
    protocol: 'sigil/1', message_id: 'msg_1', conversation_id: 'conv_1', message_type: 'chat.message',
    sender: { endpoint_id: 'ep_codex', owner_id: 'usr_chris' }, recipient: { endpoint_id: 'ep_claude' },
    body: { text: 'run the gated tool' }, context_refs: [], capabilities: ['sigil.approval/request'], correlation_id: null,
    idempotency_key: 'idem_1', created_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-02T13:00:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: 'key_codex', value: '' },
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.privateKey).toString('base64url');
  return { keys, entry, envelope };
}

const bind = (w, overrides = {}) => bindChallengeEnvelope({ envelope: w.envelope, principalEndpointId: 'ep_codex', entry: w.entry, now: NOW, ...overrides });
const code = (fn) => { try { fn(); } catch (error) { return error.code; } return null; };

test('binds a valid signed envelope and returns the fields to store', () => {
  const w = world();
  const bound = bind(w);
  assert.equal(bound.actionHash, envelopeHash(w.envelope));
  assert.equal(bound.conversationId, 'conv_1');
  assert.equal(bound.messageId, 'msg_1');
  assert.deepEqual(bound.capabilities, ['sigil.approval/request']);
  assert.equal(bound.envelope, w.envelope);
});

test('accepts an action_hash given in hex or sha256: form, and none at all', () => {
  const w = world();
  const hash = envelopeHash(w.envelope);
  assert.equal(bind(w, { actionHash: hash }).actionHash, hash);
  assert.equal(bind(w, { actionHash: `sha256:${hash}` }).actionHash, hash);
  assert.equal(bind(w, { actionHash: undefined }).actionHash, hash);
});

test('rejects an action_hash that differs from the envelope canonical hash', () => {
  const w = world();
  assert.equal(code(() => bind(w, { actionHash: 'f'.repeat(64) })), 'INVALID_ACTION');
});

test('rejects an envelope sent by a different endpoint than the authenticated one', () => {
  const w = world();
  assert.equal(code(() => bind(w, { principalEndpointId: 'ep_other' })), 'ROUTE_NOT_AUTHORIZED');
});

test('rejects a forged or missing signature', () => {
  const w = world();
  const forged = { ...w.envelope, signature: { ...w.envelope.signature, value: Buffer.alloc(64, 1).toString('base64url') } };
  assert.equal(code(() => bind(w, { envelope: forged })), 'INVALID_SIGNATURE');
  const unsigned = { ...w.envelope, signature: undefined };
  assert.equal(code(() => bind(w, { envelope: unsigned })), 'INVALID_SIGNATURE');
});

test('rejects a body changed after signing, even when action_hash is recomputed by the caller', () => {
  const w = world();
  const tampered = { ...w.envelope, body: { text: 'a different action' } };
  assert.equal(code(() => bind(w, { envelope: tampered, actionHash: envelopeHash(tampered) })), 'INVALID_SIGNATURE');
});

test('rejects an unknown, revoked, or expired-envelope sender', () => {
  const w = world();
  assert.equal(code(() => bind(w, { entry: null })), 'UNKNOWN_ENDPOINT');
  assert.equal(code(() => bind(w, { entry: { ...w.entry, status: 'revoked' } })), 'ENDPOINT_REVOKED');
  assert.equal(code(() => bind(w, { now: new Date('2026-10-02T14:00:00.000Z') })), 'MESSAGE_EXPIRED');
});

test('rejects a non-object envelope', () => {
  const w = world();
  for (const envelope of [null, 'text', 7, [], undefined]) assert.equal(code(() => bind(w, { envelope })), 'INVALID_ACTION');
});
