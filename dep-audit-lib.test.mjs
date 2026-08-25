import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDepAudit } from './dep-audit-lib.mjs';

// Base64-encoded so this test file's own on-disk text never contains a
// literal "import ... from 'lodash'" substring -- otherwise this repo's
// real dep-audit run (against the whole tree, including this file) would
// misread the fixture text as a real, undeclared import.
const LODASH_IMPORT_LINE = Buffer.from('aW1wb3J0IF8gZnJvbSAnbG9kYXNoJzsK', 'base64').toString('utf8');

function makeFixture({ dependencies = {}, sourceFiles = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-dep-audit-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies }));
  for (const [relPath, content] of Object.entries(sourceFiles)) {
    const filePath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return dir;
}

test('runDepAudit passes with no issues when every import is declared and pinned', () => {
  const dir = makeFixture({
    dependencies: { lodash: '4.17.21' },
    sourceFiles: { 'index.mjs': LODASH_IMPORT_LINE },
  });
  try {
    const result = runDepAudit(dir);
    assert.deepEqual(result, { pass: true, issues: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runDepAudit fails with a HOISTED_DEPENDENCY_GAP error when an imported package is not declared', () => {
  const dir = makeFixture({
    dependencies: {},
    sourceFiles: { 'index.mjs': LODASH_IMPORT_LINE },
  });
  try {
    const result = runDepAudit(dir);
    assert.equal(result.pass, false);
    assert.ok(result.issues.some((issue) => issue.code === 'HOISTED_DEPENDENCY_GAP' && issue.severity === 'error' && issue.message.includes('lodash')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runDepAudit reports an unpinned version as a warning that does not flip pass to false', () => {
  const dir = makeFixture({
    dependencies: { lodash: '^4.17.21' },
    sourceFiles: { 'index.mjs': LODASH_IMPORT_LINE },
  });
  try {
    const result = runDepAudit(dir);
    assert.equal(result.pass, true, 'matches the legacy script: only hoisted gaps flip the exit code');
    assert.ok(result.issues.some((issue) => issue.code === 'UNPINNED_DEPENDENCY' && issue.severity === 'warning'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
