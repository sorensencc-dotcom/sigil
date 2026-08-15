import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostAdapter } from './host-adapter.mjs';

test('host adapter exposes only connector-backed operations', async () => {
  const calls = []; const connector = Object.fromEntries(['sendTask', 'checkInbox', 'getResult', 'requestApproval', 'resolveContext'].map((name) => [name, async (...args) => { calls.push([name, ...args]); return name; }]));
  const permissions = ['sigil.task/*', 'sigil.approval/request', 'sigil.core/read_shared_context'];
  const adapter = createHostAdapter({ connector, runtime: 'codex', packagePermissions: permissions, connectorGrants: permissions });
  assert.equal(await adapter.sendTask('task'), 'sendTask'); assert.equal(await adapter.resolveContext('ref'), 'resolveContext');
  assert.deepEqual(calls, [['sendTask', 'task'], ['resolveContext', 'ref']]);
  assert.equal('privateKey' in adapter, false);
});

test('host adapter rejects an incomplete connector contract', () => {
  assert.throws(() => createHostAdapter({ connector: {}, runtime: 'codex' }), /connector\.sendTask is required/);
});

test('host adapter requires package and connector capability intersection', async () => {
  const connector = Object.fromEntries(['sendTask', 'checkInbox', 'getResult', 'requestApproval', 'resolveContext'].map((name) => [name, async () => name]));
  assert.throws(() => createHostAdapter({ connector, runtime: 'codex' }), /CAPABILITY_DENIED|Capability denied/);
  const adapter = createHostAdapter({ connector, runtime: 'codex', packagePermissions: ['sigil.task/*', 'sigil.approval/request', 'sigil.core/read_shared_context'], connectorGrants: ['sigil.task/*', 'sigil.approval/request', 'sigil.core/read_shared_context'] });
  assert.equal(await adapter.sendTask('task'), 'sendTask');
});
