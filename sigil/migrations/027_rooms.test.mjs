import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const sql = fs.readFileSync(new URL('./027_rooms.sql', import.meta.url), 'utf8');

test('027 creates workspaces and rooms keyed to conversations', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS workspaces/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS rooms/);
  assert.match(sql, /conversation_id\s+TEXT PRIMARY KEY REFERENCES conversations\(conversation_id\)/);
  assert.match(sql, /UNIQUE \(workspace_id, name\)/);
  assert.match(sql, /next_room_seq\s+BIGINT NOT NULL DEFAULT 1/);
});

test('027 adds response_mode with a closed value set', () => {
  assert.match(sql, /ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS response_mode TEXT/);
  assert.match(sql, /'joins'/);
  assert.match(sql, /'mentions_only'/);
});

test('027 adds a per-room unique room_seq on envelopes', () => {
  assert.match(sql, /ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS room_seq BIGINT/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS envelopes_room_seq_idx\s+ON envelopes \(conversation_id, room_seq\)\s+WHERE room_seq IS NOT NULL/);
});
