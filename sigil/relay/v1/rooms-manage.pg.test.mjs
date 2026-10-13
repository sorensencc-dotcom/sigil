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
      `INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at)
       VALUES ($1, $2, $3, CASE $3 WHEN 'relay' THEN 'system' WHEN 'human' THEN 'human' WHEN 'web' THEN 'human' ELSE 'agent' END, $4, $3, 'active', NOW())`,
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

// Task 14: Stop's selector. Rows on agents ownerHumanId owns, or rows whose
// subject_human_id is subjectHumanId; other rows and terminal rows stay.
test('postgres cancelRoomInvocations scoped by agent owner or subject', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const op = await seed(pool, suffix);
  const guest = await seed(pool, `g_${suffix}`);
  const repository = new PostgresRepository({ pool });
  const now = new Date();
  const roomId = `room_stop_${suffix}`;
  await repository.createRoom({ conversationId: roomId, workspaceId: `ws_${op.human}`, name: `stop_${suffix}`, createdByHumanId: op.human, ownerEndpointId: op.web, now });
  const base = { roomId, workspaceId: `ws_${op.human}`, threadRootId: 'msg_root', decidedBy: 'mention', now };
  const rows = [
    ['op_on_op', op.claude, op.human, 'running'],
    ['guest_on_op', op.claude, guest.human, 'queued'],
    ['guest_on_guest', guest.claude, guest.human, 'running'],
    ['op_on_guest', guest.claude, op.human, 'queued'],
    ['guest_done', op.claude, guest.human, 'refused'],
  ];
  for (const [name, endpointId, subjectHumanId, status] of rows) {
    await repository.createRoomInvocation({ ...base, invocationId: `inv_${name}_${suffix}`, triggerMessageId: `msg_${name}_${suffix}`, endpointId, subjectHumanId, status, reason: status === 'refused' ? 'not_allowed' : null });
  }
  const names = (list) => list.map((row) => row.invocation_id.replace(`inv_`, '').replace(`_${suffix}`, '')).sort();
  const byGuest = await repository.cancelRoomInvocations(roomId, { ownerHumanId: guest.human, subjectHumanId: guest.human, now });
  assert.deepEqual(names(byGuest), ['guest_on_guest', 'guest_on_op', 'op_on_guest']);
  assert.equal((await repository.lookupRunningInvocation(roomId, op.claude)).invocation_id, `inv_op_on_op_${suffix}`);
  const byOperator = await repository.cancelRoomInvocations(roomId, { ownerHumanId: op.human, subjectHumanId: op.human, now });
  assert.deepEqual(names(byOperator), ['op_on_op']);
  assert.deepEqual(names(await repository.listRoomInvocations(roomId, { status: 'refused' })), ['guest_done']);
});
