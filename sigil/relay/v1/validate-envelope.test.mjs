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
