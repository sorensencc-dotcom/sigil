// Live-Postgres pin for `sigil endpoint revoke <endpoint_id>`.
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

test('endpoint revoke revokes the endpoint and publishes endpoint.revoked on sigil_admin', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyMigrations(connectionString);
  const spki = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ('usr_r', 'active', NOW())`);
  await pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at) VALUES ('ep_r','usr_r','claude','agent','inst_r','R','active',NOW())`);
  await pool.query(`INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ('key_r','ep_r','Ed25519',$1,'active',NOW())`, [spki]);

  const listener = new pg.Client({ connectionString });
  await listener.connect();
  t.after(() => listener.end());
  const received = new Promise((resolve) => listener.on('notification', (m) => resolve(m.payload)));
  await listener.query('LISTEN sigil_admin');

  await run(process.execPath, [cli, 'endpoint', 'revoke', 'ep_r', '--database-url', connectionString]);

  const payload = await Promise.race([received, new Promise((_, reject) => setTimeout(() => reject(new Error('no sigil_admin notification')), 5000))]);
  assert.deepEqual(JSON.parse(payload), { type: 'endpoint.revoked', endpoint_id: 'ep_r' });
  const row = (await pool.query(`SELECT status FROM endpoints WHERE endpoint_id='ep_r'`)).rows[0];
  assert.equal(row.status, 'revoked');
  const key = (await pool.query(`SELECT status FROM endpoint_keys WHERE key_id='key_r'`)).rows[0];
  assert.equal(key.status, 'retired');
});

test('endpoint revoke on an unknown endpoint exits non-zero', { skip: !connectionString }, async () => {
  await assert.rejects(() => run(process.execPath, [cli, 'endpoint', 'revoke', 'ep_nope', '--database-url', connectionString]), (error) => error.code !== 0 && /not found/i.test(error.stderr));
});
