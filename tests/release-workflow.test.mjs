import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('release live database uses the disposable test database name', () => {
  assert.match(workflow, /POSTGRES_DB:\s*sigil_test\b/);
  assert.match(workflow, /SIGIL_TEST_DATABASE_URL:\s*postgres:\/\/sigil:sigil_password@localhost:55432\/sigil_test\b/);
});
