import test from 'node:test';
import assert from 'node:assert/strict';

const database = process.env.SIGIL_TEST_DATABASE_URL;

test('multi-worker PostgreSQL control race is reserved for an isolated _test database', { skip: !database ? 'SIGIL_TEST_DATABASE_URL is unset; no live PostgreSQL evidence claimed' : 'requires provisioned PostgreSQL control fixtures and deployment approval' }, async () => {
  assert.match(database, /_test(?:[?]|$)/);
});
