import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const sql = fs.readFileSync(new URL('./031_room_router_multi_endpoint.sql', import.meta.url), 'utf8');

test('031 drops the one-router-row-per-trigger index so multi-endpoint decisions persist', () => {
  assert.match(sql, /DROP INDEX IF EXISTS room_invocations_one_router_decision_idx;/);
});

test('031 does not recreate any unique index', () => {
  assert.doesNotMatch(sql, /CREATE UNIQUE INDEX/);
});
