import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { LocalInbox } from '../connectors/v1/local-inbox.mjs';
import { LocalOutbox } from '../connectors/v1/local-outbox.mjs';
import { acceptEnvelope } from '../relay/v1/accept-envelope.mjs';
import { DeliveryQueue } from '../relay/v1/delivery-queue.mjs';
import { signedBytes } from '../relay/v1/validate-envelope.mjs';

test('Codex -> relay -> Claude -> relay -> Codex vertical slice', () => {
  const codexKeys = crypto.generateKeyPairSync('ed25519');
  const claudeKeys = crypto.generateKeyPairSync('ed25519');
  const codex = { owner_id: 'usr_codex', endpoint_id: 'ep_codex', key_id: 'key_codex', kind: 'agent' };
  const claude = { owner_id: 'usr_claude', endpoint_id: 'ep_claude', key_id: 'key_claude', kind: 'agent' };
  const registry = new Map([
    ['ep_codex', { ...codex, status: 'active', public_key: codexKeys.publicKey }],
    ['ep_claude', { ...claude, status: 'active', public_key: claudeKeys.publicKey }]
  ]);
  const outbox = new LocalOutbox({ privateKey: codexKeys.privateKey, endpoint: codex });
  const inbox = new LocalInbox();
  const template = JSON.parse(fs.readFileSync(new URL('../contracts/v1/envelope.example.json', import.meta.url)));
  const item = outbox.queue({ ...template, message_id: 'msg_task_1', conversation_id: 'conv_1', sender: codex, recipient: claude, body: { task_id: 'task_1', instruction: 'Review migration.' }, created_at: '2026-08-13T12:00:00Z', expires_at: '2026-08-14T00:00:00Z' });
  const accepted = acceptEnvelope(item.envelope, { now: new Date('2026-08-13T12:01:00Z'), registered: registry, persist: () => {} });
  assert.equal(accepted.status, 202);
  const queue = new DeliveryQueue(); queue.enqueue({ delivery_id: 'del_task_1', message_id: item.envelope.message_id, attempts: 0 });
  queue.transition('del_task_1', 'delivered'); queue.transition('del_task_1', 'acknowledged');
  assert.equal(inbox.receive(item.envelope).duplicate, false);
  queue.transition('del_task_1', 'processing');
  const result = { ...template, message_id: 'msg_result_1', conversation_id: 'conv_1', sender: claude, recipient: codex, message_type: 'task.result', body: { task_id: 'task_1', status: 'completed', summary: 'Migration reviewed.' }, created_at: '2026-08-13T12:02:00Z', expires_at: '2026-08-14T00:00:00Z', signature: { algorithm: 'Ed25519', key_id: claude.key_id, value: '' } };
  result.signature.value = crypto.sign(null, signedBytes(result), claudeKeys.privateKey).toString('base64url');
  assert.equal(acceptEnvelope(result, { now: new Date('2026-08-13T12:03:00Z'), registered: registry, persist: () => {} }).status, 202);
  queue.transition('del_task_1', 'processed');
  assert.equal(queue.get('del_task_1').state, 'processed');
});

test('replay of an already-accepted message under a new idempotency_key is rejected (§18 #13)', async () => {
  const { acceptEnvelopeAsync } = await import('../relay/v1/accept-envelope.mjs');
  const { createMemoryRepository } = await import('../cli/memory-repository.mjs');
  const keys = crypto.generateKeyPairSync('ed25519');
  const sender = { owner_id: 'usr_replay', endpoint_id: 'ep_replay', key_id: 'key_replay', kind: 'agent' };
  const registered = new Map([['ep_replay', { ...sender, status: 'active', public_key: keys.publicKey }]]);
  const repository = createMemoryRepository();
  const template = JSON.parse(fs.readFileSync(new URL('../contracts/v1/envelope.example.json', import.meta.url)));
  // Note: signature.key_id must be overridden to match the registered
  // endpoint's key_id ('key_replay') -- the template's default key_id
  // ('key_01JEXAMPLE') would otherwise fail signature-key lookup.
  const envelope = { ...template, message_id: 'msg_replay_1', conversation_id: 'conv_replay', sender, recipient: sender, message_type: 'chat.message', body: { text: 'hi' }, created_at: '2026-08-16T12:00:00Z', expires_at: '2026-08-16T13:00:00Z', signature: { algorithm: 'Ed25519', key_id: sender.key_id, value: '' } };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.privateKey).toString('base64url');
  const first = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:00:30Z') });
  assert.equal(first.status, 202);
  const replayed = { ...envelope, idempotency_key: 'a-different-idempotency-key' };
  replayed.signature.value = crypto.sign(null, signedBytes(replayed), keys.privateKey).toString('base64url');
  const second = await acceptEnvelopeAsync(replayed, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'REPLAY_DETECTED');
});

test('grant -> send succeeds -> revoke -> resend denied (§18 #10)', async () => {
  const { acceptEnvelopeAsync } = await import('../relay/v1/accept-envelope.mjs');
  const { createMemoryRepository } = await import('../cli/memory-repository.mjs');
  const keys = crypto.generateKeyPairSync('ed25519');
  const sender = { owner_id: 'usr_revoke', endpoint_id: 'ep_revoke', key_id: 'key_revoke', kind: 'agent' };
  const registered = new Map([['ep_revoke', { ...sender, status: 'active', public_key: keys.publicKey }]]);
  const repository = createMemoryRepository();
  const template = JSON.parse(fs.readFileSync(new URL('../contracts/v1/envelope.example.json', import.meta.url)));
  const conversationId = 'conv_revoke';
  const grant = await repository.createCapabilityGrant({ grantId: 'grant_1', capability: 'sigil.task/submit', scope: `scope:conversation/${conversationId}`, grantedTo: 'ep_revoke', expiresAt: '2026-08-17T00:00:00Z', now: new Date('2026-08-16T12:00:00Z') });
  const envelope1 = { ...template, message_id: 'msg_revoke_1', conversation_id: conversationId, sender, recipient: sender, capabilities: ['sigil.task/submit'], body: { task_id: 'task_r1', instruction: 'x' }, created_at: '2026-08-16T12:00:00Z', expires_at: '2026-08-16T13:00:00Z', signature: { algorithm: 'Ed25519', key_id: sender.key_id, value: '' } };
  envelope1.signature.value = crypto.sign(null, signedBytes(envelope1), keys.privateKey).toString('base64url');
  const first = await acceptEnvelopeAsync(envelope1, { registered, repository, now: new Date('2026-08-16T12:00:30Z') });
  assert.equal(first.status, 202);

  await repository.revokeCapabilityGrant(grant.grant_id, { now: new Date('2026-08-16T12:01:00Z') });

  const envelope2 = { ...template, message_id: 'msg_revoke_2', conversation_id: conversationId, sender, recipient: sender, capabilities: ['sigil.task/submit'], idempotency_key: 'send_revoke_2', body: { task_id: 'task_r2', instruction: 'y' }, created_at: '2026-08-16T12:02:00Z', expires_at: '2026-08-16T13:02:00Z', signature: { algorithm: 'Ed25519', key_id: sender.key_id, value: '' } };
  envelope2.signature.value = crypto.sign(null, signedBytes(envelope2), keys.privateKey).toString('base64url');
  const second = await acceptEnvelopeAsync(envelope2, { registered, repository, now: new Date('2026-08-16T12:02:30Z') });
  assert.equal(second.status, 403);
  assert.equal(second.body.code, 'CAPABILITY_DENIED');
});
