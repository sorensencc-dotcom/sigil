import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, identityKeys } from '../../cli/identity.mjs';
import { createAgentMailLedger } from './agentmail-ledger.mjs';
import { emitIngressReceipt } from './agentmail-receipts.mjs';
import { handleAgentMailWebhook } from './agentmail-adapter.mjs';

test('synthetic triage ingress produces one signed envelope and receipt', async () => {
  const identity = createIdentity({ ownerId: 'usr_operator', endpointId: 'ep_ingress', kind: 'agent' });
  const keys = identityKeys(identity);
  const ledger = createAgentMailLedger();
  const queued = [];
  const input = {
    rawBody: Buffer.from('{"synthetic":true}'),
    headers: { 'x-synthetic-signature': 'valid' },
    inboxId: 'inbox_a',
    provider: { async verifyWebhook() { return { eventId: 'evt_integration', messageId: 'msg_integration', from: 'operator@example.test', authenticatedSender: true, senderAuthentication: 'spf-dkim-pass', alias: `triage+trm+${'I'.repeat(22)}@agentmail.test`, body: 'Synthetic integration request', attachments: [] }; } },
    registry: { inboxMappings: [
      { providerInboxId: 'inbox_a', endpointId: 'ep_triage', workflowPolicy: ['trm'] },
      { providerInboxId: 'inbox_b', endpointId: 'ep_judgment', workflowPolicy: ['review'] },
      { providerInboxId: 'inbox_c', endpointId: 'ep_iron', workflowPolicy: ['test'] },
    ] },
    ingress: { endpoint: { endpoint_id: 'ep_ingress', owner_id: 'usr_operator' }, ownerId: 'usr_operator', signer: { ...keys, keyId: identity.key_id } },
    ledger,
    policy: { senderAllowlist: ['operator@example.test'], forwardingTokens: { 'triage+trm': 'I'.repeat(22) } },
    enqueue: async (envelope) => { queued.push(envelope); },
    clock: () => new Date('2026-09-14T12:00:00Z'),
  };
  const result = await handleAgentMailWebhook(input);
  assert.equal(result.status, 202);
  assert.equal(queued.length, 1);
  const receipt = emitIngressReceipt({ event: { eventId: result.eventId, correlationId: queued[0].correlation_id }, outcome: { state: result.state }, signer: input.ingress.signer, createdAt: '2026-09-14T12:00:01Z' });
  assert.equal(receipt.correlation_id, queued[0].correlation_id);
  assert.equal(receipt.signature.algorithm, 'Ed25519');
});
