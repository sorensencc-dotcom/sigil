import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createClaudeProcessTask } from './claude-process-adapter.mjs';

function fakeSpawn({ output = '{"status":"processed"}', code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { end(value) { child.input = value; } }; child.kill = () => { child.killed = true; };
  queueMicrotask(() => { if (output) child.stdout.emit('data', output); child.emit('close', code, null); });
  return child;
}

test('Claude process adapter sends one JSON task and parses one JSON result', async () => {
  let command; let args; let child;
  const processTask = createClaudeProcessTask({ command: 'claude-worker', args: ['--stdio'], spawnImpl: (c, a) => { command = c; args = a; child = fakeSpawn(); return child; } });
  assert.deepEqual(await processTask({ message_id: 'm1' }), { status: 'processed' });
  assert.equal(command, 'claude-worker'); assert.deepEqual(args, ['--stdio']); assert.equal(child.input, '{"message_id":"m1"}');
});

test('Claude process adapter fails closed on nonzero exit and invalid JSON', async () => {
  await assert.rejects(createClaudeProcessTask({ command: 'worker', spawnImpl: () => fakeSpawn({ code: 2, output: '' }) })({}), { code: 'PROCESSING_FAILED' });
  await assert.rejects(createClaudeProcessTask({ command: 'worker', spawnImpl: () => fakeSpawn({ output: 'not-json' }) })({}), { code: 'PROCESSING_INVALID_RESULT' });
});

test('Claude process adapter rejects malformed command args', () => {
  assert.throws(() => createClaudeProcessTask({ command: 'worker', args: ['ok', 3] }), /args must be strings/);
});
