import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentMailProviderRotationPort, createAgentMailProviderRotationPort } from './agentmail-provider-rotation.mjs';

test('default provider port refuses unsupported deployment rotation', async () => {
  const result = await new AgentMailProviderRotationPort().rotate({ target: 'api_key' });
  assert.deepEqual(result, { supported: false, committed: false, receipt: { outcome: 'unsupported' } });
});

test('provider port delegates one redacted operation', async () => {
  const port = createAgentMailProviderRotationPort({ rotate: async ({ target }) => ({ supported: true, committed: true, receipt: { target, version: 'v2' } }) });
  assert.deepEqual(await port.rotate({ target: 'api_key', currentSnapshot: {}, candidateSnapshot: {} }), { supported: true, committed: true, receipt: { target: 'api_key', version: 'v2' } });
});
