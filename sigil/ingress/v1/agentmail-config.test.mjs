import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAgentMailConfig, resolveInboxMapping } from './agentmail-config.mjs';

const baseEnv = {
  SIGIL_AGENTMAIL_WEBHOOK_SECRETS: JSON.stringify({ wh_triage: 'secret-triage' }),
  SIGIL_AGENTMAIL_API_KEY_REF: 'secret://sigil/agentmail/api-key',
  SIGIL_AGENTMAIL_INBOX_MAPPINGS: JSON.stringify([
    { providerInboxId: 'inbox_a', endpointId: 'ep_triage' },
    { providerInboxId: 'inbox_b', endpointId: 'ep_judgment' },
    { providerInboxId: 'inbox_c', endpointId: 'ep_iron' },
  ]),
  SIGIL_AGENTMAIL_SENDER_ALLOWLIST: JSON.stringify(['operator@example.test']),
  SIGIL_AGENTMAIL_FORWARDING_TOKENS: JSON.stringify({
    'triage+trm': 'A'.repeat(22),
    'judgment+review': 'B'.repeat(22),
  }),
};

test('loadAgentMailConfig rejects missing required configuration', () => {
  assert.throws(() => loadAgentMailConfig({}), { code: 'AGENTMAIL_CONFIG_MISSING' });
});

test('loadAgentMailConfig parses mappings and defaults limits', () => {
  const config = loadAgentMailConfig(baseEnv);
  assert.equal(config.apiKeyRef, baseEnv.SIGIL_AGENTMAIL_API_KEY_REF);
  assert.equal(config.inboxMappings.length, 3);
  assert.equal(config.limits.maxMessageBytes, 10 * 1024 * 1024);
  assert.equal(config.limits.maxAttachmentBytes, 5 * 1024 * 1024);
  assert.equal(config.limits.maxParserSeconds, 120);
  assert.equal(config.limits.maxRetries, 3);
  assert.equal(config.limits.maxQueueDepth, 100);
  assert.equal(config.limits.senderPerMinute, 10);
});

test('duplicate provider inbox and endpoint mappings fail closed', () => {
  const duplicateInbox = { ...baseEnv, SIGIL_AGENTMAIL_INBOX_MAPPINGS: JSON.stringify([
    { providerInboxId: 'same', endpointId: 'ep_triage' },
    { providerInboxId: 'same', endpointId: 'ep_judgment' },
    { providerInboxId: 'inbox_c', endpointId: 'ep_iron' },
  ]) };
  assert.throws(() => loadAgentMailConfig(duplicateInbox), { code: 'MULTIPLE_INBOX_MAPPING' });

  const duplicateEndpoint = { ...baseEnv, SIGIL_AGENTMAIL_INBOX_MAPPINGS: JSON.stringify([
    { providerInboxId: 'inbox_a', endpointId: 'ep_triage' },
    { providerInboxId: 'inbox_b', endpointId: 'ep_triage' },
    { providerInboxId: 'inbox_c', endpointId: 'ep_iron' },
  ]) };
  assert.throws(() => loadAgentMailConfig(duplicateEndpoint), { code: 'MULTIPLE_INBOX_MAPPING' });
});

test('resolveInboxMapping rejects unknown and ambiguous inboxes', () => {
  const mappings = [
    { providerInboxId: 'inbox_a', endpointId: 'ep_triage', workflowPolicy: ['trm'] },
    { providerInboxId: 'inbox_b', endpointId: 'ep_judgment', workflowPolicy: ['review'] },
  ];
  assert.deepEqual(resolveInboxMapping(mappings, 'inbox_a'), mappings[0]);
  assert.throws(() => resolveInboxMapping(mappings, 'missing'), { code: 'UNKNOWN_INBOX' });
  assert.throws(() => resolveInboxMapping([
    ...mappings,
    { providerInboxId: 'inbox_a', endpointId: 'ep_iron', workflowPolicy: ['test'] },
  ], 'inbox_a'), { code: 'MULTIPLE_INBOX_MAPPING' });
});
