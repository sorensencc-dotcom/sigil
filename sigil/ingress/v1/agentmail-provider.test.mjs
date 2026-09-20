import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Webhook } from 'svix';
import { createAgentMailProvider } from './agentmail-provider.mjs';

test('provider verifies raw Svix payload and maps AgentMail message fields', async () => {
  const calls = [];
  const provider = createAgentMailProvider({
    transport: { async fetchMessage() { throw new Error('should not fetch when body is present'); } },
    verifierFactory: () => ({ verify(body, headers) { calls.push([body, headers]); } }),
  });
  const rawBody = JSON.stringify({
    event_type: 'message.received',
    event_id: 'evt_1',
    message: { inbox_id: 'inbox_a', thread_id: 'thread_1', message_id: 'msg_1', from_: ['operator@example.test'], to: ['triage+trm+TOKEN@agentmail.test'], text: 'synthetic', attachments: [] },
  });
  const event = await provider.verifyWebhook({ rawBody, inboxId: 'inbox_a', webhookSecret: 'whsec_synthetic', headers: { 'svix-id': 'msg_1', 'svix-timestamp': '1', 'svix-signature': 'v1,synthetic' } });
  assert.equal(event.eventId, 'evt_1');
  assert.equal(event.messageId, 'msg_1');
  assert.equal(event.from, 'operator@example.test');
  assert.equal(event.alias, 'triage+trm+TOKEN@agentmail.test');
  assert.equal(event.normalizedInstruction, undefined);
  assert.equal(calls.length, 1);
});

test('provider rejects malformed or mismatched webhook events', async () => {
  const provider = createAgentMailProvider({ transport: { async fetchMessage() {} }, verifierFactory: () => ({ verify() { throw Object.assign(new Error('bad signature'), { name: 'WebhookVerificationError' }); } }) });
  await assert.rejects(provider.verifyWebhook({ rawBody: '{}', inboxId: 'inbox_a', webhookSecret: 'whsec_synthetic', headers: {} }), { code: 'WEBHOOK_SIGNATURE_INVALID' });
  const eventProvider = createAgentMailProvider({ transport: { async fetchMessage() {} }, verifierFactory: () => ({ verify() {} }) });
  await assert.rejects(eventProvider.verifyWebhook({ rawBody: JSON.stringify({ event_type: 'message.sent', event_id: 'evt_1', message: {} }), inboxId: 'inbox_a', webhookSecret: 'whsec_synthetic', headers: { 'svix-id': '1', 'svix-timestamp': '1', 'svix-signature': 'v1,x' } }), { code: 'WEBHOOK_EVENT_UNSUPPORTED' });
});

test('provider uses the real Svix verifier against the raw body', async () => {
  const secret = `whsec_${Buffer.from(crypto.randomBytes(32)).toString('base64')}`;
  const rawBody = JSON.stringify({ event_type: 'message.received', event_id: 'evt_real', message: { inbox_id: 'inbox_a', message_id: 'msg_real', from: 'operator@example.test', to: ['triage+trm+TOKEN@agentmail.test'], text: 'synthetic' } });
  const webhook = new Webhook(secret);
  const headers = { 'svix-id': 'msg_real', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': webhook.sign('msg_real', new Date(), rawBody) };
  const provider = createAgentMailProvider({ transport: { async fetchMessage() {} } });
  const event = await provider.verifyWebhook({ rawBody, headers, inboxId: 'inbox_a', webhookSecret: secret });
  assert.equal(event.eventId, 'evt_real');
  await assert.rejects(provider.verifyWebhook({ rawBody: `${rawBody} `, headers, inboxId: 'inbox_a', webhookSecret: secret }), { code: 'WEBHOOK_SIGNATURE_INVALID' });
});
