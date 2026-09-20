import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentMailSecretSnapshot, createAgentMailSecretStore } from './agentmail-secret-snapshot.mjs';

const config = {
  apiKeyRef: { display: 'env://API_KEY' },
  webhookSecretRefs: { triage: { display: 'env://WEBHOOK_TRIAGE' } },
  forwardingTokenRefs: { 'triage+trm': { display: 'env://TOKEN_TRIAGE' } },
};
function resolver(values) { return { async resolve(reference) { const value = values[reference.display]; if (!value) throw Object.assign(new Error('missing'), { code: 'SECRET_UNAVAILABLE' }); return { secret: { withValue: (callback) => callback(value) }, version: `v-${value}`, resolvedAt: 'now' }; } }; }

test('builds an all-or-nothing immutable composite snapshot', async () => {
  const snapshot = await buildAgentMailSecretSnapshot({ config, resolver: resolver({ 'env://API_KEY': 'api-v1', 'env://WEBHOOK_TRIAGE': 'wh-v1', 'env://TOKEN_TRIAGE': 'token-v1' }), generation: 'g1', clock: () => new Date('2026-09-20T12:00:00Z') });
  assert.equal(snapshot.generation, 'g1');
  assert.equal(snapshot.loadedAt, '2026-09-20T12:00:00.000Z');
  assert.equal(await snapshot.withApiKey((secret) => secret.withValue((value) => value)), 'api-v1');
  assert.equal(await snapshot.withWebhookSecret('triage', (secret) => secret.withValue((value) => value)), 'wh-v1');
  assert.equal(await snapshot.withForwardingToken('triage+trm', (secret) => secret.withValue((value) => value)), 'token-v1');
  assert.equal(snapshot.references.get('apiKey').display, 'env://API_KEY');
  assert.equal(Object.isFrozen(snapshot), true);
});

test('does not publish a partial snapshot when one reference is missing', async () => {
  await assert.rejects(buildAgentMailSecretSnapshot({ config, resolver: resolver({ 'env://API_KEY': 'api-v1' }) }), { code: 'SECRET_UNAVAILABLE' });
});

test('swaps by expected generation and bounds previous-generation retention', async () => {
  let now = new Date('2026-09-20T12:00:00Z');
  const make = (generation) => ({ generation, withApiKey: (callback) => callback({ withValue: (fn) => fn(generation) }) });
  const store = createAgentMailSecretStore(make('g1'), { overlapMs: 1000, maxPreviousGenerations: 1, clock: () => now });
  store.swap(make('g2'), { expectedGeneration: 'g1' });
  assert.throws(() => store.swap(make('g3'), { expectedGeneration: 'g1' }), { code: 'SECRET_ROTATION_CONFLICT' });
  store.swap(make('g3'), { expectedGeneration: 'g2' });
  assert.equal(store.activeSnapshots().length, 2);
  now = new Date(now.getTime() + 1001);
  assert.equal(store.retireExpired(), 0);
  assert.equal(store.activeSnapshots().length, 1);
});
