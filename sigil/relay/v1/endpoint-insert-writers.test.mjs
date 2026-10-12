import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sigilRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) yield full;
  }
}

test('every non-test INSERT INTO endpoints names the kind column', () => {
  const found = [];
  for (const file of walk(sigilRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/INSERT INTO endpoints\s*\(([^)]*)\)/g)) {
      found.push({ file: path.relative(sigilRoot, file), columns: match[1].split(',').map((c) => c.trim()) });
    }
  }
  assert.ok(found.length >= 4, `expected at least 4 writers, found ${found.length}`);
  for (const { file, columns } of found) assert.ok(columns.includes('kind'), `${file} INSERT INTO endpoints lacks kind: ${columns.join(',')}`);
});
