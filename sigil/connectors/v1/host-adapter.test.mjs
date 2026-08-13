import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostAdapter } from './host-adapter.mjs';

test('host adapter exposes only connector-backed operations', async () => {
  const calls = []; const connector = Object.fromEntries(['sendTask', 'checkInbox', 'getResult', 'requestApproval', 'resolveContext'].map((name) => [name, async (...args) => { calls.push([name, ...args]); return name; }]));
  const adapter = createHostAdapter({ connector, runtime: 'codex' });
  assert.equal(await adapter.sendTask('task'), 'sendTask'); assert.equal(await adapter.resolveContext('ref'), 'resolveContext');
  assert.deepEqual(calls, [['sendTask', 'task'], ['resolveContext', 'ref']]);
  assert.equal('privateKey' in adapter, false);
});
