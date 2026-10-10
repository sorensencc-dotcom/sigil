import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const sql = fs.readFileSync(new URL('./032_room_task_assignee.sql', import.meta.url), 'utf8');

test('032 lets an invocation record an assignee decision', () => {
  assert.match(sql, /DROP CONSTRAINT IF EXISTS room_invocations_decided_by_check/);
  assert.match(sql, /decided_by IN \('mention', 'router', 'assignee'\)/);
});
