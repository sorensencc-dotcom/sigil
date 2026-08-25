import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Base64-encoded so this file's own on-disk text never contains a literal
// "import ... from 'lodash'" substring -- the real dep-audit run against
// this repo would otherwise misread the fixture text as a real import.
const LODASH_IMPORT_LINE = Buffer.from('aW1wb3J0IF8gZnJvbSAnbG9kYXNoJzsK', 'base64').toString('utf8');

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const jcsAuditScript = path.join(repoRoot, 'sigil-jcs-audit.mjs');
const depAuditScript = path.join(repoRoot, 'sigil-dep-audit.mjs');

function run(script, targetDir) {
  try {
    execFileSync(process.execPath, [script, targetDir], { encoding: 'utf8', stdio: 'pipe' });
    return 0;
  } catch (error) {
    return error.status;
  }
}

test('sigil-jcs-audit.mjs CLI wrapper exits 0 against this repo (already-conformant target)', () => {
  assert.equal(run(jcsAuditScript, repoRoot), 0);
});

test('sigil-jcs-audit.mjs CLI wrapper exits 1 against a fixture missing the canonicalize pin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-jcs-cli-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: {} }));
    assert.equal(run(jcsAuditScript, dir), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sigil-dep-audit.mjs CLI wrapper exits 0 against this repo (no hoisted dependency gaps)', () => {
  assert.equal(run(depAuditScript, repoRoot), 0);
});

test('sigil-dep-audit.mjs CLI wrapper exits 1 against a fixture with a hoisted dependency gap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-dep-cli-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: {} }));
    fs.writeFileSync(path.join(dir, 'index.mjs'), LODASH_IMPORT_LINE);
    assert.equal(run(depAuditScript, dir), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
