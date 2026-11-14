import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('release live database uses the disposable test database name', () => {
  const serviceDatabase = workflow.match(/^[ \t]*POSTGRES_DB:[ \t]*(\S+)[ \t]*$/m)?.[1];
  const liveTestDatabase = workflow.match(/^[ \t]*SIGIL_TEST_DATABASE_URL:[ \t]*postgres:\/\/[^/\s]+\/([^\s]+)[ \t]*$/m)?.[1];

  assert.equal(serviceDatabase, 'sigil_test');
  assert.equal(liveTestDatabase, serviceDatabase);
});
