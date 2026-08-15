import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runSuitesSequentially,
  summarizeResults,
  parseSummary,
  clearLiveTestEnv
} from './live-db-tests.mjs';

test('runSuitesSequentially never launches a second schema-reset suite before the first finishes', async () => {
  const files = ['fixture-a.test.mjs', 'fixture-b.test.mjs', 'fixture-c.test.mjs'];
  let active = 0;
  let maxActive = 0;
  const started = [];
  const finished = [];

  async function fakeRunSuite(file) {
    active += 1;
    maxActive = Math.max(maxActive, active);
    started.push(file);
    // Simulate the real suites' async work (DROP SCHEMA / CREATE SCHEMA,
    // migrations, queries) so a scheduler bug that fires the next suite
    // early has a window in which to actually overlap.
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    finished.push(file);
    return { file, code: 0, summary: { tests: 1, suites: 0, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 } };
  }

  const results = await runSuitesSequentially(files, { runSuite: fakeRunSuite });

  assert.equal(maxActive, 1, 'a second suite started before the first one finished -- schema resets could race');
  assert.deepEqual(started, files, 'suites must start in discovery order');
  assert.deepEqual(finished, files, 'suites must finish in discovery order');
  assert.equal(results.length, files.length);
});

test('runSuitesSequentially runs every suite even when an earlier one fails, so the gate reports the full picture', async () => {
  const files = ['ok-a.test.mjs', 'broken.test.mjs', 'ok-b.test.mjs'];
  const ran = [];

  async function fakeRunSuite(file) {
    ran.push(file);
    const failed = file === 'broken.test.mjs';
    return {
      file,
      code: failed ? 1 : 0,
      summary: { tests: 1, suites: 0, pass: failed ? 0 : 1, fail: failed ? 1 : 0, cancelled: 0, skipped: 0, todo: 0 }
    };
  }

  const results = await runSuitesSequentially(files, { runSuite: fakeRunSuite });

  assert.deepEqual(ran, files, 'a mid-run failure must not short-circuit remaining suites');
  const { totals, failedFiles } = summarizeResults(results);
  assert.equal(totals.tests, 3);
  assert.equal(totals.pass, 2);
  assert.equal(totals.fail, 1);
  assert.equal(failedFiles.length, 1);
  assert.equal(failedFiles[0].file, 'broken.test.mjs');
});

test('parseSummary reads node:test\'s default end-of-run summary block', () => {
  const output = [
    '✔ some test (1.2ms)',
    'ℹ tests 12',
    'ℹ suites 0',
    'ℹ pass 10',
    'ℹ fail 1',
    'ℹ cancelled 0',
    'ℹ skipped 1',
    'ℹ todo 0'
  ].join('\n');

  assert.deepEqual(parseSummary(output), {
    tests: 12, suites: 0, pass: 10, fail: 1, cancelled: 0, skipped: 1, todo: 0
  });
});

test('parseSummary returns all zeros when the summary block is missing', () => {
  assert.deepEqual(parseSummary('no summary here'), {
    tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0
  });
});

test('clearLiveTestEnv removes SIGIL_TEST_DATABASE_URL from the given env object', () => {
  const env = { SIGIL_TEST_DATABASE_URL: 'postgres://example', OTHER: 'kept' };
  clearLiveTestEnv(env);
  assert.equal('SIGIL_TEST_DATABASE_URL' in env, false);
  assert.equal(env.OTHER, 'kept');
});

test('clearLiveTestEnv is a no-op when the variable is already absent', () => {
  const env = { OTHER: 'kept' };
  assert.doesNotThrow(() => clearLiveTestEnv(env));
  assert.deepEqual(env, { OTHER: 'kept' });
});
