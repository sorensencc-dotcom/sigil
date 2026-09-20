import test from 'node:test';
import assert from 'node:assert/strict';
import { rotateAgentMailSecrets, createAgentMailControlHandler } from './agentmail-rotation.mjs';

function fakeControl() {
  let version = 1; const calls = []; let leased = false;
  return { calls, repository: { async lookupCapabilityRegistration() { return { risk_tier: 'standard' }; }, async lookupActiveCapabilityGrants() { return [{ capability: 'sigil.agentmail/control_rotate' }]; } }, async acquireLease() { if (leased) throw Object.assign(new Error('lease'), { code: 'CONTROL_LEASE_CONFLICT' }); leased = true; calls.push('lease'); }, async releaseLease() { leased = false; calls.push('release'); }, async transition(input) { calls.push(input.action); version += 1; return { state: input.action === 'resume' ? 'enabled' : input.action === 'drain' ? 'draining' : 'disabled', version }; } };
}
function snapshot(generation) { return { generation, withApiKey: (cb) => cb({ withValue: (fn) => fn('api') }) }; }
const config = { apiKeyRef: { display: 'env://API' }, webhookSecretRefs: {}, forwardingTokenRefs: {} };

test('rotation commits provider cutover before snapshot swap and resume', async () => {
  const control = fakeControl(); const store = { current: () => snapshot('g1'), swap(next) { this.next = next; } };
  const result = await rotateAgentMailSecrets({ control, secretStore: store, resolver: { async resolve() { return { secret: { withValue: (fn) => fn('api') }, version: 'v2' }; } }, config, actor: { endpointId: 'ep_operator' }, expectedControlVersion: 1, requestId: 'req_1', providerRotation: { async rotate() { return { supported: true, committed: true, receipt: { provider: 'synthetic' } }; } } });
  assert.equal(result.control.state, 'enabled');
  assert.deepEqual(control.calls, ['lease', 'drain', 'resume', 'release']);
  assert.equal(store.next.generation.startsWith('gen_'), true);
});

test('unsupported provider leaves control disabled', async () => {
  const control = fakeControl(); const store = { current: () => snapshot('g1'), swap() { throw new Error('should not swap'); } };
  await assert.rejects(rotateAgentMailSecrets({ control, secretStore: store, resolver: { async resolve() { return { secret: { withValue: (fn) => fn('api') }, version: 'v2' }; } }, config, actor: { endpointId: 'ep_operator' }, expectedControlVersion: 1, requestId: 'req_2', providerRotation: { async rotate() { return { supported: false, committed: false, receipt: { outcome: 'unsupported' } }; } } }), { code: 'PROVIDER_ROTATION_UNSUPPORTED' });
  assert.equal(control.calls.includes('emergency_stop'), true);
});

test('control handler accepts no secret-bearing fields', async () => {
  const handler = createAgentMailControlHandler({ control: { transition: async () => ({ state: 'disabled' }) }, authorize: async () => {} });
  await assert.rejects(handler({ action: 'disable', requestId: 'req', secret: 'not-allowed' }, { endpointId: 'ep_operator' }), { code: 'CONTROL_REQUEST_INVALID' });
});
