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

test('release workflow builds the web client before the live database gate', () => {
  const buildStep = workflow.indexOf('npm --prefix packages/sigil-rooms-web run build');
  const liveGate = workflow.indexOf('npm run test:live');

  assert.notEqual(buildStep, -1, 'release.yml must build packages/sigil-rooms-web');
  assert.ok(buildStep < liveGate, 'the web build must run before the live database gate');
});
