// Regression: applyMigrations must log only the fixed text 'Connecting to PostgreSQL...'
// and never any part of the connection string or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyMigrations } from './apply-migrations.mjs';

const METHODS = ['log', 'info', 'warn', 'error'];

async function captureOutput(uri) {
  const lines = [];
  const originals = {};
  for (const m of METHODS) {
    originals[m] = console[m];
    console[m] = (...args) => { lines.push(args.map(String).join(' ')); };
  }
  try {
    await applyMigrations(uri);
  } catch {
    // expected: connection refused on closed port
  } finally {
    for (const m of METHODS) console[m] = originals[m];
  }
  return lines;
}

test('migration connection diagnostic contains no URI or credential material', { timeout: 15000 }, async () => {
  const first = await captureOutput(
    'postgres://SENTINEL_USER:SENTINEL_PASS@127.0.0.1:1/SENTINEL_DB?sslmode=disable&password=SENTINEL_QUERY_PASS&user=SENTINEL_QUERY_USER',
  );
  assert.ok(first.includes('Connecting to PostgreSQL...'), 'expected fixed connection line');
  const joined = first.join('\n');
  for (const secret of ['SENTINEL_USER', 'SENTINEL_PASS', 'SENTINEL_DB', 'SENTINEL_QUERY_PASS', 'SENTINEL_QUERY_USER', '127.0.0.1:1', 'postgres://']) {
    assert.ok(!joined.includes(secret), 'output leaked connection material');
  }

  const second = (await captureOutput('postgresql://u%40x:p%3Aw%40SENTINEL2@127.0.0.1:1/db')).join('\n');
  for (const secret of ['SENTINEL2', 'p%3Aw', 'u%40x']) {
    assert.ok(!second.includes(secret), 'output leaked encoded credential material');
  }
});

test('migration connection diagnostic is fixed text in source', async () => {
  const src = await readFile(new URL('./apply-migrations.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("console.log('Connecting to PostgreSQL...');"), 'expected fixed log statement in source');
  assert.doesNotMatch(src, /console\.(log|info|warn|error)\([^\n]*connectionString/);
});
