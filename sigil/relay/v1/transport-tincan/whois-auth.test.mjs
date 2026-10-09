import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTailscaleWhoIs } from './whois-auth.mjs';

const node = { Node: { Key: 'nodekey:abc', Name: 'gpu-1' }, UserProfile: { LoginName: 'soren@tailnet' } };
const allowlist = new Map([['nodekey:abc', { permitted_endpoints: ['ep_codex'], allowed_host_roles: ['agent_runner'] }]]);
const tailscale = (value) => ({ whois: async () => value });

test('unknown address fails closed', async () => {
  await assert.rejects(verifyTailscaleWhoIs({ remoteAddress: '100.64.0.1' }, allowlist, tailscale(null)), { code: 'UNAUTHORIZED_NODE' });
});

test('tailnet node missing from the allowlist is refused', async () => {
  await assert.rejects(verifyTailscaleWhoIs({ remoteAddress: '100.64.0.1' }, new Map(), tailscale(node)), { code: 'NODE_NOT_IN_ALLOWLIST' });
});

test('sender endpoint outside permitted_endpoints is refused', async () => {
  await assert.rejects(verifyTailscaleWhoIs({ remoteAddress: '100.64.0.1', senderEndpoint: 'ep_rogue' }, allowlist, tailscale(node)), { code: 'NODE_NOT_AUTHORIZED_FOR_ENDPOINT' });
});

test('target endpoint outside permitted_endpoints is refused before wake', async () => {
  await assert.rejects(verifyTailscaleWhoIs({ remoteAddress: '100.64.0.1', targetEndpoint: 'ep_other' }, allowlist, tailscale(node)), { code: 'NODE_NOT_AUTHORIZED_FOR_ENDPOINT' });
});

test('authorized sender and target pass', async () => {
  const result = await verifyTailscaleWhoIs({ remoteAddress: '100.64.0.1', senderEndpoint: 'ep_codex', targetEndpoint: 'ep_codex' }, allowlist, tailscale(node));
  assert.deepEqual(result, { nodeKey: 'nodekey:abc', machineName: 'gpu-1', loginName: 'soren@tailnet', allowedRoles: ['agent_runner'] });
});
