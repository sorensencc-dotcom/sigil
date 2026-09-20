import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, identityKeys } from '../../cli/identity.mjs';
import { handleAgentMailWebhook, resolveWorkflow } from './agentmail-adapter.mjs';
import { createAgentMailLedger } from './agentmail-ledger.mjs';

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
    normalizedInstruction: 'Review this synthetic report.',
    attachments: [],
    ...overrides.event,
  };
  const input = {
    rawBody: JSON.stringify({ synthetic: true }),
    headers: { 'x-synthetic-signature': 'valid' },
    inboxId: 'inbox_a',
    provider: { async verifyWebhook() { return event; } },
    registry: { inboxMappings: [
      { providerInboxId: 'inbox_a', endpointId: 'ep_triage', webhookSecretId: 'wh_triage', workflowPolicy: ['trm'] },
      { providerInboxId: 'inbox_b', endpointId: 'ep_judgment', webhookSecretId: 'wh_judgment', workflowPolicy: ['review'] },
      { providerInboxId: 'inbox_c', endpointId: 'ep_iron', webhookSecretId: 'wh_iron', workflowPolicy: ['internal', 'test'] },
    ] },
    secretStore: { current: () => ({
      withWebhookSecret: (_id, callback) => callback({ withValue: (fn) => fn('synthetic-webhook-secret') }),
      withForwardingToken: (_alias, callback) => callback({ withValue: (fn) => fn(token) }),
    }) },
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
  assert.equal(result.receipt?.correlation_id, 'corr_evt_1');
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

  const ledger = createAgentMailLedger();
  const durableJudgment = makeInput({
    inboxId: 'inbox_b',
    event: { alias: `judgment+review+${token}@agentmail.test`, eventId: 'evt_durable_judgment', messageId: 'msg_durable_judgment' },
    ledger,
  });
  const durableResult = await handleAgentMailWebhook(durableJudgment);
  assert.equal(durableResult.state, 'quarantined');
  assert.equal(durableResult.body?.code, undefined);

  const financial = makeInput({ event: { body: 'SYNTHETIC FINANCIAL DATA: account number 000000' } });
  const denied = await handleAgentMailWebhook(financial);
  assert.equal(denied.body.code, 'FINANCIAL_APPROVAL_REQUIRED');
  const notLocal = makeInput({ event: { body: 'SYNTHETIC FINANCIAL DATA: account number 000000' }, policy: { ...makeInput().policy, allowFinancialLocalOnly: true } });
  assert.equal((await handleAgentMailWebhook(notLocal)).body.code, 'FINANCIAL_LOCAL_ROUTE_REQUIRED');
  assert.deepEqual(notLocal.transitions, [['evt_1', 'quarantined'], ['evt_1', 'rejected']]);
  const allowed = makeInput({ event: { body: 'SYNTHETIC FINANCIAL DATA: account number 000000' }, policy: { ...makeInput().policy, allowFinancialLocalOnly: true, localOnlyEndpointIds: ['ep_triage'] } });
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

test('raw body is never used as a trusted task instruction', async () => {
  const input = makeInput({ event: { normalizedInstruction: undefined, sanitizedInstruction: undefined, normalizedText: undefined } });
  const result = await handleAgentMailWebhook(input);
  assert.equal(result.body.code, 'INSTRUCTION_NORMALIZATION_REQUIRED');
  assert.equal(input.queued.length, 0);
});

test('forwarding addresses require one configured domain', () => {
  assert.throws(() => resolveWorkflow(`triage+trm+${token}@agentmail.test@attacker.test`, { 'triage+trm': token }), { code: 'INVALID_FORWARDING_TOKEN' });
  assert.throws(() => resolveWorkflow(`triage+trm+${token}@attacker.test`, { 'triage+trm': token }, { domain: 'agentmail.test' }), { code: 'INVALID_FORWARDING_TOKEN' });
});

test('sender rate limits and inactive endpoint registry fail closed', async () => {
  const limited = makeInput({ senderRateLimiter: async () => false });
  assert.equal((await handleAgentMailWebhook(limited)).body.code, 'SENDER_RATE_LIMITED');
  const inactive = makeInput({ registry: { ...makeInput().registry, endpoints: new Map([['ep_triage', { status: 'paused' }]]) } });
  assert.equal((await handleAgentMailWebhook(inactive)).body.code, 'ENDPOINT_UNAVAILABLE');
});

test('provider verification is bounded by parser timeout', async () => {
  const input = makeInput({ maxParserSeconds: 1, provider: { async verifyWebhook() { return new Promise(() => {}); } } });
  const result = await handleAgentMailWebhook(input);
  assert.equal(result.body.code, 'AGENTMAIL_PROVIDER_TIMEOUT');
});

test('webhook and forwarding verification use one request-captured snapshot', async () => {
  let active = 'old';
  const snapshots = {
    old: { withWebhookSecret: (_id, callback) => callback({ withValue: (fn) => fn('webhook-old') }), withForwardingToken: (_alias, callback) => callback({ withValue: (fn) => fn(token) }) },
    new: { withWebhookSecret: (_id, callback) => callback({ withValue: (fn) => fn('webhook-new') }), withForwardingToken: (_alias, callback) => callback({ withValue: (fn) => fn('N'.repeat(22)) }) },
  };
  const input = makeInput({
    secretStore: { current: () => snapshots[active] },
    provider: { async verifyWebhook(args) { assert.equal(args.webhookSecret, 'webhook-old'); active = 'new'; return makeInput().provider.verifyWebhook(); } },
  });
  const result = await handleAgentMailWebhook(input);
  assert.equal(result.status, 202);
  assert.equal(input.queued.length, 1);
});

test('financial attachments receive short retention before approval or rejection', async () => {
  const retention = [];
  const input = makeInput({
    event: { body: 'SYNTHETIC FINANCIAL DATA', attachments: [{ content: 'synthetic attachment', mediaType: 'text/plain' }] },
    policy: { ...makeInput().policy },
    quarantine: Object.assign(async () => ({ reference: 'quarantine://synthetic/financial', sha256: 'a'.repeat(64), mediaType: 'text/plain', byteLength: 19 }), {
      async setRetention(reference, options) { retention.push({ reference, ...options }); },
    }),
  });
  const result = await handleAgentMailWebhook(input);
  assert.equal(result.body.code, 'FINANCIAL_APPROVAL_REQUIRED');
  assert.deepEqual(retention, [{ reference: 'quarantine://synthetic/financial', retentionClass: 'short' }]);
});
