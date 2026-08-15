import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_HASH_ALGORITHM, canonicalAction, computeActionHash } from './action-hash.mjs';

const action = { action_type: 'tool.invoke', target: 'calendar:event-1', context_refs: ['ctx-1'], requested_capabilities: ['calendar/read'], arguments: { month: 8 }, endpoint_id: 'ep_codex', contract_version: 'sigil.connector/v1', policy_version: 'p1', ignored: 'not-bound' };

test('action hash canonicalization is key-order independent and excludes unbound fields', () => {
  const reordered = { policy_version: 'p1', contract_version: 'sigil.connector/v1', endpoint_id: 'ep_codex', arguments: { month: 8 }, requested_capabilities: ['calendar/read'], context_refs: ['ctx-1'], target: 'calendar:event-1', action_type: 'tool.invoke', ignored: 'changed' };
  assert.equal(canonicalAction(action), canonicalAction(reordered));
  assert.equal(computeActionHash(action), computeActionHash(reordered));
  assert.match(computeActionHash(action), new RegExp(`^${ACTION_HASH_ALGORITHM}:`));
});

test('action hash changes for target, capability, endpoint, or version changes', () => {
  for (const change of [{ target: 'calendar:event-2' }, { requested_capabilities: ['calendar/write'] }, { endpoint_id: 'ep_claude' }, { contract_version: 'sigil.connector/v2' }]) {
    assert.notEqual(computeActionHash(action), computeActionHash({ ...action, ...change }));
  }
});

test('action hash rejects missing binding and unsupported values', () => {
  assert.throws(() => computeActionHash({ ...action, endpoint_id: undefined }), /Action binding fields are required/);
  assert.throws(() => computeActionHash({ ...action, arguments: { value: undefined } }), /unsupported value/);
});
