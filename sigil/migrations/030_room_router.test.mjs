import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const sql = fs.readFileSync(new URL('./030_room_router.sql', import.meta.url), 'utf8');

test('030 widens response_mode to include router', () => {
  assert.match(sql, /DROP CONSTRAINT IF EXISTS conversation_members_response_mode_check/);
  assert.match(sql, /response_mode IN \('joins', 'mentions_only', 'router'\)/);
});

// 031_room_router_multi_endpoint.sql drops this index again; this test pins the 030 text only.
test('030 allows at most one router decision per trigger message', () => {
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS room_invocations_one_router_decision_idx/);
  assert.match(sql, /ON room_invocations \(trigger_message_id\)\s+WHERE decided_by = 'router'/);
});
