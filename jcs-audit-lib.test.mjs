import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runJcsAudit } from './jcs-audit-lib.mjs';

function makeCleanFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-jcs-audit-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { canonicalize: '2.0.0' } }));
  fs.mkdirSync(path.join(dir, 'sigil', 'relay', 'v1'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sigil', 'contracts', 'v1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sigil', 'relay', 'v1', 'jcs.mjs'), 'export function canonicalJson(v) { return JSON.stringify(v); }\n');
  fs.writeFileSync(path.join(dir, 'sigil', 'relay', 'v1', 'jcs.test.mjs'), '// test\n');
  fs.writeFileSync(
    path.join(dir, 'sigil', 'contracts', 'v1', 'envelope.example.json'),
    JSON.stringify({ signature: { value: 'base64url:REPLACE_IN_TEST_FIXTURE' } })
  );
  return dir;
}

test('runJcsAudit reports pass: true and no issues for a conformant fixture tree', () => {
  const dir = makeCleanFixture();
  try {
    const result = runJcsAudit(dir);
    assert.deepEqual(result, { pass: true, issues: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runJcsAudit reports pass: false with an UNPINNED_DEPENDENCY issue when canonicalize is not pinned to 2.0.0', () => {
  const dir = makeCleanFixture();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { canonicalize: '^2.0.0' } }));
    const result = runJcsAudit(dir);
    assert.equal(result.pass, false);
    assert.ok(result.issues.some((issue) => issue.code === 'UNPINNED_DEPENDENCY' && issue.severity === 'error'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
