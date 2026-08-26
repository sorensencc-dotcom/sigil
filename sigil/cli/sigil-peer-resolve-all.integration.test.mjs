// sigil/cli/sigil-peer-resolve-all.integration.test.mjs
// Covers what sigil-peer.test.mjs's usage-error-only tests can't: --all's
// core value (per-domain OK/failure lines, continue-past-failure, exit
// code) requires seeded rows and a real subprocess run against them.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import fs from 'node:fs/promises';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';

const execFileAsync = promisify(execFile);
const sigilPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');
const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function run(args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [sigilPath, ...args], { env: { ...process.env, ...env } });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code };
  }
}

test('sigil peer resolve --all skips static peers entirely -- no network call, empty output, exit 0', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const { applyMigrations } = await import('../scripts/apply-migrations.mjs');
  await applyMigrations(connectionString);
  await pool.query(
    `INSERT INTO peer_relays (domain, relay_url, keys, trust_mode) VALUES ($1, $2, $3, 'static'), ($4, $5, $3, 'static')`,
    ['a.example.com', 'https://a.example.com/v1', JSON.stringify([{ kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' }]), 'b.example.com', 'https://b.example.com/v1']
  );
  const { stdout, exitCode } = await run(['peer', 'resolve', '--all'], { SIGIL_DATABASE_URL: connectionString });
  assert.equal(exitCode, 0); // both static -- filtered out before any fetch, empty loop
  // withRepository's { migrate: true } always logs its own "Connecting to
  // PostgreSQL.../Schema up to date" banner regardless of whether resolve
  // --all itself has anything to do, so stdout can't be asserted fully
  // empty -- assert on the absence of any per-domain result line instead,
  // which is what "no network call, empty [per-domain] output" means here.
  assert.doesNotMatch(stdout, /a\.example\.com\t|b\.example\.com\t/);
});

test('sigil peer resolve --all prints a real OK line for a tofu peer that successfully re-resolves', { skip: !connectionString }, async (t) => {
  // Outside-voice finding (/plan-ceo-review, cross-model): the prior version of this
  // test file asserted only the static-peer no-op path -- the actual "<domain>\tOK"
  // success line (the feature's whole point) had zero coverage because it needs a
  // real HTTPS peer to resolve against. A throwaway local http server, with
  // NODE_ENV=test so the http:// (not https://) endpoint passes isValidEndpointUrl
  // per Global Constraints, closes that gap without a live second Sigil relay.
  const http = await import('node:http');
  const KEYS = [{ kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' }];
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ domain: `127.0.0.1:${server.address().port}`, relay: { endpoint: `http://127.0.0.1:${server.address().port}/v1` }, keys: KEYS }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const domain = `127.0.0.1:${server.address().port}`;

  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const { applyMigrations } = await import('../scripts/apply-migrations.mjs');
  await applyMigrations(connectionString);
  await pool.query(
    `INSERT INTO peer_relays (domain, relay_url, keys, trust_mode) VALUES ($1, $2, $3, 'tofu')`,
    [domain, `http://127.0.0.1:${server.address().port}/v1`, JSON.stringify(KEYS)]
  );
  const { stdout, exitCode } = await run(['peer', 'resolve', '--all'], { SIGIL_DATABASE_URL: connectionString, NODE_ENV: 'test' });
  assert.equal(exitCode, 0);
  assert.match(stdout, new RegExp(`${domain.replace('.', '\\.')}\\tOK`));

  // Outside-voice finding OV4: only the pure freshness() formatter had a unit test --
  // nothing asserted cmdPeerGet actually wires it into real output. resolve --all
  // just set lastResolvedAt to now, so `peer get` should show "resolved today".
  const { stdout: getStdout } = await run(['peer', 'get', domain], { SIGIL_DATABASE_URL: connectionString });
  assert.match(getStdout, /\(resolved today\)/);
});

test('sigil peer resolve --all resolves a tofu peer against an unreachable domain and reports failure without aborting', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const { applyMigrations } = await import('../scripts/apply-migrations.mjs');
  await applyMigrations(connectionString);
  // A tofu peer pointed at a domain that will not resolve/respond -- deterministic
  // PEER_DISCOVERY_FAILED without needing a live second relay.
  await pool.query(
    `INSERT INTO peer_relays (domain, relay_url, keys, trust_mode) VALUES ($1, $2, $3, 'tofu')`,
    ['nonexistent.invalid', 'https://nonexistent.invalid/v1', JSON.stringify([{ kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' }])]
  );
  const { stdout, exitCode } = await run(['peer', 'resolve', '--all'], { SIGIL_DATABASE_URL: connectionString });
  assert.equal(exitCode, 1);
  assert.match(stdout, /nonexistent\.invalid\tPEER_DISCOVERY_FAILED \(.+\)/);
  // Regression guard (eng review, this session): the failure line used to print
  // the error code twice -- "PEER_DISCOVERY_FAILED (PEER_DISCOVERY_FAILED)" --
  // because the parenthetical fell back to error.code instead of error.message.
  assert.doesNotMatch(stdout, /PEER_DISCOVERY_FAILED \(PEER_DISCOVERY_FAILED\)/);
});

test('sigil peer resolve --all prints the rotate hint, not a duplicated error code, for a key-mismatch peer', { skip: !connectionString }, async (t) => {
  const http = await import('node:http');
  const KEYS = [{ kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' }];
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ domain: `127.0.0.1:${server.address().port}`, relay: { endpoint: `http://127.0.0.1:${server.address().port}/v1` }, keys: [{ kid: 'k9', alg: 'Ed25519', publicKey: 'pub-9' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const domain = `127.0.0.1:${server.address().port}`;

  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const { applyMigrations } = await import('../scripts/apply-migrations.mjs');
  await applyMigrations(connectionString);
  // Pinned key (k1/pub-1) differs from what the peer now serves (k9/pub-9) -- forces PEER_KEY_MISMATCH.
  await pool.query(
    `INSERT INTO peer_relays (domain, relay_url, keys, trust_mode) VALUES ($1, $2, $3, 'tofu')`,
    [domain, `http://127.0.0.1:${server.address().port}/v1`, JSON.stringify(KEYS)]
  );
  const { stdout, exitCode } = await run(['peer', 'resolve', '--all'], { SIGIL_DATABASE_URL: connectionString, NODE_ENV: 'test' });
  assert.equal(exitCode, 1);
  assert.match(stdout, new RegExp(`${domain.replace('.', '\\.')}\\tPEER_KEY_MISMATCH — run "sigil peer rotate ${domain.replace('.', '\\.')} --confirm"`));
});
