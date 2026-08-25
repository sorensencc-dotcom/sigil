import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { signedBytes, validateEnvelope } from './validate-envelope.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
const base = { ...fixture, created_at: '2026-08-12T12:00:00.000Z', expires_at: '2026-08-13T00:00:00.000Z' };
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const endpoint = { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey };
base.signature.value = crypto.sign(null, signedBytes(base), privateKey).toString('base64url');
const options = { now: new Date('2026-08-12T12:01:00.000Z'), registered: new Map([['ep_codex', endpoint]]) };

test('accepts a registered, signed task envelope', () => {
  assert.equal(validateEnvelope(base, options).accepted, true);
});

for (const [name, mutate, code] of [
  ['rejects unknown protocol', (x) => { x.protocol = 'sigil/2'; }, 'VERSION_UNSUPPORTED'],
  ['rejects owner mismatch', (x) => { x.sender.owner_id = 'usr_other'; }, 'ROUTE_NOT_AUTHORIZED'],
  ['rejects incomplete signature', (x) => { delete x.signature.value; }, 'INVALID_SIGNATURE'],
  ['rejects forged signature', (x) => { x.body.instruction = 'forged'; }, 'INVALID_SIGNATURE'],
  ['rejects excessive lifetime', (x) => { x.expires_at = '2026-08-14T00:00:00.000Z'; }, 'MESSAGE_EXPIRED'],
  ['rejects recipient and broadcast together', (x) => { x.broadcast_scope = { kind: 'conversation_members' }; }, 'INVALID_ENVELOPE']
]) {
  test(name, () => {
    const candidate = structuredClone(base);
    mutate(candidate);
    if (name !== 'rejects forged signature' && name !== 'rejects incomplete signature') {
      candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
    }
    assert.throws(() => validateEnvelope(candidate, options), (error) => error.code === code);
  });
}

test('rejects conflicting idempotency retry', () => {
  const candidate = structuredClone(base);
  const key = `${candidate.sender.endpoint_id}:${candidate.idempotency_key}`;
  const idempotency = new Map([[key, { canonical_hash: 'different' }]]);
  assert.throws(() => validateEnvelope(candidate, { ...options, idempotency }), (error) => error.code === 'DUPLICATE_MESSAGE');
});

test('accepts a retiring key during grace and rejects it after retirement', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const old = { key_id: 'key_old', public_key: publicKey, status: 'retiring', valid_from: '2026-08-01T00:00:00Z', valid_until: '2026-08-20T00:00:00Z' };
  const candidate = { ...base, created_at: '2026-08-15T00:00:00Z', expires_at: '2026-08-16T00:00:00Z', signature: { ...base.signature, key_id: old.key_id } };
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  const registered = new Map([['ep_codex', { ...endpoint, keys: [old] }]]);
  assert.equal(validateEnvelope(candidate, { ...options, registered, now: new Date('2026-08-15T00:00:00Z') }).accepted, true);
  assert.throws(() => validateEnvelope(candidate, { ...options, registered, now: new Date('2026-08-20T00:00:00Z') }), (error) => error.code === 'INVALID_SIGNATURE');
});

test('requires an authorizer to approve broadcast membership', () => {
  const candidate = { ...base, recipient: undefined, signature: { ...base.signature }, broadcast_scope: { kind: 'conversation_members', conversation_id: base.conversation_id } };
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  assert.throws(() => validateEnvelope(candidate, { ...options, broadcastAuthorizer: () => false }), (error) => error.code === 'ROUTE_NOT_AUTHORIZED');
  assert.equal(validateEnvelope(candidate, { ...options, broadcastAuthorizer: () => true }).accepted, true);
});

test('rejects high-risk delivery without an approved action hash', () => {
  assert.throws(() => validateEnvelope(base, { ...options, requiresApproval: () => true }), (error) => error.code === 'APPROVAL_REQUIRED');
  assert.equal(validateEnvelope(base, { ...options, requiresApproval: () => true, approvedActionHashes: new Set([`sha256:${crypto.createHash('sha256').update(signedBytes(base)).digest('hex')}`]) }).accepted, true);
});

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object') {
    const reversed = {};
    for (const key of Object.keys(value).reverse()) reversed[key] = reverseKeys(value[key]);
    return reversed;
  }
  return value;
}

test('signature verifies across reordered keys and alternate transport encodings (§18 #14)', () => {
  const candidate = structuredClone(base);
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  // Reorder every nesting level's keys, then re-serialize with different
  // whitespace -- simulates a different HTTP client/JSON library re-encoding
  // the same logical envelope in transit.
  const reordered = JSON.parse(JSON.stringify(reverseKeys(candidate), null, 2));
  assert.deepEqual(signedBytes(reordered), signedBytes(candidate));
  assert.equal(validateEnvelope(reordered, options).accepted, true);
});

test('rejects a task.request envelope with an invalid body', () => {
  const candidate = structuredClone(base);
  delete candidate.body.instruction;
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  assert.throws(() => validateEnvelope(candidate, options), (error) => error.code === 'INVALID_ENVELOPE' && error.details?.field === 'instruction');
});

test('rejects a task.result envelope with an invalid status', () => {
  const candidate = { ...base, message_type: 'task.result', body: { task_id: 'task_1', status: 'nope', summary: 'x' } };
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  assert.throws(() => validateEnvelope(candidate, options), (error) => error.code === 'INVALID_ENVELOPE' && error.details?.field === 'status');
});

test('rejects a capability with no covering grant', () => {
  const candidate = structuredClone(base);
  candidate.capabilities = ['sigil.task/submit'];
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  assert.throws(() => validateEnvelope(candidate, { ...options, capabilityGrants: [] }), (error) => error.code === 'CAPABILITY_DENIED');
});

test('accepts a capability covered by an ancestor-scope grant on the conversation', () => {
  const candidate = structuredClone(base);
  candidate.capabilities = ['sigil.task/submit'];
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  const grants = [{ capability: 'sigil.task/submit', scope: `scope:conversation/${candidate.conversation_id}` }];
  assert.equal(validateEnvelope(candidate, { ...options, capabilityGrants: grants }).accepted, true);
});

test('read_shared_context requires coverage for every referenced context scope', () => {
  const candidate = structuredClone(base);
  candidate.capabilities = ['sigil.core/read_shared_context'];
  candidate.context_refs = [{ ref_id: 'ctx_1', scope: 'scope:project/proj_1' }, { ref_id: 'ctx_2', scope: 'scope:project/proj_2' }];
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  const partialGrants = [{ capability: 'sigil.core/read_shared_context', scope: 'scope:project/proj_1' }];
  assert.throws(() => validateEnvelope(candidate, { ...options, capabilityGrants: partialGrants }), (error) => error.code === 'CAPABILITY_DENIED');
  const fullGrants = [{ capability: 'sigil.core/read_shared_context', scope: 'scope:project' }];
  assert.equal(validateEnvelope(candidate, { ...options, capabilityGrants: fullGrants }).accepted, true);
});

test('accepts a federated recipient whose domain matches relayDomain', () => {
  const candidate = structuredClone(base);
  candidate.recipient = { endpoint_id: 'ep_claude@relay.example.com', owner_id: 'usr_claude_owner' };
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  assert.equal(validateEnvelope(candidate, { ...options, relayDomain: 'relay.example.com' }).accepted, true);
});

test('rejects a federated recipient on a different domain with RECIPIENT_NOT_LOCAL', () => {
  const candidate = structuredClone(base);
  candidate.recipient = { endpoint_id: 'ep_claude@other.example.com', owner_id: 'usr_claude_owner' };
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  assert.throws(
    () => validateEnvelope(candidate, { ...options, relayDomain: 'relay.example.com' }),
    (error) => error.code === 'RECIPIENT_NOT_LOCAL' && error.details.recipientDomain === 'other.example.com' && error.details.relayDomain === 'relay.example.com',
  );
});

test('rejects a bare recipient on a domain-configured relay with MALFORMED_FEDERATED_ID', () => {
  const candidate = structuredClone(base);
  candidate.recipient = { endpoint_id: 'ep_claude', owner_id: 'usr_claude_owner' };
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  assert.throws(
    () => validateEnvelope(candidate, { ...options, relayDomain: 'relay.example.com' }),
    (error) => error.code === 'MALFORMED_FEDERATED_ID',
  );
});

test('accepts a bare recipient unchanged when relayDomain is not set (legacy/non-federated relay)', () => {
  const candidate = structuredClone(base);
  candidate.recipient = { endpoint_id: 'ep_claude', owner_id: 'usr_claude_owner' };
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  assert.equal(validateEnvelope(candidate, options).accepted, true);
});
