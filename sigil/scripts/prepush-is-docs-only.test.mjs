import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDocsOnlyFile,
  isDocsOnlyFileList,
  changedFilesForPush,
  shouldSkipTestSuite,
} from './prepush-is-docs-only.mjs';

const ZERO = '0'.repeat(40);
const MAIN = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

test('docs/ paths and any .md file are docs-only; other paths are not', () => {
  assert.equal(isDocsOnlyFile('docs/superpowers/competition/weekly.md'), true);
  assert.equal(isDocsOnlyFile('docs/README'), true);
  assert.equal(isDocsOnlyFile('README.md'), true);
  assert.equal(isDocsOnlyFile('sigil/scripts/install-git-hooks.mjs'), false);
  assert.equal(isDocsOnlyFile('packages/sigil-rooms-web/README.md'), true);
  assert.equal(isDocsOnlyFile('docs.md.bak'), false);
});

test('a file list is docs-only only when it is non-empty and every path qualifies', () => {
  assert.equal(isDocsOnlyFileList([]), false);
  assert.equal(isDocsOnlyFileList(['docs/a.md']), true);
  assert.equal(isDocsOnlyFileList(['README.md', 'docs/guide.txt']), true);
  assert.equal(isDocsOnlyFileList(['docs/a.md', 'sigil/cli.mjs']), false);
});

test('a new branch compared to origin/main is docs-only when every changed file qualifies', () => {
  const stdin = `refs/heads/docs/weekly ${HEAD} refs/heads/docs/weekly ${ZERO}\n`;
  const diffs = { [`${MAIN} ${HEAD}`]: 'docs/superpowers/competition/weekly.md\nREADME.md\n' };
  const git = (_cmd, args) => {
    assert.equal(args[0], 'diff');
    return diffs[`${args[2]} ${args[3]}`] ?? '';
  };
  const mergeBase = () => MAIN;
  assert.equal(shouldSkipTestSuite(stdin, { git, mergeBase }), true);
});

test('an existing-branch push with a non-docs file does not skip the suite', () => {
  const stdin = `refs/heads/feat ${HEAD} refs/heads/feat ${MAIN}\n`;
  const git = (_cmd, args) => {
    if (args[0] === 'diff') return 'docs/a.md\nsigil/scripts/prepush-preflight.mjs\n';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  assert.equal(shouldSkipTestSuite(stdin, { git }), false);
});

test('an existing-branch push of only markdown skips the suite', () => {
  const stdin = `refs/heads/docs/weekly ${HEAD} refs/heads/docs/weekly ${MAIN}\n`;
  const git = (_cmd, args) => {
    if (args[0] === 'diff') return 'docs/superpowers/competition/weekly.md\n';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  assert.equal(shouldSkipTestSuite(stdin, { git }), true);
});

test('a missing merge-base on a new branch does not skip the suite', () => {
  const stdin = `refs/heads/docs/weekly ${HEAD} refs/heads/docs/weekly ${ZERO}\n`;
  assert.equal(shouldSkipTestSuite(stdin, { git() { throw new Error('no git'); }, mergeBase: () => '' }), false);
});

test('empty hook stdin does not skip the suite', () => {
  assert.equal(shouldSkipTestSuite('', { git() { throw new Error('no git'); } }), false);
});

test('a delete-only ref line is ignored; no files means the suite still runs', () => {
  const stdin = `refs/heads/gone ${ZERO} refs/heads/gone ${MAIN}\n`;
  assert.equal(shouldSkipTestSuite(stdin, { git() { throw new Error('no git'); } }), false);
});

test('changedFilesForPush returns null when a git diff fails', () => {
  const stdin = `refs/heads/feat ${HEAD} refs/heads/feat ${MAIN}\n`;
  assert.equal(changedFilesForPush(stdin, { git() { throw new Error('boom'); } }), null);
  assert.equal(shouldSkipTestSuite(stdin, { git() { throw new Error('boom'); } }), false);
});
