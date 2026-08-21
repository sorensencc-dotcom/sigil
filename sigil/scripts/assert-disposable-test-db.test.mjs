import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDisposableTestDatabase } from './assert-disposable-test-db.mjs';

test('accepts a database name ending in _test', () => {
  assert.doesNotThrow(() => assertDisposableTestDatabase('postgres://sigil:pw@127.0.0.1:55432/sigil_test'));
});

test('refuses the dev/relay database by name', () => {
  assert.throws(
    () => assertDisposableTestDatabase('postgres://sigil:pw@127.0.0.1:55432/sigil'),
    /does not look disposable/
  );
});

test('refuses when no connection string is given', () => {
  assert.throws(() => assertDisposableTestDatabase(''), /connectionString is required/);
  assert.throws(() => assertDisposableTestDatabase(undefined), /connectionString is required/);
});

test('refuses an unparseable connection string', () => {
  assert.throws(() => assertDisposableTestDatabase('not-a-url'), /could not parse connection string/);
});
