import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskResultBody } from './task-result-schema.mjs';

test('accepts a minimal valid task.result body', () => {
  assert.doesNotThrow(() => validateTaskResultBody({ task_id: 'task_1', status: 'completed', summary: 'Done.' }));
});

test('accepts every valid status value', () => {
  for (const status of ['accepted', 'in_progress', 'completed', 'blocked', 'rejected', 'expired']) {
    assert.doesNotThrow(() => validateTaskResultBody({ task_id: 'task_1', status, summary: 'x' }));
  }
});

test('accepts optional arrays', () => {
  assert.doesNotThrow(() => validateTaskResultBody({ task_id: 'task_1', status: 'completed', summary: 'x', findings: ['a'], artifacts: [], verification: ['b'] }));
});

for (const [name, body] of [
  ['missing task_id', { status: 'completed', summary: 'x' }],
  ['missing status', { task_id: 'task_1', summary: 'x' }],
  ['missing summary', { task_id: 'task_1', status: 'completed' }],
  ['invalid status', { task_id: 'task_1', status: 'done', summary: 'x' }],
  ['non-array findings', { task_id: 'task_1', status: 'completed', summary: 'x', findings: 'not-array' }],
  ['non-array artifacts', { task_id: 'task_1', status: 'completed', summary: 'x', artifacts: 'not-array' }],
  ['non-array verification', { task_id: 'task_1', status: 'completed', summary: 'x', verification: 'not-array' }],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => validateTaskResultBody(body), (error) => error.code === 'INVALID_ENVELOPE');
  });
}
