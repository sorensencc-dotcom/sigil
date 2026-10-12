import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const cli = fileURLToPath(new URL('./sigil.mjs', import.meta.url));
const run = promisify(execFile);
const env = { ...process.env, SIGIL_WRAP_KEY_TEST: crypto.randomBytes(32).toString('base64') };
delete env.SIGIL_WRAP_KEY_UNSET;

async function freshPool(t) {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyMigrations(connectionString);
  return pool;
}

test('human add provisions a human, prints ids, and publishes human.provisioned', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  const listener = new pg.Client({ connectionString });
  await listener.connect();
  t.after(() => listener.end());
  const received = new Promise((resolve) => listener.on('notification', (m) => resolve(m.payload)));
  await listener.query('LISTEN sigil_admin');

  const { stdout } = await run(process.execPath, [cli, 'human', 'add', '--name', 'Carol', '--database-url', connectionString, '--room-key-wrap-key', 'SIGIL_WRAP_KEY_TEST'], { env });
  const humanId = /human_id: (hum_[0-9a-f]{32})/.exec(stdout)?.[1];
  const endpointId = /endpoint_id: (ep_[0-9a-f]{32})/.exec(stdout)?.[1];
  assert.ok(humanId && endpointId, stdout);

  const row = (await pool.query('SELECT owner_id, kind, display_name FROM endpoints WHERE endpoint_id = $1', [endpointId])).rows[0];
  assert.deepEqual({ ...row }, { owner_id: humanId, kind: 'human', display_name: 'Carol' });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM human_signing_keys')).rows[0].n, 1);
  const attr = (await pool.query(`SELECT kind, value_or_ciphertext FROM human_attributes WHERE human_id = $1`, [humanId])).rows;
  assert.equal(attr.length, 1);
  assert.equal(attr[0].kind, 'name');
  assert.equal(attr[0].value_or_ciphertext.toString('utf8'), 'Carol');

  const payload = await Promise.race([received, new Promise((_, reject) => setTimeout(() => reject(new Error('no sigil_admin notification')), 5000))]);
  assert.deepEqual(JSON.parse(payload), { type: 'human.provisioned', human_id: humanId, endpoint_id: endpointId, room_ids: [] });
});

test('human add without a wrap key fails and writes nothing', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  await assert.rejects(
    run(process.execPath, [cli, 'human', 'add', '--name', 'Dan', '--database-url', connectionString, '--room-key-wrap-key', 'SIGIL_WRAP_KEY_UNSET'], { env }),
    (error) => /not set/.test(error.stderr),
  );
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM humans')).rows[0].n, 0);
});

test('human add --room is rejected NOT_IMPLEMENTED and writes nothing', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  await assert.rejects(
    run(process.execPath, [cli, 'human', 'add', '--name', 'Eve', '--room', 'room_x:member', '--database-url', connectionString, '--room-key-wrap-key', 'SIGIL_WRAP_KEY_TEST'], { env }),
    (error) => /NOT_IMPLEMENTED/.test(error.stderr),
  );
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM humans')).rows[0].n, 0);
});
