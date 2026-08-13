import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { LocalOutbox } from './local-outbox.mjs';
import { signedBytes } from '../../relay/v1/validate-envelope.mjs';

test('queues and signs outbound envelope', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const outbox = new LocalOutbox({ privateKey, endpoint: { owner_id: 'usr_1', endpoint_id: 'ep_codex', key_id: 'key_1', kind: 'agent' } });
  const item = outbox.queue({ protocol: 'sigil/1', message_id: 'msg_1', conversation_id: 'conv_1', message_type: 'task.request', body: {}, context_refs: [], capabilities: [], idempotency_key: 'send_1', created_at: '2026-08-13T12:00:00Z', expires_at: '2026-08-14T00:00:00Z', recipient: { endpoint_id: 'ep_claude' } });
  assert.equal(crypto.verify(null, signedBytes(item.envelope), publicKey, Buffer.from(item.envelope.signature.value, 'base64url')), true);
  assert.equal(item.state, 'pending');
});

test('deduplicates queued message and marks relay acceptance', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const outbox = new LocalOutbox({ privateKey, endpoint: { owner_id: 'usr_1', endpoint_id: 'ep_codex', key_id: 'key_1', kind: 'agent' } });
  const first = outbox.queue({ message_id: 'msg_1', idempotency_key: 'send_1' });
  assert.equal(outbox.queue({ message_id: 'msg_1', idempotency_key: 'send_1' }), first);
  assert.equal(outbox.markAccepted('msg_1').state, 'accepted');
  assert.equal(outbox.pending().length, 0);
});
