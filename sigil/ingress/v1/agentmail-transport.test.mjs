import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentMailTransport } from './agentmail-transport.mjs';
import { createAgentMailSecretStore } from './agentmail-secret-snapshot.mjs';

const fixtureCredential = 'FIXTURE-ONLY-not-a-real-secret';
function store(generation = 'g1', value = fixtureCredential) {
  return createAgentMailSecretStore({ generation, withApiKey: (callback) => callback({ withValue: (fn) => fn(value) }) });
}

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
  const transport = createAgentMailTransport({ secretStore: store(), clientFactory: (apiKey) => { assert.equal(apiKey, fixtureCredential); return client; } });
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
  const transport = createAgentMailTransport({ secretStore: store(), clientFactory: () => ({ inboxes: { webhooks: { async create() {} }, messages: { async get() { const error = new Error('provider failure'); error.statusCode = 504; throw error; }, async send() {} } } }) });
  await assert.rejects(transport.fetchMessage('inbox_a', 'msg_1'), (error) => error.code === 'AGENTMAIL_PROVIDER_ERROR' && error.status === 504 && !error.message.includes('secret'));
});

test('transport creates one client per active generation and rejects raw-key construction', async () => {
  const created = [];
  const client = { inboxes: { webhooks: { async create() {} }, messages: { async get() { return { ok: true }; }, async send() {} } } };
  const secretStore = store();
  const transport = createAgentMailTransport({ secretStore, clientFactory: (key) => { created.push(key); return client; } });
  await transport.fetchMessage('inbox_a', 'one');
  await transport.fetchMessage('inbox_a', 'two');
  assert.deepEqual(created, [fixtureCredential]);
  assert.throws(() => createAgentMailTransport({ apiKey: fixtureCredential }), { code: 'AGENTMAIL_CONFIG_MISSING' });
});

test('transport exposes a bounded wait for in-flight provider calls', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const client = { inboxes: { webhooks: { async create() {} }, messages: { async get() { await pending; return { ok: true }; }, async send() {} } } };
  const transport = createAgentMailTransport({ secretStore: store(), clientFactory: () => client });
  const request = transport.fetchMessage('inbox_a', 'msg_1');
  await assert.rejects(transport.waitForIdle({ timeoutMs: 5 }), { code: 'CONTROL_DRAIN_TIMEOUT' });
  release();
  await request;
  await transport.waitForIdle({ timeoutMs: 50 });
});
