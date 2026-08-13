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
