import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { createIdentity } from '../../cli/identity.mjs';
import { ROOM_SYSTEM_ENDPOINT_ID, ROOM_SYSTEM_OWNER_ID } from './room-system-identity.mjs';
import { emitRoomEvent } from './room-events.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const NOW = new Date();

test('postgres emitRoomEvent persists with a room_seq and a repeat key writes nothing', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  // Reset the schema first: the live runner runs suites one at a time, and a prior suite can leave a partially tracked schema that a plain migrate cannot resume.
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  const run = crypto.randomUUID().replaceAll('-', '_');
  const roomId = `room_${run}`;
  const room2Id = `room2_${run}`;
  // Remove the system endpoint and key only when no system-signed envelope is left,
  // so this test never deletes another test's rows.
  const dropSystemIfUnused = async () => {
    const left = await pool.query(`SELECT 1 FROM envelopes WHERE sender_endpoint_id = 'ep_relay_system' LIMIT 1`);
    if (left.rowCount > 0) return;
    await pool.query(`DELETE FROM endpoint_keys WHERE endpoint_id = 'ep_relay_system'`);
    await pool.query(`DELETE FROM endpoints WHERE endpoint_id = 'ep_relay_system'`);
    await pool.query(`DELETE FROM humans WHERE human_id = 'relay_system'`);
  };
  // Only rows in this run's two rooms.
  const cleanRun = async () => {
    const mine = `SELECT message_id FROM envelopes WHERE conversation_id IN ('${roomId}', '${room2Id}')`;
    await pool.query(`DELETE FROM deliveries WHERE message_id IN (${mine})`);
    await pool.query(`DELETE FROM audit_events WHERE subject_id IN (${mine})`);
        await pool.query(`DELETE FROM idempotency_keys WHERE message_id IN (${mine})`);
    await pool.query(`DELETE FROM envelopes WHERE conversation_id IN ('${roomId}', '${room2Id}')`);
  };
  await dropSystemIfUnused();
  t.after(async () => { await cleanRun(); await dropSystemIfUnused(); await pool.end(); });

  const human = `usr_evt_${run}`;
  const web = `ep_web_${run}`;
  const claude = `ep_claude_${run}`;
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [human]);
  for (const [endpointId, runtime] of [[web, 'web'], [claude, 'claude']]) {
    await pool.query(
      `INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
       VALUES ($1, $2, $3, $4, $3, 'active', NOW())`,
      [endpointId, human, runtime, `install_${endpointId}`],
    );
  }
  const repository = new PostgresRepository({ pool });
  const system = createIdentity({ ownerId: ROOM_SYSTEM_OWNER_ID, endpointId: ROOM_SYSTEM_ENDPOINT_ID, kind: 'system' });
  await repository.ensureRoomSystemEndpoint({ identity: system, now: NOW });
  await repository.createRoom({ conversationId: roomId, workspaceId: `ws_${human}`, name: `evt_${run}`, createdByHumanId: human, ownerEndpointId: web, now: NOW });
  await repository.addRoomMember({ conversationId: roomId, endpointId: claude, role: 'member', responseMode: 'joins', addedByHumanId: human, now: NOW });
  const room = await repository.lookupRoom(roomId);
  const registered = new Map([
    [web, { owner_id: human, status: 'active', kind: 'human' }],
    [claude, { owner_id: human, status: 'active', kind: 'agent' }],
  ]);
  const args = { identity: system, repository, room, body: { kind: 'router_decision', endpoint_ids: [claude], reason: 'asks about code' }, idempotencyKey: `evt_${run}`, now: NOW, inboxDepthLimit: 100, registered };

  const emit = () => repository.withTransaction((client) => emitRoomEvent({ ...args, client }));
  const first = await emit();
  assert.equal(first.duplicate, false);
  assert.deepEqual(first.fanout.map((d) => d.endpoint_id), [web]);
  const stored = await pool.query(`SELECT room_seq, message_type, sender_endpoint_id FROM envelopes WHERE conversation_id = $1`, [roomId]);
  assert.equal(stored.rowCount, 1);
  assert.equal(String(stored.rows[0].room_seq), '1');
  assert.equal(stored.rows[0].message_type, 'room.event');
  assert.equal(stored.rows[0].sender_endpoint_id, 'ep_relay_system');

  const second = await emit();
  assert.equal(second.message_id, first.message_id);
  assert.equal(second.duplicate, true);
  const after = await pool.query(`SELECT count(*)::int AS n FROM envelopes WHERE conversation_id = $1`, [roomId]);
  assert.equal(after.rows[0].n, 1);
  const deliveries = await pool.query(`SELECT count(*)::int AS n FROM deliveries WHERE message_id = $1`, [first.message_id]);
  assert.equal(deliveries.rows[0].n, 1);

  // Concurrent callers with one key: the room lock serializes them, so the loser
  // sees the winner's event instead of failing on idempotency_keys.
  const raceArgs = { ...args, idempotencyKey: `race_${run}` };
  const results = await Promise.all([1, 2].map(() => repository.withTransaction((client) => emitRoomEvent({ ...raceArgs, client }))));
  assert.equal(results[0].message_id, results[1].message_id);
  assert.deepEqual(results.map((r) => r.duplicate).sort(), [false, true]);
  const raced = await pool.query(`SELECT count(*)::int AS n FROM envelopes WHERE conversation_id = $1 AND idempotency_key = $2`, [roomId, `${roomId}:race_${run}`]);
  assert.equal(raced.rows[0].n, 1);

  // The same raw key in a second room is a separate event, not a 23505.
  await repository.createRoom({ conversationId: room2Id, workspaceId: `ws_${human}`, name: `evt2_${run}`, createdByHumanId: human, ownerEndpointId: web, now: NOW });
  const room2 = await repository.lookupRoom(room2Id);
  const emitIn = (r) => repository.withTransaction((client) => emitRoomEvent({ ...args, room: r, client }));
  const inRoom2 = await emitIn(room2);
  assert.equal(inRoom2.duplicate, false);
  assert.notEqual(inRoom2.message_id, first.message_id);
  const perRoom = await pool.query(`SELECT conversation_id, count(*)::int AS n FROM envelopes WHERE conversation_id IN ($1, $2) AND idempotency_key IN ($3, $4) GROUP BY conversation_id`, [roomId, room2Id, `${roomId}:evt_${run}`, `${room2Id}:evt_${run}`]);
  assert.deepEqual(Object.fromEntries(perRoom.rows.map((r) => [r.conversation_id, r.n])), { [roomId]: 1, [room2Id]: 1 });
  const repeat = await emitIn(room);
  assert.equal(repeat.duplicate, true);
  assert.equal(repeat.message_id, first.message_id);
  const still = await pool.query(`SELECT count(*)::int AS n FROM envelopes WHERE conversation_id = $1 AND idempotency_key = $2`, [roomId, `${roomId}:evt_${run}`]);
  assert.equal(still.rows[0].n, 1);
});

test('postgres lookupRoomEventByKey requires a transaction client', { skip: !connectionString }, async () => {
  const repository = new PostgresRepository({ pool: { query() { throw new Error('pool must not be used'); } } });
  await assert.rejects(() => repository.lookupRoomEventByKey('room_x', 'room_x:k', null), /requires a transaction client/);
  await assert.rejects(() => repository.lookupRoomEventByKey('room_x', 'room_x:k'), /requires a transaction client/);
});
