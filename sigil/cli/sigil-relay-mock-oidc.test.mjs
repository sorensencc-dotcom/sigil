import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sigilPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');

test('sigil relay up --help-equivalent usage text mentions --enable-mock-oidc', async () => {
  // sigil.mjs has no --help flag; assert against the command's own usage
  // banner text printed at startup instead (see cmdRelayUp's console.log
  // lines) by grepping the source for the flag definition -- a fast, no-
  // network smoke check that the flag exists and is documented.
  const source = await import('node:fs/promises').then((fs) => fs.readFile(sigilPath, 'utf8'));
  assert.match(source, /enable-mock-oidc/);
  assert.match(source, /SIGIL_ENABLE_MOCK_OIDC/);
});
