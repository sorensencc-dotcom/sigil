import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signedBytes } from './validate-envelope.mjs';
import { enforceCapabilityRiskGate } from './capability-risk-gate.mjs';

function makeEnvelope(capabilities = []) {
  const keys = crypto.generateKeyPairSync('ed25519');
  const envelope = {
    protocol: 'sigil/1', message_id: 'msg_gate_1', conversation_id: 'conv_1', message_type: 'chat.message',
    sender: { endpoint_id: 'ep_codex', owner_id: 'usr_codex' }, recipient: { endpoint_id: 'ep_claude', owner_id: 'usr_claude' },
    body: { text: 'hi' }, context_refs: [], capabilities, idempotency_key: 'idem_1',
    created_at: '2026-08-30T12:00:00Z', expires_at: '2026-08-30T13:00:00Z',
    signature: { algorithm: 'Ed25519', key_id: 'key_codex', value: '' },
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.privateKey).toString('base64url');
  return envelope;
}

function fakeRepo({ registrations = new Map(), approvalDecisions = true } = {}) {
  const consumeCalls = [];
  const registrationCalls = [];
  return {
    consumeCalls,
    registrationCalls,
    async lookupCapabilityRegistration(capability, client) {
      registrationCalls.push({ capability, client });
      return registrations.get(capability) ?? null;
    },
    ...(approvalDecisions ? {
      async consumeApprovalDecision({ endpointId, actionHash, now, client }) {
        consumeCalls.push({ endpointId, actionHash, now, client });
        return { decision_id: 'dec_1', action_hash: actionHash, status: 'consumed' };
      },
    } : {}),
  };
}

test('no capabilities on the envelope: no repository calls, resolves with an empty list', async () => {
  const repository = fakeRepo();
  const result = await enforceCapabilityRiskGate(makeEnvelope([]), repository);
  assert.deepEqual(result, []);
  assert.equal(repository.registrationCalls.length, 0);
});

test('unregistered capability throws CAPABILITY_DENIED', async () => {
  const repository = fakeRepo({ registrations: new Map() });
  const envelope = makeEnvelope(['sigil.task/submit']);
  await assert.rejects(
    () => enforceCapabilityRiskGate(envelope, repository),
    (error) => { assert.equal(error.code, 'CAPABILITY_DENIED'); assert.equal(error.details.capability, 'sigil.task/submit'); return true; },
  );
});

test('standard-risk capability requires no approval decision', async () => {
  const repository = fakeRepo({ registrations: new Map([['sigil.task/submit', { capability: 'sigil.task/submit', risk_tier: 'standard' }]]) });
  const envelope = makeEnvelope(['sigil.task/submit']);
  const result = await enforceCapabilityRiskGate(envelope, repository);
  assert.deepEqual(result, []);
  assert.equal(repository.consumeCalls.length, 0);
});

test('high-risk capability with a consumable approval decision is approved', async () => {
  const repository = fakeRepo({ registrations: new Map([['sigil.approval/request', { capability: 'sigil.approval/request', risk_tier: 'high' }]]) });
  const envelope = makeEnvelope(['sigil.approval/request']);
  const now = new Date('2026-08-30T12:00:30Z');
  const result = await enforceCapabilityRiskGate(envelope, repository, { now, client: { id: 'client-1' } });
  assert.deepEqual(result, ['sigil.approval/request']);
  assert.equal(repository.consumeCalls.length, 1);
  assert.equal(repository.consumeCalls[0].endpointId, 'ep_codex');
  assert.equal(repository.consumeCalls[0].now, now);
  assert.deepEqual(repository.consumeCalls[0].client, { id: 'client-1' });
  assert.equal(repository.consumeCalls[0].actionHash, crypto.createHash('sha256').update(signedBytes(envelope)).digest('hex'));
});

test('high-risk capability with no approval decision throws APPROVAL_REQUIRED', async () => {
  const repository = fakeRepo({ registrations: new Map([['sigil.approval/request', { capability: 'sigil.approval/request', risk_tier: 'high' }]]), approvalDecisions: false });
  const envelope = makeEnvelope(['sigil.approval/request']);
  await assert.rejects(
    () => enforceCapabilityRiskGate(envelope, repository),
    (error) => { assert.equal(error.code, 'APPROVAL_REQUIRED'); assert.deepEqual(error.details.capabilities, ['sigil.approval/request']); return true; },
  );
});

test('repository.consumeApprovalDecision returning null throws APPROVAL_REQUIRED', async () => {
  const repository = fakeRepo({ registrations: new Map([['sigil.approval/request', { capability: 'sigil.approval/request', risk_tier: 'high' }]]) });
  repository.consumeApprovalDecision = async () => null;
  const envelope = makeEnvelope(['sigil.approval/request']);
  await assert.rejects(() => enforceCapabilityRiskGate(envelope, repository), { code: 'APPROVAL_REQUIRED' });
});

test('no client argument: repository methods are called with undefined so their own pool default applies', async () => {
  const repository = fakeRepo({ registrations: new Map([['sigil.task/submit', { capability: 'sigil.task/submit', risk_tier: 'standard' }]]) });
  await enforceCapabilityRiskGate(makeEnvelope(['sigil.task/submit']), repository);
  assert.equal(repository.registrationCalls[0].client, undefined);
});
