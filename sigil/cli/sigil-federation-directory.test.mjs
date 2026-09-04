import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../scripts/apply-migrations.mjs';

const execFileAsync = promisify(execFile);
const sigilPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');
const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

// `sigil federation invite` only does anything against a real Postgres
// directory, so the whole file skips without SIGIL_TEST_DATABASE_URL (matches
// sigil-federation-outbox.test.mjs). CI live-DB runs it. SIGIL_DATABASE_URL is
// forced empty so only an explicit --database-url (or its deliberate absence)
// reaches withRepository.
async function run(args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [sigilPath, ...args], {
      cwd,
      env: { ...process.env, SIGIL_DATABASE_URL: '' },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code };
  }
}

// Every run gets an isolated cwd so `.sigil/` (identity + registry) never
// leaks between tests or into the repo -- same pattern as sigil-route-test.test.mjs.
async function makeWorkdir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sigil-federation-directory-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const alice = await run(['init', 'alice', '--domain', 'local'], dir);
  assert.equal(alice.exitCode, 0, alice.stderr);
  const bob = await run(['init', 'bob', '--domain', 'local'], dir);
  assert.equal(bob.exitCode, 0, bob.stderr);
  return dir;
}

test('sigil federation invite create/list/revoke/redeem', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  // Reset + apply through the shared migrator so the `_sigil_schema_migrations`
  // ledger is populated -- withRepository's { migrate: true } re-runs
  // applyMigrations, and an unseeded ledger makes non-idempotent earlier
  // migrations replay against an already-migrated schema (see the outbox test).
  await applyMigrations(connectionString, { reset: true });

  const dir = await makeWorkdir(t);
  const aliceIdentity = '.sigil/alice.identity.json';
  const bobIdentity = '.sigil/bob.identity.json';

  // --- create ---------------------------------------------------------
  const create = await run(
    ['federation', 'invite', 'create', '--peer', 'b.example', '--endpoint', 'ep_alice@local', '--identity', aliceIdentity, '--database-url', connectionString],
    dir,
  );
  assert.equal(create.exitCode, 0, create.stderr);
  // withRepository's { migrate: true } prints its own "Connecting.../Schema up
  // to date" lines ahead of the command's own output (same as every other
  // migrate:true CLI command), so match the two invite-specific lines by
  // pattern rather than assuming they are the only stdout output.
  const lines = create.stdout.trim().split('\n');
  const codeLineIndex = lines.findIndex((l) => /^sigil-fed-invite:local:[0-9a-f-]{36}:[A-Za-z0-9_-]+$/.test(l));
  assert.ok(codeLineIndex !== -1, `expected a parseable sigil-fed-invite line, got: ${create.stdout}`);
  const codeMatch = /^sigil-fed-invite:local:([0-9a-f-]{36}):([A-Za-z0-9_-]+)$/.exec(lines[codeLineIndex]);
  const [, linkRef, segment] = codeMatch;
  assert.equal(lines[codeLineIndex + 1], linkRef);
  assert.equal(lines.length, codeLineIndex + 2, `expected the code line and bare link_ref to be the last two lines, got: ${create.stdout}`);

  // Only sha256(segment) is stored -- never the segment itself.
  const inviteRow = await pool.query('SELECT code_hash, status, peer_domain FROM federation_directory_invites WHERE link_ref = $1', [linkRef]);
  assert.equal(inviteRow.rows.length, 1);
  const expectedHash = crypto.createHash('sha256').update(segment).digest('hex');
  assert.equal(inviteRow.rows[0].code_hash, expectedHash);
  assert.notEqual(inviteRow.rows[0].code_hash, segment);
  assert.equal(inviteRow.rows[0].status, 'pending');
  assert.equal(inviteRow.rows[0].peer_domain, 'b.example');

  // --- create: owner mismatch ------------------------------------------
  const mismatched = await run(
    ['federation', 'invite', 'create', '--peer', 'b.example', '--endpoint', 'ep_bob@local', '--identity', aliceIdentity, '--database-url', connectionString],
    dir,
  );
  assert.equal(mismatched.exitCode, 1);
  assert.match(mismatched.stderr, /must own the endpoint/);

  // --- list -------------------------------------------------------------
  const list = await run(['federation', 'invite', 'list', '--database-url', connectionString], dir);
  assert.equal(list.exitCode, 0, list.stderr);
  assert.match(list.stdout, new RegExp(linkRef));
  assert.match(list.stdout, /b\.example/);
  assert.match(list.stdout, /pending/);
  assert.doesNotMatch(list.stdout, new RegExp(segment));
  assert.doesNotMatch(list.stdout, new RegExp(expectedHash));

  // --- revoke -------------------------------------------------------------
  const revoke = await run(['federation', 'invite', 'revoke', linkRef, '--database-url', connectionString], dir);
  assert.equal(revoke.exitCode, 0, revoke.stderr);
  assert.match(revoke.stdout, new RegExp(`Revoked invite ${linkRef}\\.`));
  const afterRevoke = await pool.query('SELECT status FROM federation_directory_invites WHERE link_ref = $1', [linkRef]);
  assert.equal(afterRevoke.rows[0].status, 'revoked');

  const revokeAgain = await run(['federation', 'invite', 'revoke', linkRef, '--database-url', connectionString], dir);
  assert.equal(revokeAgain.exitCode, 1);
  assert.match(revokeAgain.stderr, /already revoked/);

  // --- redeem: unpinned issuer domain ------------------------------------
  const fakeCode = `sigil-fed-invite:c.example:${crypto.randomUUID()}:${crypto.randomBytes(24).toString('base64url')}`;
  const redeemUnpinned = await run(
    ['federation', 'invite', 'redeem', fakeCode, '--identity', bobIdentity, '--database-url', connectionString],
    dir,
  );
  assert.equal(redeemUnpinned.exitCode, 1);
  assert.match(redeemUnpinned.stderr, /pin the peer relay first/);

  // --- no --database-url: every subcommand throws the documented limitation
  const noDbCreate = await run(
    ['federation', 'invite', 'create', '--peer', 'b.example', '--endpoint', 'ep_alice@local', '--identity', aliceIdentity],
    dir,
  );
  assert.equal(noDbCreate.exitCode, 1);
  assert.match(noDbCreate.stderr, /sigil federation invite create requires --database-url/);

  const noDbList = await run(['federation', 'invite', 'list'], dir);
  assert.equal(noDbList.exitCode, 1);
  assert.match(noDbList.stderr, /sigil federation invite list requires --database-url/);

  const noDbRevoke = await run(['federation', 'invite', 'revoke', linkRef], dir);
  assert.equal(noDbRevoke.exitCode, 1);
  assert.match(noDbRevoke.stderr, /sigil federation invite revoke requires --database-url/);

  const noDbRedeem = await run(['federation', 'invite', 'redeem', fakeCode, '--identity', bobIdentity], dir);
  assert.equal(noDbRedeem.exitCode, 1);
  assert.match(noDbRedeem.stderr, /sigil federation invite redeem requires --database-url/);
});
