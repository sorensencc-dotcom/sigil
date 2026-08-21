import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { signedBytes } from './validate-envelope.mjs';
import { acceptEnvelope, acceptEnvelopeAsync } from './accept-envelope.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const envelope = { ...fixture, created_at: '2026-08-12T12:00:00.000Z', expires_at: '2026-08-13T00:00:00.000Z' };
envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
const options = { now: new Date('2026-08-12T12:01:00Z'), request_id: 'req_1', registered: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]) };

test('accepts and persists valid envelope', () => {
  const writes = [];
  const response = acceptEnvelope(envelope, { ...options, persist: (row) => writes.push(row) });
  assert.equal(response.status, 202);
  assert.equal(writes.length, 1);
  assert.equal(response.body.code, 'ACCEPTED');
});

test('rejected envelope never persists', () => {
  const writes = [];
  const invalid = structuredClone(envelope);
  invalid.signature.value = 'ZmFrZQ';
  const response = acceptEnvelope(invalid, { ...options, persist: (row) => writes.push(row) });
  assert.equal(response.status, 401);
  assert.equal(response.body.code, 'INVALID_SIGNATURE');
  assert.equal(writes.length, 0);
});

test('malformed envelope returns structured error before idempotency lookup', async () => {
  const result = await acceptEnvelopeAsync({}, { lookupIdempotency: async () => null });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'INVALID_ENVELOPE');
});

test('invalid signature is rejected before idempotency lookup', async () => {
  let lookedUp = false;
  const invalid = { ...envelope, signature: { ...envelope.signature, value: 'forged' } };
  const result = await acceptEnvelopeAsync(invalid, { ...options, lookupIdempotency: async () => { lookedUp = true; return null; } });
  assert.equal(result.body.code, 'INVALID_SIGNATURE');
  assert.equal(lookedUp, false);
});

test('same idempotency key returns original acceptance without a second write', () => {
  const writes = [];
  const canonical_hash = crypto.createHash('sha256').update(signedBytes(envelope)).digest('hex');
  const idempotency = new Map([['ep_codex:send_01JEXAMPLE', { message_id: envelope.message_id, canonical_hash }]]);
  const response = acceptEnvelope(envelope, { ...options, idempotency, persist: (row) => writes.push(row) });
  assert.equal(response.status, 202);
  assert.equal(response.body.duplicate, true);
  assert.equal(writes.length, 0);
});

test('async acceptance awaits durable persistence and uses repository idempotency lookup', async () => {
  const events = [];
  const response = await acceptEnvelopeAsync(envelope, {
    ...options,
    lookupIdempotency: async () => null,
    persist: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); events.push('persisted'); }
  });
  assert.equal(response.status, 202);
  assert.deepEqual(events, ['persisted']);

  const duplicate = await acceptEnvelopeAsync(envelope, {
    ...options,
    lookupIdempotency: async () => ({ message_id: 'msg_existing', canonical_hash: crypto.createHash('sha256').update(signedBytes(envelope)).digest('hex') }),
    persist: () => { throw new Error('must not persist duplicate'); }
  });
  assert.equal(duplicate.body.message_id, 'msg_existing');
  assert.equal(duplicate.body.duplicate, true);
});

test('a race detected by the persistence layer itself overrides the optimistic result', async () => {
  const response = await acceptEnvelopeAsync(envelope, {
    ...options,
    lookupIdempotency: async () => null,
    persist: async () => ({ message_id: 'msg_won_the_race', duplicate: true })
  });
  assert.equal(response.body.message_id, 'msg_won_the_race');
  assert.equal(response.body.duplicate, true);
});

function fakeTransactionalRepository({ taskRequests = new Map(), envelopes = new Map() } = {}) {
  const calls = [];
  return {
    calls,
    async withTransaction(fn) { calls.push('BEGIN'); const result = await fn({ id: 'client-1' }); calls.push('COMMIT'); return result; },
    async lookupTaskRequest(taskId, conversationId, client) { calls.push({ op: 'lookupTaskRequest', taskId, conversationId, client }); return taskRequests.get(`${conversationId}:${taskId}`) ?? null; },
    async lookupIdempotency() { return null; },
    async lookupAcceptedMessageId() { return null; },
    async lookupCapabilityRegistration(capability) { return { capability, namespace: capability.split('/')[0], risk_tier: 'standard' }; },
    async lookupActiveCapabilityGrants() { return []; },
    async reserveRateLimit() { return { count: 1, allowed: true }; },
    async countOpenDeliveries() { return 0; },
    async persistAcceptedEnvelope(row) { envelopes.set(row.envelope.message_id, row); return { message_id: row.envelope.message_id, duplicate: false }; },
  };
}

function makeEnvelope({ keys, messageType, body, conversationId = 'conv_1' }) {
  const envelope = {
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: conversationId,
    message_type: messageType, sender: { endpoint_id: 'ep_claude', owner_id: 'usr_claude' }, recipient: { endpoint_id: 'ep_codex', owner_id: 'usr_codex' },
    body, context_refs: [], capabilities: [], correlation_id: null, idempotency_key: `send_${crypto.randomUUID()}`,
    created_at: '2026-08-16T12:00:00Z', expires_at: '2026-08-16T13:00:00Z',
    signature: { algorithm: 'Ed25519', key_id: 'key_claude', value: '' }
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.privateKey).toString('base64url');
  return envelope;
}

test('task.result referencing an unaccepted task_id is rejected with INVALID_ENVELOPE', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'task.result', body: { task_id: 'task_never_sent', status: 'completed', summary: 'x' } });
  const repository = fakeTransactionalRepository();
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'INVALID_ENVELOPE');
  assert.equal(result.body.details.field, 'task_id');
  assert.equal(result.body.details.reason, 'no visible task.request');
});

test('task.result referencing an accepted task_id in the same conversation is accepted', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'task.result', body: { task_id: 'task_1', status: 'completed', summary: 'x' } });
  const repository = fakeTransactionalRepository({ taskRequests: new Map([['conv_1:task_1', { message_id: 'msg_original' }]]) });
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.equal(result.status, 202);
  assert.equal(repository.calls.some((call) => call === 'BEGIN'), true);
  assert.equal(repository.calls.some((call) => call === 'COMMIT'), true);
});

test('non-task envelopes skip the cross-reference lookup entirely', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'chat.message', body: { text: 'hi' } });
  const repository = fakeTransactionalRepository();
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.equal(result.status, 202);
  assert.equal(repository.calls.some((call) => call?.op === 'lookupTaskRequest'), false);
});

function fakeTransactionalRepositoryWithMessages({ messageIds = new Map(), envelopes = new Map() } = {}) {
  const base = fakeTransactionalRepository({ envelopes });
  return {
    ...base,
    async lookupAcceptedMessageId(senderEndpointId, messageId) { return messageIds.get(`${senderEndpointId}:${messageId}`) ?? null; },
  };
}

test('replay: same message_id previously accepted, resubmitted under a different idempotency_key -> REPLAY_DETECTED', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'chat.message', body: { text: 'hi' } });
  const repository = fakeTransactionalRepositoryWithMessages({ messageIds: new Map([[`ep_claude:${envelope.message_id}`, { message_id: envelope.message_id, idempotency_key: 'a-different-key' }]]) });
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'REPLAY_DETECTED');
});

test('replay: same message_id + same idempotency_key is an ordinary duplicate, not a replay', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'chat.message', body: { text: 'hi' } });
  const repository = fakeTransactionalRepositoryWithMessages({ messageIds: new Map([[`ep_claude:${envelope.message_id}`, { message_id: envelope.message_id, idempotency_key: envelope.idempotency_key }]]) });
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.notEqual(result.body.code, 'REPLAY_DETECTED');
});

test('conflicting idempotency key with different body hash throws DUPLICATE_MESSAGE', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'chat.message', body: { text: 'hi' } });
  const repository = {
    ...fakeTransactionalRepositoryWithMessages(),
    async lookupIdempotency() {
      return { message_id: 'msg_other', canonical_hash: 'different_body_hash_00000' };
    }
  };
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'DUPLICATE_MESSAGE');
});

test('first-time expired message with no prior accepted record -> MESSAGE_EXPIRED, not REPLAY_DETECTED', async () => {
  // NOTE: deviates from the brief's literal timestamps. validateEnvelope
  // (untouched by this task) has no "now > expires_at" real-time expiry
  // check -- its only MESSAGE_EXPIRED path is the invalid-lifetime check
  // (expires_at <= created_at). The brief's original timestamps (created_at
  // 12h before now) trip the clock-skew check first (created must be within
  // 5 minutes of now), producing INVALID_ENVELOPE, not MESSAGE_EXPIRED. Kept
  // created_at within clock-skew tolerance and used expires_at <= created_at
  // to reach the real MESSAGE_EXPIRED path, preserving the test's intent:
  // no prior accepted record -> falls through to validateEnvelope's own
  // error, not misclassified as REPLAY_DETECTED.
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'chat.message', body: { text: 'hi' } });
  envelope.created_at = '2026-08-16T11:58:00Z';
  envelope.expires_at = '2026-08-16T11:58:00Z';
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.privateKey).toString('base64url');
  const repository = fakeTransactionalRepositoryWithMessages();
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:00:00Z') });
  assert.equal(result.status, 422);
  assert.equal(result.body.code, 'MESSAGE_EXPIRED');
});

test('exceeding the per-endpoint rate limit rejects with RATE_LIMITED and does not persist', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'chat.message', body: { text: 'hi' } });
  const repository = { ...fakeTransactionalRepositoryWithMessages(), async reserveRateLimit() { return { count: 101, allowed: false }; } };
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.equal(result.status, 429);
  assert.equal(result.body.code, 'RATE_LIMITED');
});

test('exceeding recipient inbox depth rejects with QUOTA_EXCEEDED and does not persist', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'chat.message', body: { text: 'hi' } });
  const repository = { ...fakeTransactionalRepositoryWithMessages(), async reserveRateLimit() { return { count: 1, allowed: true }; }, async countOpenDeliveries() { return 500; } };
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.equal(result.status, 429);
  assert.equal(result.body.code, 'QUOTA_EXCEEDED');
});

test('a CAPABILITY_DENIED rejection triggers a best-effort rejection audit', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'chat.message', body: { text: 'hi' } });
  envelope.capabilities = ['sigil.task/submit'];
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.privateKey).toString('base64url');
  const auditCalls = [];
  const repository = { ...fakeTransactionalRepositoryWithMessages(), async lookupCapabilityRegistration() { return null; }, async recordAuditEvent(event) { auditCalls.push(event); return { event_id: 'audit_1' }; } };
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.equal(result.status, 403);
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].eventType, 'envelope.rejected.capability_denied');
});
