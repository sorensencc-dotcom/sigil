import test from 'node:test';
import assert from 'node:assert/strict';
import { mayInvoke } from './invoke-policy.mjs';

test('owner mode: only the agent owner', () => {
  assert.equal(mayInvoke('h1', { owner_id: 'h1', invokable_by: 'owner' }), true);
  assert.equal(mayInvoke('h2', { owner_id: 'h1', invokable_by: 'owner' }), false);
});
test('members mode: any human', () => assert.equal(mayInvoke('h2', { owner_id: 'h1', invokable_by: 'members' }), true));
test('missing subject or unknown mode denies', () => {
  assert.equal(mayInvoke(null, { owner_id: 'h1', invokable_by: 'members' }), false);
  assert.equal(mayInvoke('h1', { owner_id: 'h1', invokable_by: 'everyone' }), false);
});
