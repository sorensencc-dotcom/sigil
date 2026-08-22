// sigil/relay/v1/postgres-repository.directory-invites.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('directory invite create/redeem lifecycle', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  const ids = { a: `usr_a_${suffix}`, b: `usr_b_${suffix}`, epA: `ep_a_${suffix}`, epB: `ep_b_${suffix}`, epOther: `ep_other_${suffix}` };
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.a}', 'active', NOW()), ('${ids.b}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.epA}', '${ids.a}', 'claude', 'install_a', 'A', 'active', NOW()),
             ('${ids.epB}', '${ids.b}', 'codex', 'install_b', 'B', 'active', NOW()),
             ('${ids.epOther}', '${ids.a}', 'claude', 'install_other', 'Other', 'active', NOW());
  `);
  const repository = new PostgresRepository({ pool });

  const invite = await repository.createDirectoryInvite({ issuerEndpointId: ids.epA, issuerHumanId: ids.a, homeRelay: 'relay.local', now: new Date('2026-08-21T00:00:00Z') });
  assert.equal(typeof invite.code, 'string');
  assert.equal(typeof invite.invite_id, 'string');

  const redeemed = await repository.redeemDirectoryInvite({ code: invite.code, redeemerEndpointId: ids.epB, redeemerHumanId: ids.b, homeRelay: 'relay.local', now: new Date('2026-08-21T01:00:00Z') });
  assert.equal(typeof redeemed.link_id, 'string');
  assert.equal(redeemed.status, 'pending');

  const link = await pool.query('SELECT * FROM directory_links WHERE link_id = $1', [redeemed.link_id]);
  assert.equal(link.rows[0].b_confirmed_at !== null, true);
  assert.equal(link.rows[0].a_confirmed_at, null);
  assert.equal(link.rows[0].initiated_via, 'invite');

  await assert.rejects(
    () => repository.redeemDirectoryInvite({ code: invite.code, redeemerEndpointId: ids.epB, redeemerHumanId: ids.b, homeRelay: 'relay.local', now: new Date('2026-08-21T02:00:00Z') }),
    { code: 'INVITE_UNAVAILABLE' }
  );

  const secondInvite = await repository.createDirectoryInvite({ issuerEndpointId: ids.epA, issuerHumanId: ids.a, homeRelay: 'relay.local', now: new Date('2026-08-21T00:00:00Z') });
  await assert.rejects(
    () => repository.redeemDirectoryInvite({ code: secondInvite.code, redeemerEndpointId: ids.epOther, redeemerHumanId: ids.a, homeRelay: 'relay.local', now: new Date('2026-08-21T00:30:00Z') }),
    { code: 'INVITE_UNAVAILABLE' }
  );
});
