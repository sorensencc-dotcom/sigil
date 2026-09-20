import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLegacyAgentMailConfig } from './agentmail-legacy-config.mjs';

const env = {
  SIGIL_AGENTMAIL_WEBHOOK_SECRETS: JSON.stringify({ wh_triage: 'synthetic-webhook-secret' }),
  SIGIL_AGENTMAIL_FORWARDING_TOKENS: JSON.stringify({ 'triage+trm': 'A'.repeat(22) }),
  SIGIL_AGENTMAIL_API_KEY_REF: 'env://AGENTMAIL_API_KEY',
  SIGIL_AGENTMAIL_FORWARDING_DOMAIN: 'agentmail.test',
  SIGIL_AGENTMAIL_INBOX_MAPPINGS: JSON.stringify([
    { providerInboxId: 'inbox_a', endpointId: 'ep_triage', webhookSecretId: 'wh_triage' },
    { providerInboxId: 'inbox_b', endpointId: 'ep_judgment', webhookSecretId: 'wh_triage' },
    { providerInboxId: 'inbox_c', endpointId: 'ep_iron', webhookSecretId: 'wh_triage' },
  ]),
  SIGIL_AGENTMAIL_SENDER_ALLOWLIST: JSON.stringify(['operator@example.test']),
};

test('legacy shim returns reference-only config and an injected local provider', async () => {
  const result = loadLegacyAgentMailConfig(env);
  assert.equal(result.compatibility.rawConfigUsed, true);
  assert.equal(result.config.webhookSecrets, undefined);
  assert.equal(result.config.webhookSecretRefs.wh_triage.scheme, 'env');
  assert.equal(result.config.forwardingTokenRefs['triage+trm'].scheme, 'env');
  const resolved = await result.providers.env({ reference: result.config.webhookSecretRefs.wh_triage });
  assert.equal(resolved.value, 'synthetic-webhook-secret');
});

test('legacy shim refuses production mode', () => {
  assert.throws(() => loadLegacyAgentMailConfig(env, { mode: 'production' }), { code: 'SECRET_POLICY_VIOLATION' });
});
