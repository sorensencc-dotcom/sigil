import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function applyMigrationsThrough(pool, lastMigration) {
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql') && file <= lastMigration)
    .sort();
  for (const file of files) await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
}

test('019 applies clean, is a no-op on re-run, and creates federation_relay_nonces', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await applyMigrations(connectionString, { reset: true });
  await applyMigrations(connectionString); // re-run must be a no-op

  const cols = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'federation_relay_nonces' ORDER BY column_name`,
  );
  assert.deepEqual(cols.rows.map((r) => r.column_name), ['expires_at', 'nonce']);

  await pool.query(`INSERT INTO federation_relay_nonces (nonce, expires_at) VALUES ('n-dup', now() + interval '5 min')`);
  await assert.rejects(
    pool.query(`INSERT INTO federation_relay_nonces (nonce, expires_at) VALUES ('n-dup', now() + interval '5 min')`),
    /duplicate key/i,
  );
});

test('019 relaxes distinct_owners to permit a self_pair row and still rejects an equal-owner non-self_pair row', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await applyMigrations(connectionString, { reset: true });

  // self_pair row with equal owners is accepted
  await pool.query(`INSERT INTO federation_directory_links
    (id, link_ref, local_owner_id, local_endpoint_id, remote_owner_id, remote_endpoint_id,
     remote_domain, role, initiated_via, status, peer_domain, created_at, updated_at)
    VALUES (gen_random_uuid(), gen_random_uuid(), 'usr_x@home.example', 'ep_a@home.example',
            'usr_x@home.example', 'ep_b@home.example', 'a.example', 'issuer', 'self_pair', 'active',
            'a.example', now(), now())`);

  // equal owners without self_pair is still rejected by the CHECK
  await assert.rejects(
    pool.query(`INSERT INTO federation_directory_links
      (id, link_ref, local_owner_id, local_endpoint_id, remote_owner_id, remote_endpoint_id,
       remote_domain, role, initiated_via, status, peer_domain, created_at, updated_at)
      VALUES (gen_random_uuid(), gen_random_uuid(), 'usr_y@home.example', 'ep_a@home.example',
              'usr_y@home.example', 'ep_b@home.example', 'a.example', 'issuer', 'invite', 'active',
              'a.example', now(), now())`),
    /distinct_owners/i,
  );
});

test('019 scrubs the plaintext code from a pre-019 directory_redemption outbox row', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await applyMigrationsThrough(pool, '018_federation_directory.sql');
  // Seed a redemption row carrying the secret, as an earlier build would have.
  const ref = (await pool.query(`SELECT gen_random_uuid() AS u`)).rows[0].u;
  await pool.query(
    `INSERT INTO federation_outbox (id, kind, message_id, idempotency_key, recipient_domain, origin_domain, directory_payload, state, attempt_count, next_attempt_at, created_at, updated_at)
     VALUES (gen_random_uuid(), 'directory_redemption', $1, $1, 'a.example', 'b.example',
             $2::jsonb, 'pending', 0, now(), now(), now())`,
    [ref, JSON.stringify({ link_ref: ref, code: 'sigil-fed-invite:a.example:' + ref + ':SECRETSEG', redeemer: { owner_id: 'usr_b@b.example', endpoint_id: 'ep_c@b.example' } })],
  );
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await pool.query(await fs.readFile(path.join(migrationsDir, '019_federation_directory_security.sql'), 'utf8'));
  const row = await pool.query(`SELECT directory_payload FROM federation_outbox WHERE message_id = $1`, [ref]);
  assert.equal(row.rows[0].directory_payload.code, undefined, 'the code key must be gone');
  assert.equal(row.rows[0].directory_payload.link_ref, ref, 'the rest of the payload is untouched');
});
