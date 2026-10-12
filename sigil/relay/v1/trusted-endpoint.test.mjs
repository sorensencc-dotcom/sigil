import test from 'node:test';
import assert from 'node:assert/strict';
import { keyVerifies, entryFromRegistryRow } from './trusted-endpoint.mjs';

const now = new Date('2026-10-12T12:00:00Z');
const k = (over) => ({ status: 'active', valid_from: '2026-01-01T00:00:00Z', valid_until: null, ...over });

test('active key with null valid_until verifies after valid_from', () => assert.equal(keyVerifies(k({}), now), true));
test('future-dated key is rejected', () => assert.equal(keyVerifies(k({ valid_from: '2027-01-01T00:00:00Z' }), now), false));
test('retiring key verifies only inside its window', () => {
  assert.equal(keyVerifies(k({ status: 'retiring', valid_until: '2026-12-01T00:00:00Z' }), now), true);
  assert.equal(keyVerifies(k({ status: 'retiring', valid_until: '2026-10-01T00:00:00Z' }), now), false);
});
test('retiring key without valid_until never verifies', () => assert.equal(keyVerifies(k({ status: 'retiring' }), now), false));
test('retired key never verifies, even with null valid_until', () => assert.equal(keyVerifies(k({ status: 'retired' }), now), false));
test('unknown status never verifies', () => assert.equal(keyVerifies(k({ status: 'revoked' }), now), false));

test('entryFromRegistryRow normalizes a top-level-key row and defaults kind to human', () => {
  assert.equal(entryFromRegistryRow(null), null);
  const e = entryFromRegistryRow({ endpoint_id: 'ep_a', owner_id: 'usr_a', key_id: 'key_a', public_key: 'PK' });
  assert.equal(e.kind, 'human');
  assert.equal(e.status, 'active');
  assert.equal(e.keys.get('key_a').public_key, 'PK');
  assert.equal(keyVerifies(e.keys.get('key_a'), now), true);
});
