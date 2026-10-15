import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { provisionHumanTx } from '../provision-human.mjs';
import { withTransaction } from '../with-transaction.mjs';
import { createInvite, listInvites, revokeInvite, hashInviteToken } from './invites.mjs';
import { assertDisposableTestDatabase } from '../../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const skip = !connectionString;
const wrapKey = crypto.randomBytes(32);
const NOW = new Date('2030-01-02T03:04:05.000Z');

async function freshPool(t) {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyMigrations(connectionString);
  return pool;
}

async function seedRoom(pool, roomId, { createdBy, ownerEndpoint }) {
  await pool.query(`INSERT INTO workspaces (workspace_id, name, created_by, created_at) VALUES ('ws_t', 'ws_t', $1, $2) ON CONFLICT DO NOTHING`, [createdBy, NOW]);
  await pool.query(`INSERT INTO conversations (conversation_id, kind, created_by, created_at) VALUES ($1, 'room', $2, $3)`, [roomId, createdBy, NOW]);
  await pool.query(`INSERT INTO rooms (conversation_id, workspace_id, name, created_at) VALUES ($1, 'ws_t', $1, $2)`, [roomId, NOW]);
  await pool.query(`INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at) VALUES ($1, $2, 'owner', $3, $4)`, [roomId, ownerEndpoint, createdBy, NOW]);
}

async function setup(t) {
  const pool = await freshPool(t);
  const operator = await withTransaction(pool, (c) => provisionHumanTx(c, { displayName: 'Operator', wrapKey, now: NOW }));
  const other = await withTransaction(pool, (c) => provisionHumanTx(c, { displayName: 'Other', wrapKey, now: NOW }));
  await seedRoom(pool, 'room_a', { createdBy: operator.human_id, ownerEndpoint: operator.endpoint_id });
  return { pool, operator, other };
}

const create = (pool, args) => withTransaction(pool, (c) => createInvite(c, { name: 'guest', ttlMs: 60_000, now: NOW, ...args }));

test('createInvite stores only the sha256 of the token', { skip }, async (t) => {
  const { pool, operator } = await setup(t);
  const { invite_id, token } = await create(pool, { createdByHumanId: operator.human_id, rooms: [{ roomId: 'room_a', role: 'member' }] });
  const row = (await pool.query('SELECT * FROM room_invites WHERE invite_id = $1', [invite_id])).rows[0];
  assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.equal(row.token_hash, hashInviteToken(token));
  assert.ok(token.length >= 32);
  assert.ok(!JSON.stringify(row).includes(token));
  const rooms = (await pool.query('SELECT room_id, role FROM room_invite_rooms WHERE invite_id = $1', [invite_id])).rows;
  assert.deepEqual(rooms, [{ room_id: 'room_a', role: 'member' }]);
});

test('createInvite rejects owner role and a creator who does not manage the room', { skip }, async (t) => {
  const { pool, operator, other } = await setup(t);
  await assert.rejects(create(pool, { createdByHumanId: operator.human_id, rooms: [{ roomId: 'room_a', role: 'owner' }] }), (e) => e.code === 'INVALID_ROLE');
  await assert.rejects(create(pool, { createdByHumanId: other.human_id, rooms: [{ roomId: 'room_a', role: 'member' }] }), (e) => e.code === 'ROUTE_NOT_AUTHORIZED');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM room_invites')).rows[0].n, 0);
});

test('targeted invite rejects an agent endpoint and an endpoint owned by another human', { skip }, async (t) => {
  const { pool, operator, other } = await setup(t);
  await pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, status, installation_id, display_name, created_at)
    SELECT 'ep_agent', owner_id, runtime, 'agent', status, 'install_ep_agent', 'agent', created_at FROM endpoints WHERE endpoint_id = $1`, [operator.endpoint_id]);
  const target = (endpointId, humanId) => ({ humanId, endpointId, issuer: 'github', subject: '1' });
  await assert.rejects(create(pool, { createdByHumanId: operator.human_id, rooms: [], target: target('ep_agent', operator.human_id) }), (e) => e.code === 'INVALID_TARGET');
  await assert.rejects(create(pool, { createdByHumanId: operator.human_id, rooms: [], target: target(other.endpoint_id, operator.human_id) }), (e) => e.code === 'INVALID_TARGET');
  const ok = await create(pool, { createdByHumanId: operator.human_id, rooms: [], target: target(other.endpoint_id, other.human_id) });
  assert.ok(ok.invite_id);
});

test('revokeInvite revokes an open invite once with one audit row; a consumed invite is untouched', { skip }, async (t) => {
  const { pool, operator, other } = await setup(t);
  const open = await create(pool, { createdByHumanId: operator.human_id, rooms: [] });
  const r1 = await withTransaction(pool, (c) => revokeInvite(c, { inviteId: open.invite_id, actorHumanId: operator.human_id, now: NOW }));
  assert.deepEqual(r1, { revoked: true });
  assert.ok((await pool.query('SELECT revoked_at FROM room_invites WHERE invite_id = $1', [open.invite_id])).rows[0].revoked_at);
  const r2 = await withTransaction(pool, (c) => revokeInvite(c, { inviteId: open.invite_id, actorHumanId: operator.human_id, now: NOW }));
  assert.deepEqual(r2, { revoked: false });
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE event_type = 'invite.revoked'`)).rows[0].n, 1);

  const used = await create(pool, { createdByHumanId: operator.human_id, rooms: [] });
  await pool.query('UPDATE room_invites SET consumed_at = $2, consumed_by_human_id = $3 WHERE invite_id = $1', [used.invite_id, NOW, other.human_id]);
  const r3 = await withTransaction(pool, (c) => revokeInvite(c, { inviteId: used.invite_id, actorHumanId: operator.human_id, now: NOW }));
  assert.deepEqual(r3, { revoked: false });
  assert.equal((await pool.query('SELECT revoked_at FROM room_invites WHERE invite_id = $1', [used.invite_id])).rows[0].revoked_at, null);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE event_type = 'invite.revoked'`)).rows[0].n, 1);
});

test('listInvites reports open, expired, revoked, and consumed states', { skip }, async (t) => {
  const { pool, operator, other } = await setup(t);
  const rooms = [{ roomId: 'room_a', role: 'member' }];
  const open = await create(pool, { createdByHumanId: operator.human_id, rooms, ttlMs: 3_600_000 });
  const expiring = await create(pool, { createdByHumanId: operator.human_id, rooms, ttlMs: 1_000 });
  const used = await create(pool, { createdByHumanId: operator.human_id, rooms });
  await pool.query('UPDATE room_invites SET consumed_at = $2, consumed_by_human_id = $3 WHERE invite_id = $1', [used.invite_id, NOW, other.human_id]);
  const revoked = await create(pool, { createdByHumanId: operator.human_id, rooms });
  await withTransaction(pool, (c) => revokeInvite(c, { inviteId: revoked.invite_id, actorHumanId: operator.human_id, now: NOW }));

  const later = new Date(NOW.getTime() + 10_000);
  const byId = Object.fromEntries((await listInvites(pool, { now: later })).map((i) => [i.invite_id, i]));
  assert.equal(byId[open.invite_id].state, 'open');
  assert.equal(byId[expiring.invite_id].state, 'expired');
  assert.equal(byId[revoked.invite_id].state, 'revoked');
  assert.equal(byId[used.invite_id].state, 'consumed');
  assert.equal(byId[used.invite_id].consumed_by_human_id, other.human_id);
  assert.deepEqual(byId[open.invite_id].rooms, [{ room_id: 'room_a', role: 'member' }]);
  const before = Object.fromEntries((await listInvites(pool, { now: NOW })).map((i) => [i.invite_id, i]));
  assert.equal(before[expiring.invite_id].state, 'open');
});
