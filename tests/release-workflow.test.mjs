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

// Splits release.yml into its steps and returns each step's `run:` command,
// so a command that only appears in a comment or another field doesn't count.
function stepRunCommands(text) {
  const steps = text.split(/^[ \t]*- name:/m).slice(1);
  return steps.map((step) => step.match(/^[ \t]*run:[ \t]*(.+?)[ \t]*$/m)?.[1] ?? '');
}

test('release workflow builds the web client before the live database gate', () => {
  const runs = stepRunCommands(workflow);
  const buildStep = runs.findIndex((run) => /^npm --prefix packages\/sigil-rooms-web ci && npm --prefix packages\/sigil-rooms-web run build$/.test(run));
  const liveGate = runs.findIndex((run) => run === 'npm run test:live');

  assert.notEqual(liveGate, -1, 'release.yml must run the live database gate');
  assert.notEqual(buildStep, -1, 'release.yml must build packages/sigil-rooms-web in a run step');
  assert.ok(buildStep < liveGate, 'the web build must run before the live database gate');
});
