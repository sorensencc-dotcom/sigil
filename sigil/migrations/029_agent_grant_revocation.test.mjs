// sigil/migrations/029_agent_grant_revocation.test.mjs
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const sql = fs.readFileSync(new URL('./029_agent_grant_revocation.sql', import.meta.url), 'utf8');

test('029 lets a revocation be attributed to an endpoint instead of a human', () => {
  assert.match(sql, /ALTER COLUMN revoked_by DROP NOT NULL/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS revoked_by_endpoint TEXT REFERENCES endpoints\(endpoint_id\)/);
});

test('029 requires every revocation to name a human or an endpoint', () => {
  assert.match(sql, /CHECK \(revoked_by IS NOT NULL OR revoked_by_endpoint IS NOT NULL\)/);
});
