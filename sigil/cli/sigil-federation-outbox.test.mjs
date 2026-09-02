import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../scripts/apply-migrations.mjs';

const execFileAsync = promisify(execFile);
const sigilPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');
const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

// R16 live-DB pin: `sigil federation outbox` only does anything against a real
// Postgres outbox, so the whole file skips without SIGIL_TEST_DATABASE_URL
// (matches accept-federated-envelope.pg.test.mjs). CI live-DB runs it.
async function run(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [sigilPath, ...args], {
      env: { ...process.env, SIGIL_DATABASE_URL: '' },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code };
  }
}

test('sigil federation outbox list|show|retry against a seeded federation_outbox', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  // Reset + apply through the shared migrator so the `_sigil_schema_migrations`
  // ledger is populated. The CLI paths under test call
  // `withRepository(..., { migrate: true })`, which re-runs `applyMigrations`;
  // an unseeded ledger makes it replay non-idempotent migrations (e.g. `014`'s
  // bare `ADD COLUMN client_id`) against an already-migrated schema and the CLI
  // exits non-zero.
  await applyMigrations(connectionString, { reset: true });

  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const rejectedId = crypto.randomUUID();
  const expiredId = crypto.randomUUID();
  const senderKey = { kid: `key_${suffix}`, alg: 'Ed25519', publicKey: 'AAAA' };
  const liveEnvelope = { message_id: `msg_live_${suffix}`, body: { text: 'SECRET-BODY' }, expires_at: '2999-01-01T00:00:00.000Z' };
  const expiredEnvelope = { message_id: `msg_exp_${suffix}`, body: { text: 'SECRET-BODY' }, expires_at: '2000-01-01T00:00:00.000Z' };

  const insert = `INSERT INTO federation_outbox
    (id, message_id, idempotency_key, recipient_domain, origin_domain, envelope, sender_key, sender_owner_id, state, last_reason_code)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
  await pool.query(insert, [rejectedId, liveEnvelope.message_id, `idem_r_${suffix}`, 'b.example', 'a.example', liveEnvelope, senderKey, `usr_${suffix}@a.example`, 'forward_rejected', 'PEER_4XX']);
  await pool.query(insert, [expiredId, expiredEnvelope.message_id, `idem_e_${suffix}`, 'b.example', 'a.example', expiredEnvelope, senderKey, `usr_${suffix}@a.example`, 'dead_letter', 'MAX_ATTEMPTS']);

  // list: counts line + the row id, no envelope body
  const list = await run(['federation', 'outbox', 'list', '--database-url', connectionString]);
  assert.equal(list.exitCode, 0, list.stderr);
  assert.match(list.stdout, /forward_rejected=1/);
  assert.match(list.stdout, /dead_letter=1/);
  assert.match(list.stdout, new RegExp(rejectedId));
  // the metadata columns actually render their seeded values, not just the id
  assert.match(list.stdout, /b\.example/); // recipient_domain
  assert.match(list.stdout, /PEER_4XX/); // last_reason_code
  assert.doesNotMatch(list.stdout, /SECRET-BODY/);
  assert.doesNotMatch(list.stdout, /"text"/);

  // show: one row's metadata, no envelope body
  const show = await run(['federation', 'outbox', 'show', rejectedId, '--database-url', connectionString]);
  assert.equal(show.exitCode, 0, show.stderr);
  assert.match(show.stdout, new RegExp(rejectedId));
  assert.match(show.stdout, /forward_rejected/);
  assert.doesNotMatch(show.stdout, /SECRET-BODY/);
  assert.doesNotMatch(show.stdout, /senderKey/);

  // retry: a forward_rejected row is re-queued to pending
  const retry = await run(['federation', 'outbox', 'retry', rejectedId, '--database-url', connectionString]);
  assert.equal(retry.exitCode, 0, retry.stderr);
  assert.match(retry.stdout, new RegExp(`Re-queued ${rejectedId}`));
  const after = await pool.query('SELECT state FROM federation_outbox WHERE id = $1', [rejectedId]);
  assert.equal(after.rows[0].state, 'pending');

  // retry: an expired dead_letter row is refused with the resend message, non-zero exit
  const expiredRetry = await run(['federation', 'outbox', 'retry', expiredId, '--database-url', connectionString]);
  assert.equal(expiredRetry.exitCode, 1);
  assert.match(expiredRetry.stderr, /the stored envelope has expired — have the sender resend\./);

  // R18: a row not in forward_rejected/dead_letter (now pending) is not retryable
  const notRetryable = await run(['federation', 'outbox', 'retry', rejectedId, '--database-url', connectionString]);
  assert.equal(notRetryable.exitCode, 1);
  assert.match(notRetryable.stderr, /not in a retryable state \(only forward_rejected \/ dead_letter rows can be re-queued\)\./);

  // retry: an unknown id is likewise not retryable (bare { retried: false })
  const unknown = await run(['federation', 'outbox', 'retry', crypto.randomUUID(), '--database-url', connectionString]);
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.stderr, /not in a retryable state/);

  // bad subcommand prints usage and exits non-zero
  const bad = await run(['federation', 'outbox', 'bogus', '--database-url', connectionString]);
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /usage: sigil federation outbox/);
});
