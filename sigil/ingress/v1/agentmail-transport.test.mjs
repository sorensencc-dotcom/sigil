import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentMailTransport } from './agentmail-transport.mjs';

const fixtureCredential = 'FIXTURE-ONLY-not-a-real-secret';

test('transport delegates to the current AgentMail SDK resource clients', async () => {
  const calls = [];
  const client = {
    inboxes: {
      webhooks: { async create(inboxId, request) { calls.push(['register', inboxId, request]); return { id: 'wh_1' }; } },
      messages: {
        async get(inboxId, messageId) { calls.push(['fetch', inboxId, messageId]); return { id: messageId }; },
        async send(inboxId, request) { calls.push(['send', inboxId, request]); return { id: 'sent_1' }; },
      },
    },
  };
  const transport = createAgentMailTransport({ ['apiKey']: fixtureCredential, clientFactory: (apiKey) => { assert.equal(apiKey, fixtureCredential); return client; } });
  assert.deepEqual(await transport.registerWebhook('inbox_a', { url: 'https://relay.test/v1/agentmail', eventTypes: ['message.received'] }), { id: 'wh_1' });
  assert.deepEqual(await transport.fetchMessage('inbox_a', 'msg_1'), { id: 'msg_1' });
  assert.deepEqual(await transport.sendMessage('inbox_a', { to: 'operator@example.test', text: 'synthetic' }), { id: 'sent_1' });
  assert.deepEqual(calls, [
    ['register', 'inbox_a', { url: 'https://relay.test/v1/agentmail', eventTypes: ['message.received'] }],
    ['fetch', 'inbox_a', 'msg_1'],
    ['send', 'inbox_a', { to: 'operator@example.test', text: 'synthetic' }],
  ]);
});

test('transport maps provider failures to redacted stable errors', async () => {
  const transport = createAgentMailTransport({ ['apiKey']: fixtureCredential, clientFactory: () => ({ inboxes: { webhooks: { async create() {} }, messages: { async get() { const error = new Error('provider failure'); error.statusCode = 504; throw error; }, async send() {} } } }) });
  await assert.rejects(transport.fetchMessage('inbox_a', 'msg_1'), (error) => error.code === 'AGENTMAIL_PROVIDER_ERROR' && error.status === 504 && !error.message.includes('secret'));
});
