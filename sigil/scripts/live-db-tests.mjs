// Sequential runner for Sigil's live-PostgreSQL test suites.
//
// node's default `node --test` runs test *files* concurrently. Every suite
// that resets the schema (`DROP SCHEMA public CASCADE; CREATE SCHEMA public`)
// races every other one for the same `pg_catalog` rows when run that way —
// verified failure: `duplicate key value violates unique constraint
// "pg_type_typname_nsp_index"`. This runner discovers those suites and runs
// them one at a time in a single child process each, so no two schema resets
// ever overlap. Individual suites are untouched and still run standalone via
// `node --test <file>` exactly as before.
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertDisposableTestDatabase } from './assert-disposable-test-db.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const sigilRoot = path.resolve(here, '..');

const LIVE_SUITE_MARKER = 'process.env.SIGIL_TEST_DATABASE_URL';
const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_POLL_MS = 500;

const EMPTY_SUMMARY = { tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };

// A file counts as a "DB-resetting suite" if it reads SIGIL_TEST_DATABASE_URL
// directly -- that's the same gate the suites themselves use to skip when no
// live database is configured, so it can't drift out of sync with them.
export async function discoverLiveSuites(rootDir = sigilRoot) {
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith('.test.mjs')) continue;
      const contents = await readFile(full, 'utf8');
      if (contents.includes(LIVE_SUITE_MARKER)) found.push(full);
    }
  }
  await walk(rootDir);
  return found.sort();
}

export async function waitForPostgresReady(connectionString, {
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
  pollMs = DEFAULT_READINESS_POLL_MS
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    const pool = new pg.Pool({ connectionString, max: 1 });
    try {
      await pool.query('SELECT 1');
      await pool.end();
      return;
    } catch (err) {
      lastError = err;
      await pool.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  throw new Error(`PostgreSQL not ready after ${timeoutMs}ms: ${lastError?.message ?? 'unknown error'}`);
}

const SUMMARY_LINE = /^ℹ (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/;

// node:test's default reporter always prints this block at the end of a run,
// regardless of which reporter flags are set, so scraping it needs no extra
// `--test-reporter` wiring and can't diverge from what a human sees.
export function parseSummary(output) {
  const summary = { ...EMPTY_SUMMARY };
  for (const rawLine of output.split('\n')) {
    const match = SUMMARY_LINE.exec(rawLine.trim());
    if (match) summary[match[1]] = Number(match[2]);
  }
  return summary;
}

export function defaultRunSuite(file, env) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const child = spawn(process.execPath, ['--test', file], { env, cwd: sigilRoot });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ file, code, summary: parseSummary(stdout) }));
  });
}

// The `for...of` + `await` here is load-bearing: it's what guarantees suite
// N+1 cannot start until suite N's process has exited. Do not replace with
// Promise.all/map -- that's exactly the parallelism this runner exists to
// remove. All suites run (a failure doesn't short-circuit the rest) so the
// final report always reflects the full gate, not a partial one.
export async function runSuitesSequentially(files, { runSuite = defaultRunSuite, env = process.env } = {}) {
  const results = [];
  for (const file of files) {
    results.push(await runSuite(file, env));
  }
  return results;
}

export function summarizeResults(results) {
  const totals = { ...EMPTY_SUMMARY };
  for (const result of results) {
    for (const key of Object.keys(totals)) totals[key] += result.summary?.[key] ?? 0;
  }
  const failedFiles = results.filter((r) => r.code !== 0);
  return { totals, failedFiles };
}

export function clearLiveTestEnv(env = process.env) {
  delete env.SIGIL_TEST_DATABASE_URL;
}

export async function main() {
  const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
  if (!connectionString) {
    console.error('SIGIL_TEST_DATABASE_URL is not set; the live PostgreSQL test gate requires it.');
    process.exitCode = 1;
    return;
  }
  try {
    assertDisposableTestDatabase(connectionString);
    console.log('Waiting for PostgreSQL readiness...');
    await waitForPostgresReady(connectionString);

    const files = await discoverLiveSuites();
    if (files.length === 0) {
      console.error('No live PostgreSQL suites discovered (expected files referencing SIGIL_TEST_DATABASE_URL).');
      process.exitCode = 1;
      return;
    }
    console.log(`Live PostgreSQL test gate: running ${files.length} schema-resetting suite(s) sequentially.`);
    for (const file of files) console.log(`  - ${path.relative(sigilRoot, file)}`);

    const results = await runSuitesSequentially(files, { env: process.env });
    const { totals, failedFiles } = summarizeResults(results);

    console.log('--- Live PostgreSQL test gate summary ---');
    for (const [key, value] of Object.entries(totals)) console.log(`${key}: ${value}`);
    console.log(`files: ${results.length}`);
    console.log(`failed files: ${failedFiles.length}${failedFiles.length ? ' (' + failedFiles.map((r) => path.relative(sigilRoot, r.file)).join(', ') + ')' : ''}`);

    process.exitCode = (failedFiles.length > 0 || totals.fail > 0) ? 1 : 0;
  } finally {
    clearLiveTestEnv(process.env);
  }
}

const isDirectRun = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main();
}
