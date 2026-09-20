import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSecretReference } from './agentmail-secret-reference.mjs';
import { createSecretResolver } from './agentmail-secret-resolver.mjs';

const reference = parseSecretReference('secret://sigil/agentmail/api-key');

test('resolves through an explicit provider and keeps the value in a closure', async () => {
  const secretValue = 'synthetic-api-key';
  const resolver = createSecretResolver({
    providers: { 'secret://sigil': async () => ({ value: secretValue, version: 'v1' }) },
    clock: () => new Date('2026-09-20T12:00:00Z'),
  });
  const result = await resolver.resolve(reference, { purpose: 'test' });
  assert.equal(result.version, 'v1');
  assert.equal(result.resolvedAt, '2026-09-20T12:00:00.000Z');
  assert.equal(result.secret.reference, reference);
  assert.equal(result.secret.version, 'v1');
  assert.equal(result.secret.fingerprint.length, 64);
  assert.equal(await result.secret.withValue((value) => value), secretValue);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-api-key/);
});

test('rejects unallowlisted providers and redacts provider failures', async () => {
  const resolver = createSecretResolver({ providers: {} });
  await assert.rejects(resolver.resolve(reference), (error) => {
    assert.equal(error.code, 'SECRET_PROVIDER_NOT_ALLOWED');
    assert.doesNotMatch(error.message, /api-key|synthetic/);
    return true;
  });
});

test('single-flights duplicate resolution and validates provider values', async () => {
  let calls = 0;
  const resolver = createSecretResolver({
    providers: { 'secret://sigil': async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { value: 'same', version: 'v2' }; } },
  });
  const [first, second] = await Promise.all([resolver.resolve(reference), resolver.resolve(reference)]);
  assert.equal(calls, 1);
  assert.equal(await first.secret.withValue((value) => value), 'same');
  assert.equal(second.secret.fingerprint, first.secret.fingerprint);
});

test('maps timeouts and missing values to stable secret errors', async () => {
  const resolver = createSecretResolver({
    timeoutMs: 10,
    providers: {
      'secret://sigil': async () => new Promise(() => {}),
    },
  });
  await assert.rejects(resolver.resolve(reference), { code: 'SECRET_UNAVAILABLE' });
  const invalid = createSecretResolver({ providers: { 'secret://sigil': async () => ({ value: '' }) } });
  await assert.rejects(invalid.resolve(reference), { code: 'SECRET_VALUE_INVALID' });
});
