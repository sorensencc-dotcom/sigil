import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function endpoint(pool, id, owner, kind = 'human') {
  await pool.query(
    `INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at)
     VALUES ($1, $2, 'web', $3, $4, $1, 'active', NOW())`, [id, owner, kind, `install_${id}`]);
}

test('postgres contacts: CRUD, owner isolation, case-insensitive duplicates, endpoint resolution', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  for (const h of ['usr_a', 'usr_b', 'usr_c']) await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [h]);
  await endpoint(pool, 'ep_a', 'usr_a');
  await endpoint(pool, 'ep_b1', 'usr_b');
  await endpoint(pool, 'ep_b2', 'usr_b', 'agent');
  await endpoint(pool, 'ep_c', 'usr_c');
  const repo = new PostgresRepository({ pool });
  const now = new Date();
  await repo.createRoom({ conversationId: 'room_ab', workspaceId: 'ws_usr_a', name: 'ab', createdByHumanId: 'usr_a', ownerEndpointId: 'ep_a', now });
  await repo.addRoomMember({ conversationId: 'room_ab', endpointId: 'ep_b1', role: 'member', addedByHumanId: 'usr_a', now });

  const email = await repo.createContact({ contactId: 'ct_1', ownerHumanId: 'usr_a', kind: 'email', login: 'auser@gmail.com', displayName: 'Rich', now });
  assert.equal(email.display_name, 'Rich');
  await assert.rejects(repo.createContact({ contactId: 'ct_2', ownerHumanId: 'usr_a', kind: 'email', login: 'AUSER@gmail.com', displayName: 'Dup', now }), { code: 'CONTACT_LOGIN_EXISTS' });
  await repo.createContact({ contactId: 'ct_3', ownerHumanId: 'usr_b', kind: 'email', login: 'auser@gmail.com', displayName: 'Richard', now });
  await repo.createContact({ contactId: 'ct_4', ownerHumanId: 'usr_a', kind: 'human', login: 'usr_b', displayName: 'Bob', now });
  await repo.createContact({ contactId: 'ct_5', ownerHumanId: 'usr_a', kind: 'human', login: 'usr_c', displayName: 'Carol', now });
  await repo.createContact({ contactId: 'ct_6', ownerHumanId: 'usr_a', kind: 'endpoint', login: 'ep_chief', displayName: 'Chief', now });

  const mine = Object.fromEntries((await repo.listContacts('usr_a')).map((c) => [c.contact_id, c]));
  assert.deepEqual(Object.keys(mine).sort(), ['ct_1', 'ct_4', 'ct_5', 'ct_6']);
  assert.deepEqual(mine.ct_1.endpoint_ids, []);
  assert.deepEqual(mine.ct_4.endpoint_ids, ['ep_b1']); // shares room_ab; ep_b2 does not
  assert.deepEqual(mine.ct_5.endpoint_ids, []); // no shared room: nothing revealed
  assert.deepEqual(mine.ct_6.endpoint_ids, ['ep_chief']);
  assert.deepEqual((await repo.listContacts('usr_b')).map((c) => c.display_name), ['Richard']);

  assert.equal(await repo.updateContact({ contactId: 'ct_1', ownerHumanId: 'usr_b', displayName: 'Hijack', now }), null);
  assert.equal((await repo.updateContact({ contactId: 'ct_1', ownerHumanId: 'usr_a', displayName: 'Richard Bush', now })).display_name, 'Richard Bush');
  assert.equal(await repo.deleteContact({ contactId: 'ct_1', ownerHumanId: 'usr_b' }), false);
  assert.equal(await repo.deleteContact({ contactId: 'ct_1', ownerHumanId: 'usr_a' }), true);
  await assert.rejects(pool.query(`INSERT INTO contacts VALUES ('ct_x', 'usr_a', 'email', 'z@z.co', '${'x'.repeat(41)}', NOW(), NOW())`), { code: '23514' });
});
