import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentMailDeployment } from './agentmail-bootstrap.mjs';

const baseEnv = {
  SIGIL_AGENTMAIL_ENABLE: '1', SIGIL_AGENTMAIL_API_KEY_REF: 'env://API_KEY', SIGIL_AGENTMAIL_WEBHOOK_SECRET_REFS: JSON.stringify({ wh_triage: 'env://WH_TRIAGE', wh_judgment: 'env://WH_JUDGMENT', wh_iron: 'env://WH_IRON' }), SIGIL_AGENTMAIL_FORWARDING_TOKEN_REFS: JSON.stringify({ 'triage+trm': 'env://TOKEN_TRIAGE', 'judgment+review': 'env://TOKEN_JUDGMENT' }), SIGIL_AGENTMAIL_FORWARDING_DOMAIN: 'agentmail.test', SIGIL_AGENTMAIL_INBOX_MAPPINGS: JSON.stringify([{ providerInboxId: 'inbox_a', endpointId: 'ep_triage', webhookSecretId: 'wh_triage' }, { providerInboxId: 'inbox_b', endpointId: 'ep_judgment', webhookSecretId: 'wh_judgment' }, { providerInboxId: 'inbox_c', endpointId: 'ep_iron', webhookSecretId: 'wh_iron' }]), SIGIL_AGENTMAIL_SENDER_ALLOWLIST: JSON.stringify(['operator@example.test']),
};
const values = { 'env://API_KEY': 'api', 'env://WH_TRIAGE': 'wh-a', 'env://WH_JUDGMENT': 'wh-b', 'env://WH_IRON': 'wh-c', 'env://TOKEN_TRIAGE': 'A'.repeat(22), 'env://TOKEN_JUDGMENT': 'B'.repeat(22) };
function repository() { const state = { control_id: 'agentmail', state: 'disabled', version: 1 }; return { state, pool: {}, async query(text, valuesArg) { if (text.includes('SELECT')) return { rows: [{ ...state }] }; if (text.startsWith('UPDATE') && text.includes('state =')) { state.state = valuesArg[1]; state.version = valuesArg[2]; return { rowCount: 1 }; } if (text.startsWith('UPDATE')) return { rowCount: 1 }; return { rowCount: 1 }; }, async withTransaction(fn) { return fn({ query: (text, valuesArg) => this.query(text, valuesArg) }); }, async lookupCapabilityRegistration() { return { risk_tier: 'standard' }; }, async lookupActiveCapabilityGrants() { return []; } }; }

test('deployment remains absent when opt-in is not set', async () => { assert.equal(await createAgentMailDeployment({ env: {}, mode: 'test' }), null); });
test('production requires PostgreSQL before resolving secrets', async () => { await assert.rejects(createAgentMailDeployment({ env: baseEnv, mode: 'production', secretProviders: { env: async () => ({ value: 'synthetic' }) } }), { code: 'AGENTMAIL_POSTGRES_REQUIRED' }); });
test('enabled deployment constructs ingress and control but starts disabled', async () => {
  let received;
  const deployment = await createAgentMailDeployment({ env: baseEnv, mode: 'test', repository: repository(), ingress: { endpoint: { endpoint_id: 'ep_ingress' }, ownerId: 'usr_operator', signer: {} }, registry: new Map(), secretProviders: { env: async ({ reference }) => ({ value: values[reference.display], version: 'v1' }) }, providerFactory: async (args) => { received = args; return { async verifyWebhook() { return {}; } }; }, providerRotation: { async rotate() { return { supported: false, committed: false, receipt: {} }; } } });
  assert.ok(deployment.agentmailIngress); assert.ok(deployment.agentmailControl); assert.equal(deployment.agentmailControl.cache.current().state, 'disabled'); assert.ok(received.secretStore); deployment.close();
});
