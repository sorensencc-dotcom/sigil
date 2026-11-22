import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// sigil/integration/oauth-login.e2e.test.mjs serves packages/sigil-rooms-web/dist,
// which is gitignored. `npm run test:live` therefore fails on a clean CI checkout
// ("sigil-rooms-web: no build ... Run npm run build first") unless the web client
// is built first in the same job.
test('Linux CI job builds the web client before the live PostgreSQL gate', () => {
  const workflow = fs.readFileSync(new URL('.github/workflows/ci.yml', import.meta.url), 'utf8');
  const linux = workflow.split(/^ {2}test-windows:/m)[0];
  const build = linux.indexOf('packages/sigil-rooms-web run build');
  const live = linux.indexOf('npm run test:live');
  assert.ok(live > -1, 'test-linux no longer runs npm run test:live -- update this test');
  assert.ok(build > -1, 'test-linux never builds packages/sigil-rooms-web');
  assert.ok(build < live, 'web client build must come before npm run test:live');
});

// #202: the 848-schedule relay-jobs checker must run in CI, with its dependencies
// installed in its own package, and its per-scenario counts kept in the job output.
test('CI runs the relay-jobs schedule checker and records its counts', () => {
  const workflow = fs.readFileSync(new URL('.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = workflow.split(/^ {2}relay-jobs-verification:/m)[1];
  assert.ok(job, 'ci.yml has no relay-jobs-verification job');
  assert.match(job, /npm ci --prefix packages\/relay-jobs-verification/);
  assert.match(job, /node packages\/relay-jobs-verification\/check\.mjs \| tee /);
  assert.match(job, /shell: bash/, 'piping to tee needs bash with pipefail so a failing checker fails the job');
  assert.match(job, /GITHUB_STEP_SUMMARY/);
});

test('CI runs the formal TLA+ verification job for ag-ui-approval', () => {
  const workflow = fs.readFileSync(new URL('.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = workflow.split(/^ {2}formal-verification:/m)[1];
  assert.ok(job, 'ci.yml has no formal-verification job');
  assert.match(job, /setup-java/);
  assert.match(job, /tla2tools\.jar/);
  assert.match(job, /node verify\/ag-ui-approval\/check\.mjs/);
});
