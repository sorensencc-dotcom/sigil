import test from 'node:test';
import assert from 'node:assert/strict';
import { isAncestorScope } from './scope.mjs';

test('a scope is its own ancestor', () => {
  assert.equal(isAncestorScope('scope:project/proj_123', 'scope:project/proj_123'), true);
});

test('a parent scope is an ancestor of its child', () => {
  assert.equal(isAncestorScope('scope:project/proj_123', 'scope:project/proj_123/thread/thread_456'), true);
});

test('segment-exact matching rejects a string-prefix false positive', () => {
  // scope:project/proj_123 must NOT match scope:project/proj_1234 --
  // segments must match exactly, not as string prefixes (design §7).
  assert.equal(isAncestorScope('scope:project/proj_123', 'scope:project/proj_1234'), false);
});

test('a child scope is not an ancestor of its parent', () => {
  assert.equal(isAncestorScope('scope:project/proj_123/thread/thread_456', 'scope:project/proj_123'), false);
});

test('unrelated scopes are not ancestors', () => {
  assert.equal(isAncestorScope('scope:project/proj_123', 'scope:project/proj_999'), false);
});

test('rejects non-string inputs', () => {
  assert.equal(isAncestorScope(null, 'scope:project/proj_123'), false);
  assert.equal(isAncestorScope('scope:project/proj_123', undefined), false);
});
