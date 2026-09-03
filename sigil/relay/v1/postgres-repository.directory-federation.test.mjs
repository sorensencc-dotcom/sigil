import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('018 applies clean and creates the directory tables + outbox kind column', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await applyMigrations(connectionString, { reset: true });
  await applyMigrations(connectionString); // re-run must be a no-op

  const invites = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'federation_directory_invites'`);
  assert.ok(invites.rows.some((r) => r.column_name === 'link_ref'));
  assert.ok(invites.rows.some((r) => r.column_name === 'code_hash'));

  const links = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'federation_directory_links'`);
  assert.ok(links.rows.some((r) => r.column_name === 'local_confirmed_at'));
  assert.ok(links.rows.some((r) => r.column_name === 'remote_confirmed_at'));

  const outboxKind = await pool.query(`SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'federation_outbox' AND column_name = 'kind'`);
  assert.equal(outboxKind.rows[0].is_nullable, 'NO');
  assert.match(outboxKind.rows[0].column_default, /'envelope'/);

  const envNullable = await pool.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'federation_outbox' AND column_name = 'envelope'`);
  assert.equal(envNullable.rows[0].is_nullable, 'YES');

  await pool.query(`INSERT INTO federation_directory_links
    (id, link_ref, local_owner_id, local_endpoint_id, remote_owner_id, remote_endpoint_id, remote_domain, role, status, peer_domain, created_at, updated_at)
    VALUES (gen_random_uuid(), gen_random_uuid(), 'usr_a@a.example', 'ep_a@a.example', 'usr_b@b.example', 'ep_b@b.example', 'b.example', 'issuer', 'pending', 'b.example', now(), now())`);
  await assert.rejects(
    pool.query(`INSERT INTO federation_directory_links
      (id, link_ref, local_owner_id, local_endpoint_id, remote_owner_id, remote_endpoint_id, remote_domain, role, status, peer_domain, created_at, updated_at)
      VALUES (gen_random_uuid(), gen_random_uuid(), 'usr_a@a.example', 'ep_a2@a.example', 'usr_b@b.example', 'ep_b2@b.example', 'b.example', 'issuer', 'active', 'b.example', now(), now())`),
    /unique|duplicate key/i,
  );
  await pool.query(`DELETE FROM federation_directory_links WHERE local_owner_id = 'usr_a@a.example'`);
});
