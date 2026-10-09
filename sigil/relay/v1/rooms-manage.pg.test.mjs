import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function seed(pool, suffix) {
  const ids = { human: `usr_manage_${suffix}`, web: `ep_web_${suffix}`, claude: `ep_claude_${suffix}` };
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [ids.human]);
  for (const [endpointId, runtime] of [[ids.web, 'web'], [ids.claude, 'claude']]) {
    await pool.query(
      `INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
       VALUES ($1, $2, $3, $4, $3, 'active', NOW())`,
      [endpointId, ids.human, runtime, `install_${endpointId}`],
    );
  }
  return ids;
}

test('postgres rename and response-mode updates', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = await seed(pool, suffix);
  const repository = new PostgresRepository({ pool });
  const now = new Date();
  const workspaceId = `ws_${ids.human}`;
  const one = `room1_${suffix}`;
  const two = `room2_${suffix}`;
  await repository.createRoom({ conversationId: one, workspaceId, name: `one_${suffix}`, createdByHumanId: ids.human, ownerEndpointId: ids.web, now });
  await repository.createRoom({ conversationId: two, workspaceId, name: `two_${suffix}`, createdByHumanId: ids.human, ownerEndpointId: ids.web, now });

  const renamed = await repository.renameRoom({ conversationId: one, name: `renamed_${suffix}` });
  assert.equal(renamed.name, `renamed_${suffix}`);
  assert.equal((await repository.lookupRoom(one)).name, `renamed_${suffix}`);
  await assert.rejects(repository.renameRoom({ conversationId: one, name: `two_${suffix}` }), { code: 'ROOM_NAME_TAKEN' });
  assert.equal((await repository.lookupRoom(one)).name, `renamed_${suffix}`);
  assert.equal((await repository.renameRoom({ conversationId: one, name: `renamed_${suffix}` })).name, `renamed_${suffix}`);
  await assert.rejects(repository.renameRoom({ conversationId: `room_missing_${suffix}`, name: 'x' }), { code: 'ROOM_NOT_FOUND' });

  await repository.addRoomMember({ conversationId: one, endpointId: ids.claude, role: 'member', responseMode: 'joins', addedByHumanId: ids.human, now });
  const member = await repository.setRoomMemberResponseMode({ conversationId: one, endpointId: ids.claude, responseMode: 'router' });
  assert.equal(member.response_mode, 'router');
  assert.equal((await repository.lookupRoomMember(one, ids.claude)).response_mode, 'router');
  assert.equal(await repository.setRoomMemberResponseMode({ conversationId: one, endpointId: `ep_missing_${suffix}`, responseMode: 'joins' }), null);
  await repository.removeRoomMember({ conversationId: one, endpointId: ids.claude, now });
  assert.equal(await repository.setRoomMemberResponseMode({ conversationId: one, endpointId: ids.claude, responseMode: 'joins' }), null);
});
