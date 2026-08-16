import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RATE_LIMITS, DEFAULT_INBOX_DEPTH_LIMIT, resolveRateLimits } from './relay-config.mjs';

test('default rate limits match the approved §13 defaults', () => {
  assert.deepEqual(DEFAULT_RATE_LIMITS, { endpoint: 100, owner: 500, conversation: 200 });
  assert.equal(DEFAULT_INBOX_DEPTH_LIMIT, 500);
});

test('resolveRateLimits overrides only the scopes provided, keeping defaults for the rest', () => {
  assert.deepEqual(resolveRateLimits({ endpoint: 10 }), { endpoint: 10, owner: 500, conversation: 200 });
  assert.deepEqual(resolveRateLimits(), DEFAULT_RATE_LIMITS);
});
