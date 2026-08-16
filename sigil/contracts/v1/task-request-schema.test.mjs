import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskRequestBody } from './task-request-schema.mjs';

test('accepts a minimal valid task.request body', () => {
  assert.doesNotThrow(() => validateTaskRequestBody({ task_id: 'task_1', instruction: 'Do the thing' }));
});

test('accepts optional arrays and ISO deadline', () => {
  assert.doesNotThrow(() => validateTaskRequestBody({ task_id: 'task_1', instruction: 'x', success_criteria: ['a'], dependencies: [], deadline: '2026-08-20T00:00:00Z' }));
});

for (const [name, body] of [
  ['missing task_id', { instruction: 'x' }],
  ['missing instruction', { task_id: 'task_1' }],
  ['empty task_id', { task_id: '', instruction: 'x' }],
  ['empty instruction', { task_id: 'task_1', instruction: '' }],
  ['non-array success_criteria', { task_id: 'task_1', instruction: 'x', success_criteria: 'not-array' }],
  ['non-array dependencies', { task_id: 'task_1', instruction: 'x', dependencies: 'not-array' }],
  ['non-ISO deadline', { task_id: 'task_1', instruction: 'x', deadline: 'not-a-date' }],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => validateTaskRequestBody(body), (error) => error.code === 'INVALID_ENVELOPE');
  });
}
