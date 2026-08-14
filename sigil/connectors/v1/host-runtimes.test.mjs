import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeHostRuntime, createCodexHostRuntime } from './host-runtimes.mjs';

function fetchImpl() {
  return async (url, options) => ({ ok: true, status: 200, async json() {
    const path = new URL(url).pathname;
    if (path === '/v1/tasks') return { code: 'OK', result: { accepted: true } };
    if (path === '/v1/process') return { code: 'OK', result: { state: 'processed' } };
    return { code: 'OK', result: { items: [], nextSince: '' } };
  } });
}

test('Codex host runtime binds authenticated local connector with Codex-only operations', async () => {
  const runtime = createCodexHostRuntime({ baseUrl: 'http://localhost', token: 'codex-token', fetchImpl: fetchImpl() });
  assert.equal(runtime.runtime, 'codex');
  assert.deepEqual(await runtime.sendTask({ envelope: { message_id: 'm1' } }), { accepted: true });
  assert.equal('processTask' in runtime, false);
});

test('Claude host runtime binds authenticated local connector with Claude-only operations', async () => {
  const runtime = createClaudeHostRuntime({ baseUrl: 'http://localhost', token: 'claude-token', fetchImpl: fetchImpl(), processTask: async (task) => ({ task, status: 'processed' }) });
  assert.equal(runtime.runtime, 'claude');
  assert.deepEqual(await runtime.processTask({ message_id: 'm1' }), { task: { message_id: 'm1' }, status: 'processed' });
  assert.equal('sendTask' in runtime, false);
});

test('Claude host runtime requires a local task processor', () => {
  assert.throws(() => createClaudeHostRuntime({ baseUrl: 'http://localhost', token: 'claude-token', fetchImpl: fetchImpl() }), /processTask is required/);
});
