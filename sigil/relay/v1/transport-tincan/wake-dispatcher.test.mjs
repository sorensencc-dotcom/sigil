import test from 'node:test';
import assert from 'node:assert/strict';
import { createWakeDispatcher } from './wake-dispatcher.mjs';

test('no spawn when the bridge already runs', async () => {
  const dispatcher = createWakeDispatcher({ checkRunningFn: async () => true, spawnFn: async () => { throw new Error('must not spawn'); } });
  const result = await dispatcher.wakeAgent({ endpointId: 'ep_codex', bridgeType: 'codex', identityPath: 'i.json', relayUrl: 'http://127.0.0.1:8791' });
  assert.deepEqual(result, { alreadyRunning: true, endpointId: 'ep_codex' });
});

test('spawns sigil agent run with the real CLI flags for a sleeping bridge', async () => {
  let call;
  const dispatcher = createWakeDispatcher({ checkRunningFn: async () => false, spawnFn: async (command, args) => { call = { command, args }; return { pid: 42 }; } });
  const result = await dispatcher.wakeAgent({ endpointId: 'ep_codex', bridgeType: 'codex', identityPath: 'i.json', relayUrl: 'http://127.0.0.1:8791', sessionStore: 's.json' });
  assert.equal(call.command, 'node');
  assert.deepEqual(call.args, ['sigil/cli/sigil.mjs', 'agent', 'run', '--identity', 'i.json', '--relay-url', 'http://127.0.0.1:8791', '--room-bridge', 'codex', '--room-sessions', 's.json']);
  assert.deepEqual(result, { alreadyRunning: false, endpointId: 'ep_codex', pid: 42 });
});

test('rejects a bridge type the CLI does not support', async () => {
  const dispatcher = createWakeDispatcher({ checkRunningFn: async () => false, spawnFn: async () => ({ pid: 1 }) });
  await assert.rejects(dispatcher.wakeAgent({ endpointId: 'ep_x', bridgeType: 'grok', identityPath: 'i.json', relayUrl: 'u' }), { code: 'INVALID_REQUEST' });
});
