// sigil/migrations/028_room_invocations.test.mjs
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const sql = fs.readFileSync(new URL('./028_room_invocations.sql', import.meta.url), 'utf8');

test('028 adds max_agent_turns with default 6', () => {
  assert.match(sql, /ALTER TABLE rooms ADD COLUMN IF NOT EXISTS max_agent_turns INTEGER NOT NULL DEFAULT 6/);
});

test('028 creates room_invocations with a closed status set and one running row per agent per room', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS room_invocations/);
  for (const status of ['queued', 'running', 'completed', 'failed', 'cancelled', 'refused']) assert.match(sql, new RegExp(`'${status}'`));
  assert.match(sql, /UNIQUE \(trigger_message_id, endpoint_id\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS room_invocations_one_running_idx\s+ON room_invocations \(room_id, endpoint_id\)\s+WHERE status = 'running'/);
});

test('028 creates room_threads keyed by room and thread root', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS room_threads/);
  assert.match(sql, /PRIMARY KEY \(room_id, thread_root_id\)/);
});
