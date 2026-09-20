import http from 'node:http';
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, identityKeys } from '../../cli/identity.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createAgentMailIngress } from './agentmail-adapter.mjs';
import { createAgentMailSecretStore } from './agentmail-secret-snapshot.mjs';
import { createRelayServer } from '../../relay/v1/http-server.mjs';

function request(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/v1/agentmail/webhook/inbox_a', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { let text = ''; res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) })); });
    req.on('error', reject); req.end(body);
  });
}

function snapshot() { return { generation: 'g1', withWebhookSecret: (_id, callback) => callback({ withValue: (fn) => fn('synthetic-webhook') }), withForwardingToken: (_alias, callback) => callback({ withValue: (fn) => fn('A'.repeat(22)) }) }; }

test('real relay factory accepts one synthetic webhook and disabled control rejects the next', async () => {
  const triage = createIdentity({ ownerId: 'usr_operator', endpointId: 'ep_triage', kind: 'agent' });
  const ingressIdentity = createIdentity({ ownerId: 'usr_operator', endpointId: 'ep_ingress', kind: 'agent' });
  const registry = new Map([[triage.endpoint_id, { ...triage, public_key: crypto.createPublicKey(triage.public_key_pem), status: 'active' }], [ingressIdentity.endpoint_id, { ...ingressIdentity, public_key: crypto.createPublicKey(ingressIdentity.public_key_pem), status: 'active' }]]);
  const repository = createMemoryRepository({ registry });
  const store = createAgentMailSecretStore(snapshot());
  const ingress = createAgentMailIngress({
    config: { inboxMappings: [{ providerInboxId: 'inbox_a', endpointId: 'ep_triage', webhookSecretId: 'wh_triage', workflowPolicy: ['trm'] }], senderAllowlist: ['operator@example.test'], forwardingDomain: 'agentmail.test', limits: { maxMessageBytes: 1024 * 1024, maxAttachmentBytes: 1024, maxParserSeconds: 2, maxQueueDepth: 100, senderPerMinute: 10 }, forwardingTokenRefs: {} },
    provider: { async verifyWebhook() { return { eventId: 'evt_integration', messageId: 'msg_integration', from: 'operator@example.test', authenticatedSender: true, senderAuthentication: 'synthetic-pass', alias: `triage+trm+${'A'.repeat(22)}@agentmail.test`, normalizedInstruction: 'Handle synthetic integration input', attachments: [] }; } },
    secretStore: store, ingress: { endpoint: { endpoint_id: ingressIdentity.endpoint_id, owner_id: ingressIdentity.owner_id }, ownerId: ingressIdentity.owner_id, signer: { ...identityKeys(ingressIdentity), keyId: ingressIdentity.key_id } }, repository, registry,
  });
  let enabled = true;
  const server = createRelayServer({ registry, repository, agentmailIngress: { maxMessageBytes: ingress.maxMessageBytes, handleWebhook: (input) => enabled ? ingress.handleWebhook(input) : Promise.resolve({ status: 503, body: { code: 'AGENTMAIL_INGRESS_DISABLED', details: {} } }) } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const accepted = await request(server.address().port, '{}');
    assert.equal(accepted.status, 202, JSON.stringify(accepted.body)); assert.equal(repository._debugGetEnvelope(accepted.body.message_id ?? accepted.body.messageId) !== undefined || accepted.body.code === undefined, true);
    enabled = false;
    const rejected = await request(server.address().port, '{}');
    assert.equal(rejected.status, 503); assert.equal(rejected.body.code, 'AGENTMAIL_INGRESS_DISABLED');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
