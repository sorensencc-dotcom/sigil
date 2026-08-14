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
