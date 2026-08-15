import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeAdapter, createCodexAdapter } from './runtime-adapters.mjs';

function fakeConnector() {
  const calls = [];
  const connector = new Proxy({}, { get(_target, name) {
    if (name === 'calls') return calls;
    return async (...args) => { calls.push([name, ...args]); return name; };
  }});
  return connector;
}

const permissions = ['sigil.task/*', 'sigil.approval/request', 'sigil.core/read_shared_context'];

test('Codex adapter exposes only Codex connector operations with fixed identity', async () => {
  const connector = fakeConnector();
  const adapter = createCodexAdapter({ connector, packagePermissions: permissions, connectorGrants: permissions });
  assert.equal(adapter.runtime, 'codex');
  assert.equal(await adapter.sendTask({ task_id: 't1' }), 'sendTask');
  assert.equal(await adapter.checkInbox(), 'checkInbox');
  assert.equal('processTask' in adapter, false);
  assert.equal('privateKey' in adapter, false);
  assert.equal('relayClient' in adapter, false);
});

test('Claude adapter exposes processing/result operations but cannot send as Codex', async () => {
  const connector = fakeConnector();
  const adapter = createClaudeAdapter({ connector, packagePermissions: permissions, connectorGrants: permissions });
  assert.equal(adapter.runtime, 'claude');
  assert.equal(await adapter.processTask({ message_id: 'm1' }), 'processTask');
  assert.equal(await adapter.submitResult({ task_id: 't1', status: 'processed' }), 'submitResult');
  assert.equal('sendTask' in adapter, false);
});

test('runtime factories reject missing connector operations', () => {
  assert.throws(() => createCodexAdapter({ connector: { sendTask() {} } }), /connector\.checkInbox is required/);
  assert.throws(() => createClaudeAdapter({ connector: { checkInbox() {} } }), /connector\.getResult is required/);
});
