import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeAgentMailControl, CAPABILITIES } from './agentmail-control-policy.mjs';

function repository(granted = true, highRisk = false) { return {
  async lookupCapabilityRegistration(capability) { return { capability, risk_tier: highRisk ? 'high' : 'standard' }; },
  async lookupActiveCapabilityGrants() { return granted ? [{ capability: CAPABILITIES.rotate }] : []; },
}; }

test('authorizes only an existing explicit grant', async () => {
  const result = await authorizeAgentMailControl({ repository: repository(), actor: { endpointId: 'ep_operator' }, action: 'rotate', request: { approvalDecision: { approved: true } } });
  assert.equal(result.allowed, true);
  await assert.rejects(authorizeAgentMailControl({ repository: repository(false), actor: { endpointId: 'ep_operator' }, action: 'rotate' }), { code: 'CONTROL_AUTHORIZATION_REQUIRED' });
});

test('requires approval for high-risk control actions', async () => {
  await assert.rejects(authorizeAgentMailControl({ repository: repository(true, true), actor: { endpointId: 'ep_operator' }, action: 'rotate' }), { code: 'CONTROL_APPROVAL_REQUIRED' });
  const result = await authorizeAgentMailControl({ repository: repository(true, true), actor: { endpointId: 'ep_operator' }, action: 'rotate', request: { approvalDecision: { approved: true } } });
  assert.equal(result.capability, CAPABILITIES.rotate);
});
