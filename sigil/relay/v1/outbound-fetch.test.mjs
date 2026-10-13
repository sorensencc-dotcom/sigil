import test from 'node:test';
import assert from 'node:assert/strict';
import { outboundFetchOptions } from './outbound-fetch.mjs';

test('fresh signal per call, redirect refused', () => {
  const a = outboundFetchOptions();
  const b = outboundFetchOptions();
  assert.equal(a.redirect, 'error');
  assert.notEqual(a.signal, b.signal);
  assert.equal(a.signal.aborted, false);
});
