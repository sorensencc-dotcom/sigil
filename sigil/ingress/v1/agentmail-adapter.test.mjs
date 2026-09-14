import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, identityKeys } from '../../cli/identity.mjs';
import { handleAgentMailWebhook, resolveWorkflow } from './agentmail-adapter.mjs';

const token = 'T'.repeat(22);
const identity = createIdentity({ ownerId: 'usr_operator', endpointId: 'ep_ingress', kind: 'agent' });
const keys = identityKeys(identity);

function makeInput(overrides = {}) {
  const transitions = [];
  const queued = [];
  const records = new Map();
  const event = {
    eventId: 'evt_1',
    messageId: 'msg_1',
    from: 'operator@example.test',
    authenticatedSender: true,
    senderAuthentication: 'spf-dkim-pass',
    alias: `triage+trm+${token}@agentmail.test`,
    body: 'Review this synthetic report.',
    attachments: [],
    ...overrides.event,
  };
  const input = {
    rawBody: JSON.stringify({ synthetic: true }),
    headers: { 'x-synthetic-signature': 'valid' },
    inboxId: 'inbox_a',
    provider: { async verifyWebhook() { return event; } },
    registry: { inboxMappings: [
      { providerInboxId: 'inbox_a', endpointId: 'ep_triage', workflowPolicy: ['trm'] },
      { providerInboxId: 'inbox_b', endpointId: 'ep_judgment', workflowPolicy: ['review'] },
      { providerInboxId: 'inbox_c', endpointId: 'ep_iron', workflowPolicy: ['internal', 'test'] },
    ] },
    ingress: { endpoint: { endpoint_id: 'ep_ingress', owner_id: 'usr_operator' }, ownerId: 'usr_operator', signer: { ...keys, keyId: identity.key_id } },
    ledger: {
      async recordIngressEvent(record) { records.set(record.eventId, { ...record, state: 'received' }); return records.get(record.eventId); },
      async transitionIngressState(eventId, state) { transitions.push([eventId, state]); records.get(eventId).state = state; return records.get(eventId); },
    },
    policy: {
      senderAllowlist: ['operator@example.test'],
      forwardingTokens: { 'triage+trm': token, 'judgment+review': token },
      allowFinancialLocalOnly: false,
    },
    quarantine: async () => null,
    enqueue: async (envelope) => { queued.push(envelope); return { inserted: true }; },
    clock: () => new Date('2026-09-14T12:00:00Z'),
    ...overrides,
  };
  input.transitions = transitions;
  input.queued = queued;
  input.records = records;
  return input;
}

test('resolveWorkflow accepts explicit allowlisted alias and token', () => {
  const result = resolveWorkflow(`triage+trm+${token}@agentmail.test`, { 'triage+trm': token });
  assert.deepEqual(result, { alias: 'triage+trm', endpointAlias: 'triage', workflow: 'trm' });
  assert.throws(() => resolveWorkflow(`triage+trm+${'X'.repeat(21)}@agentmail.test`, { 'triage+trm': token }), { code: 'INVALID_FORWARDING_TOKEN' });
  assert.throws(() => resolveWorkflow(`triage+roadmap+${token}@agentmail.test`, { 'triage+roadmap': { token, workflow: 'trm' } }), { code: 'TOKEN_MISMATCH' });
});

test('valid webhook routes through ep_ingress and acknowledges after enqueue', async () => {
  const input = makeInput();
  const result = await handleAgentMailWebhook(input);
  assert.equal(result.status, 202);
  assert.equal(result.state, 'dispatched');
  assert.equal(input.queued.length, 1);
  assert.equal(input.queued[0].sender.endpoint_id, 'ep_ingress');
  assert.equal(input.queued[0].recipient.endpoint_id, 'ep_triage');
  assert.equal(input.queued[0].body.provenance.workflow, 'trm');
  assert.equal(input.queued[0].body.instruction.includes(token), false);
  assert.deepEqual(input.transitions.map(([, state]) => state), ['quarantined', 'accepted', 'dispatched']);
});

test('invalid signature, sender, token, and external iron mail fail closed', async () => {
  const invalidSignature = makeInput({ provider: { async verifyWebhook() { const error = new Error('bad'); error.code = 'WEBHOOK_SIGNATURE_INVALID'; throw error; } } });
  assert.equal((await handleAgentMailWebhook(invalidSignature)).body.code, 'WEBHOOK_SIGNATURE_INVALID');
  assert.equal((await handleAgentMailWebhook(makeInput({ event: { from: 'attacker@example.test' } }))).body.code, 'SENDER_NOT_ALLOWLISTED');
  assert.equal((await handleAgentMailWebhook(makeInput({ event: { alias: `triage+trm+${'X'.repeat(22)}@agentmail.test` } }))).body.code, 'TOKEN_MISMATCH');
  const iron = makeInput({ inboxId: 'inbox_c', event: { alias: `iron+test+${token}@agentmail.test`, external: true } });
  assert.equal((await handleAgentMailWebhook(iron)).body.code, 'IRON_EXTERNAL_MAIL_REJECTED');
});

test('judgment mail is durably quarantined and financial mail stays local-only', async () => {
  const judgment = makeInput({ inboxId: 'inbox_b', event: { alias: `judgment+review+${token}@agentmail.test` } });
  const judgmentResult = await handleAgentMailWebhook(judgment);
  assert.equal(judgmentResult.state, 'quarantined');
  assert.equal(judgment.queued.length, 0);

  const financial = makeInput({ event: { body: 'SYNTHETIC FINANCIAL DATA: account number 000000' } });
  const denied = await handleAgentMailWebhook(financial);
  assert.equal(denied.body.code, 'FINANCIAL_APPROVAL_REQUIRED');
  const allowed = makeInput({ event: { body: 'SYNTHETIC FINANCIAL DATA: account number 000000' }, policy: { ...makeInput().policy, allowFinancialLocalOnly: true } });
  const allowedResult = await handleAgentMailWebhook(allowed);
  assert.equal(allowedResult.status, 202);
  assert.equal(allowed.queued[0].body.provenance.classification, 'financial_sensitive');
});

test('provider timeout returns redacted stable response', async () => {
  const input = makeInput({ provider: { async verifyWebhook() { const error = new Error('provider secret'); error.code = 'AGENTMAIL_PROVIDER_TIMEOUT'; throw error; } } });
  const result = await handleAgentMailWebhook(input);
  assert.equal(result.body.code, 'AGENTMAIL_PROVIDER_TIMEOUT');
  assert.equal(result.body.message.includes('provider secret'), false);
});
