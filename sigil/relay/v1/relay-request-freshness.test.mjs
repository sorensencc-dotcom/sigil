import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RELAY_REQUEST_FRESHNESS_MS, resolveRelayRequestFreshnessMs } from './relay-config.mjs';

test('default when unset or invalid', () => {
  assert.equal(DEFAULT_RELAY_REQUEST_FRESHNESS_MS, 300_000);
  assert.equal(resolveRelayRequestFreshnessMs(undefined), 300_000);
  assert.equal(resolveRelayRequestFreshnessMs(null), 300_000);
  assert.equal(resolveRelayRequestFreshnessMs('nope'), 300_000);
  assert.equal(resolveRelayRequestFreshnessMs(Number.NaN), 300_000);
});

test('clamps to [60_000, 3_600_000]', () => {
  assert.equal(resolveRelayRequestFreshnessMs(1_000), 60_000);
  assert.equal(resolveRelayRequestFreshnessMs(10_000_000), 3_600_000);
  assert.equal(resolveRelayRequestFreshnessMs(120_000), 120_000);
});
