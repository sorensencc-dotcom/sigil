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

// verify/pre-push-gate models the tiered hook and the CI backstop; check.mjs exits 1/2/3 on a
// new failure, a vanished finding, or missing TLC, so a plain step fails the job on all three.
test('CI runs the pre-push-gate formal model check in the formal-verification job', () => {
  const workflow = fs.readFileSync(new URL('.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = workflow.split(/^ {2}formal-verification:/m)[1];
  assert.ok(job, 'ci.yml has no formal-verification job');
  const agUi = job.indexOf('node verify/ag-ui-approval/check.mjs');
  const gate = job.indexOf('node verify/pre-push-gate/check.mjs');
  assert.ok(gate > -1, 'formal-verification does not run verify/pre-push-gate/check.mjs');
  assert.ok(gate > agUi, 'pre-push-gate check should follow the ag-ui-approval check');
  const step = job.slice(job.lastIndexOf('- name:', gate), gate);
  assert.match(step, /export TLA2TOOLS="\$HOME\/\.tla\/tla2tools\.jar"/);
  assert.doesNotMatch(step, /continue-on-error/);
});

// Branch protection requires the four Linux/Windows matrix checks by name. A job skipped with a
// job-level `if` never reports those names, so the PR would wait forever. Those jobs must always
// run and skip only their steps; jobs that are not required checks may be skipped whole.
// Filter logic: sigil/scripts/ci-changes.mjs, modeled in verify/pre-push-gate (FilterReq).
function jobBlock(workflow, name) {
  const start = workflow.search(new RegExp(`^ {2}${name}:`, 'm'));
  assert.ok(start > -1, `ci.yml has no ${name} job`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^ {2}[\w-]+:\s*$/m);
  return next === -1 ? rest : rest.slice(0, next);
}

test('CI path filter job runs ci-changes.mjs with full history and exposes core and web', () => {
  const workflow = fs.readFileSync(new URL('.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = jobBlock(workflow, 'changes');
  assert.match(job, /fetch-depth: 0/);
  assert.match(job, /node sigil\/scripts\/ci-changes\.mjs/);
  assert.match(job, /CI_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(job, /core: \$\{\{ steps\.filter\.outputs\.core \}\}/);
  assert.match(job, /web: \$\{\{ steps\.filter\.outputs\.web \}\}/);
});

test('required Linux and Windows jobs always run and gate only their steps', () => {
  const workflow = fs.readFileSync(new URL('.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const name of ['test-linux', 'test-windows']) {
    const job = jobBlock(workflow, name);
    assert.match(job, /needs: changes/);
    assert.doesNotMatch(job.split(/^ {4}steps:/m)[0], /^ {4}if:/m, `${name} must not be skipped whole: it is a required check`);
    const steps = job.split(/^ {6}- name: /m).slice(1);
    for (const step of steps) {
      const title = step.split('\n')[0];
      if (/^Checkout repository/.test(title)) continue;
      assert.match(step, /if: needs\.changes\.outputs\.core == 'true'/, `${name}: step "${title}" is not gated on the core filter`);
    }
  }
});

test('jobs that are not required checks are skipped whole by the filter', () => {
  const workflow = fs.readFileSync(new URL('.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(jobBlock(workflow, 'web'), /needs: changes\n {4}if: needs\.changes\.outputs\.web == 'true'/);
  for (const name of ['relay-jobs-verification', 'formal-verification']) {
    assert.match(jobBlock(workflow, name), /needs: changes\n {4}if: needs\.changes\.outputs\.core == 'true'/, name);
  }
  assert.doesNotMatch(jobBlock(workflow, 'secret-scan'), /needs:/, 'secret scan must always run');
});
