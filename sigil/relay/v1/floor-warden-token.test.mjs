import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReplyTokens } from './floor-warden-token.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('token shorter than 32 characters is rejected', () => {
  assert.throws(() => loadReplyTokens({ FWT: 'short-token' }, 'FWT'), (e) => e.code === 'FLOOR_WARDEN_TOKEN_WEAK' && !e.message.includes('short-token'));
});

test('unset variable names the variable, never a value', () => {
  assert.throws(() => loadReplyTokens({}, 'FWT'), (e) => e.code === 'FLOOR_WARDEN_TOKEN_UNSET' && e.message.includes('FWT'));
  assert.throws(() => loadReplyTokens({ FWT: A }, 'FWT', 'FWT_NEXT'), (e) => e.code === 'FLOOR_WARDEN_TOKEN_UNSET' && e.message.includes('FWT_NEXT') && !e.message.includes(A));
});

test('matches is constant-shape and true only for the exact token', () => {
  const tokens = loadReplyTokens({ FWT: A }, 'FWT');
  assert.equal(tokens.matches(A), true);
  assert.equal(tokens.matches(`${A.slice(0, -1)}x`), false);
  assert.equal(tokens.matches(''), false);
  assert.equal(tokens.matches(`${A}a`), false);
  assert.equal(tokens.matches(undefined), false);
});

test('a second name makes both tokens match', () => {
  const tokens = loadReplyTokens({ FWT: A, FWT2: B }, 'FWT', 'FWT2');
  assert.equal(tokens.matches(A), true);
  assert.equal(tokens.matches(B), true);
  assert.equal(tokens.matches('c'.repeat(40)), false);
});

test('the loaded object keeps no plain token', () => {
  const tokens = loadReplyTokens({ FWT: A }, 'FWT');
  const dump = JSON.stringify(tokens) + JSON.stringify(Object.entries(tokens).map(([k, v]) => [k, typeof v === 'function' ? 'fn' : v]));
  assert.equal(dump.includes(A), false);
  for (const key of Object.keys(tokens)) assert.notEqual(tokens[key], A);
});
