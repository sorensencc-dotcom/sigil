import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const RUNBOOK_PATH = fileURLToPath(new URL('../../docs/phase7-setup-runbook.md', import.meta.url));

test('docs/phase7-setup-runbook.md includes all required Phase 7 sections and live smoke notice', () => {
  const text = fs.readFileSync(RUNBOOK_PATH, 'utf8');
  for (const heading of [
    '## Dry-run',
    '## Apply confirmation',
    '## Partial-state recovery',
    '## Secret storage',
    '## One-link priority',
  ]) {
    assert.match(text, new RegExp(`^${heading}$`, 'm'), `missing heading: ${heading}`);
  }
  assert.match(text, /live (?:Grok )?smoke run is separate/i);
  assert.match(text, /icacls .*\/inheritance:r/);
  assert.match(text, /--domain rewritelabs\.io/);
});
