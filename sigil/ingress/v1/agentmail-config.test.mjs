import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAgentMailConfig, resolveInboxMapping } from './agentmail-config.mjs';

const baseEnv = {
  SIGIL_AGENTMAIL_WEBHOOK_SECRET_REFS: JSON.stringify({ wh_triage: 'secret://sigil/agentmail/webhook/triage', wh_judgment: 'secret://sigil/agentmail/webhook/judgment', wh_iron: 'secret://sigil/agentmail/webhook/iron' }),
  SIGIL_AGENTMAIL_API_KEY_REF: 'secret://sigil/agentmail/api-key',
  SIGIL_AGENTMAIL_FORWARDING_DOMAIN: 'agentmail.test',
  SIGIL_AGENTMAIL_INBOX_MAPPINGS: JSON.stringify([
    { providerInboxId: 'inbox_a', endpointId: 'ep_triage', webhookSecretId: 'wh_triage' },
    { providerInboxId: 'inbox_b', endpointId: 'ep_judgment', webhookSecretId: 'wh_judgment' },
    { providerInboxId: 'inbox_c', endpointId: 'ep_iron', webhookSecretId: 'wh_iron' },
  ]),
  SIGIL_AGENTMAIL_SENDER_ALLOWLIST: JSON.stringify(['operator@example.test']),
  SIGIL_AGENTMAIL_FORWARDING_TOKEN_REFS: JSON.stringify({
    'triage+trm': 'secret://sigil/agentmail/forwarding/triage-trm',
    'judgment+review': 'secret://sigil/agentmail/forwarding/judgment-review',
  }),
};

test('loadAgentMailConfig rejects missing required configuration', () => {
  assert.throws(() => loadAgentMailConfig({}), { code: 'AGENTMAIL_CONFIG_MISSING' });
});

test('loadAgentMailConfig parses mappings and defaults limits', () => {
  const config = loadAgentMailConfig(baseEnv);
  assert.equal(config.apiKeyRef.display, baseEnv.SIGIL_AGENTMAIL_API_KEY_REF);
  assert.equal(config.webhookSecretRefs.wh_triage.path, 'agentmail/webhook/triage');
  assert.equal(config.forwardingTokenRefs['triage+trm'].scheme, 'secret');
  assert.equal(config.forwardingDomain, 'agentmail.test');
  assert.equal(config.inboxMappings[0].webhookSecretId, 'wh_triage');
  assert.equal(config.inboxMappings.length, 3);
  assert.equal(config.limits.maxMessageBytes, 10 * 1024 * 1024);
  assert.equal(config.limits.maxAttachmentBytes, 5 * 1024 * 1024);
  assert.equal(config.limits.maxParserSeconds, 120);
  assert.equal(config.limits.maxRetries, 3);
  assert.equal(config.limits.maxQueueDepth, 100);
  assert.equal(config.limits.senderPerMinute, 10);
});

test('non-canonical endpoints and missing webhook secret mappings fail closed', () => {
  const nonCanonical = { ...baseEnv, SIGIL_AGENTMAIL_INBOX_MAPPINGS: JSON.stringify([
    { providerInboxId: 'inbox_a', endpointId: 'ep_ingress', webhookSecretId: 'wh_triage' },
    { providerInboxId: 'inbox_b', endpointId: 'ep_judgment', webhookSecretId: 'wh_judgment' },
    { providerInboxId: 'inbox_c', endpointId: 'ep_iron', webhookSecretId: 'wh_iron' },
  ]) };
  assert.throws(() => loadAgentMailConfig(nonCanonical), { code: 'AGENTMAIL_CONFIG_INVALID' });
  const missingSecret = { ...baseEnv, SIGIL_AGENTMAIL_INBOX_MAPPINGS: JSON.stringify([
    { providerInboxId: 'inbox_a', endpointId: 'ep_triage', webhookSecretId: 'missing' },
    { providerInboxId: 'inbox_b', endpointId: 'ep_judgment', webhookSecretId: 'wh_judgment' },
    { providerInboxId: 'inbox_c', endpointId: 'ep_iron', webhookSecretId: 'wh_iron' },
  ]) };
  assert.throws(() => loadAgentMailConfig(missingSecret), { code: 'AGENTMAIL_CONFIG_INVALID' });
});

test('production rejects raw credential variables and mixed reference/raw configuration', () => {
  assert.throws(() => loadAgentMailConfig({ ...baseEnv, SIGIL_AGENTMAIL_WEBHOOK_SECRETS: '{}' }), { code: 'SECRET_POLICY_VIOLATION' });
  assert.throws(() => loadAgentMailConfig({ ...baseEnv, SIGIL_AGENTMAIL_FORWARDING_TOKENS: '{}' }), { code: 'SECRET_POLICY_VIOLATION' });
});

test('duplicate provider inbox and endpoint mappings fail closed', () => {
  const duplicateInbox = { ...baseEnv, SIGIL_AGENTMAIL_INBOX_MAPPINGS: JSON.stringify([
    { providerInboxId: 'same', endpointId: 'ep_triage', webhookSecretId: 'wh_triage' },
    { providerInboxId: 'same', endpointId: 'ep_judgment', webhookSecretId: 'wh_judgment' },
    { providerInboxId: 'inbox_c', endpointId: 'ep_iron', webhookSecretId: 'wh_iron' },
  ]) };
  assert.throws(() => loadAgentMailConfig(duplicateInbox), { code: 'MULTIPLE_INBOX_MAPPING' });

  const duplicateEndpoint = { ...baseEnv, SIGIL_AGENTMAIL_INBOX_MAPPINGS: JSON.stringify([
    { providerInboxId: 'inbox_a', endpointId: 'ep_triage', webhookSecretId: 'wh_triage' },
    { providerInboxId: 'inbox_b', endpointId: 'ep_triage', webhookSecretId: 'wh_judgment' },
    { providerInboxId: 'inbox_c', endpointId: 'ep_iron', webhookSecretId: 'wh_iron' },
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
