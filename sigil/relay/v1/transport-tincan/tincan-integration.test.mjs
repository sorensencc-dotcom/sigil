import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTailscaleWhoIs } from './whois-auth.mjs';
import { createWakeDispatcher } from './wake-dispatcher.mjs';
import { dispatchDeliveryWithRetry } from './dispatch-lifecycle.mjs';
import { createHeldQueue } from './held-queue.mjs';
import { enforceCapabilityRiskGate } from '../capability-risk-gate.mjs';

const tailscale = { whois: async () => ({ Node: { Key: 'nodekey:gpu', Name: 'gpu-1' } }) };
const allowlist = new Map([['nodekey:gpu', { permitted_endpoints: ['ep_codex'], allowed_host_roles: ['agent_runner'] }]]);

test('authorized node wakes a sleeping codex bridge and the delivery succeeds', async () => {
  await verifyTailscaleWhoIs({ remoteAddress: '100.64.0.2', targetEndpoint: 'ep_codex' }, allowlist, tailscale);
  const spawned = [];
  const dispatcher = createWakeDispatcher({ checkRunningFn: async () => false, spawnFn: async (command, args) => { spawned.push(args); return { pid: 7 }; } });
  const fails = [];
  const result = await dispatchDeliveryWithRetry({
    delivery: { conversation_id: 'room_1', invocation_id: 'inv_1' },
    wakeFn: async () => { await dispatcher.wakeAgent({ endpointId: 'ep_codex', bridgeType: 'codex', identityPath: 'codex.json', relayUrl: 'http://127.0.0.1:8791' }); return { status: 'DELIVERED' }; },
    failFn: async (...args) => fails.push(args),
  });
  assert.equal(result.status, 'DELIVERED');
  assert.ok(spawned[0].includes('codex'));
  assert.deepEqual(fails, []);
});

test('an unauthorized target never reaches the wake step', async () => {
  await assert.rejects(verifyTailscaleWhoIs({ remoteAddress: '100.64.0.2', targetEndpoint: 'ep_rogue' }, allowlist, tailscale), { code: 'NODE_NOT_AUTHORIZED_FOR_ENDPOINT' });
});

test('the held-queue hash is the exact hash the real risk gate consumes', async () => {
  const envelope = { protocol: 'sigil/1', message_id: 'msg_9', sender: { endpoint_id: 'ep_claude' }, message_type: 'room.message', capabilities: ['fs.write'], body: { text: 'x' }, signature: { value: 's' } };
  const queue = createHeldQueue({ callbackUrl: 'http://127.0.0.1:8795/cb', submitChallengeFn: async () => ({ challenge_id: 'ch_1' }) });
  const { actionHash } = await queue.holdForApproval(envelope, 'tok');
  const consumed = [];
  const repository = {
    lookupCapabilityRegistration: async () => ({ risk_tier: 'high' }),
    consumeApprovalDecision: async ({ endpointId, actionHash: hash }) => { consumed.push({ endpointId, hash }); return hash === actionHash ? { id: 'decision_1' } : null; },
  };
  await enforceCapabilityRiskGate(queue.releaseEnvelope(actionHash), repository, {});
  assert.deepEqual(consumed, [{ endpointId: 'ep_claude', hash: actionHash }]);
});
