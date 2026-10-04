import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const NOW = new Date('2026-10-02T12:00:00.000Z');

let pool;
let migrated;
async function ready() {
  assertDisposableTestDatabase(connectionString);
  migrated ??= applyMigrations(connectionString, { reset: true }).then(() => {
    pool = new pg.Pool({ connectionString });
  });
  await migrated;
  return pool;
}

async function seed(db, suffix) {
  const ids = { human: `usr_inv_${suffix}`, web: `ep_web_${suffix}`, claude: `ep_claude_${suffix}`, webKey: `key_web_${suffix}` };
  await db.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [ids.human]);
  for (const [endpointId, runtime] of [[ids.web, 'web'], [ids.claude, 'claude']]) {
    await db.query(
      `INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
       VALUES ($1, $2, $3, $4, $3, 'active', NOW())`,
      [endpointId, ids.human, runtime, `install_${endpointId}`],
    );
  }
  await db.query(
    `INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
     VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())`,
    [ids.webKey, ids.web, Buffer.alloc(32, 1)],
  );
  return ids;
}

async function setup() {
  const db = await ready();
  const run = crypto.randomUUID().replaceAll('-', '_');
  const ids = await seed(db, run);
  const repository = new PostgresRepository({ pool: db });
  const roomId = `room_${run}`;
  const workspaceId = `ws_${ids.human}`;
  await repository.createRoom({ conversationId: roomId, workspaceId, name: `build_${run}`, createdByHumanId: ids.human, ownerEndpointId: ids.web, now: NOW });
  const base = { roomId, workspaceId, threadRootId: 'msg_root', endpointId: ids.claude, decidedBy: 'mention', now: NOW };
  return { db, run, ids, repository, roomId, workspaceId, base };
}

test('lookupRoom and listRoomsForEndpoint carry max_agent_turns 6', { skip: !connectionString }, async () => {
  const { repository, roomId, ids } = await setup();
  assert.equal((await repository.lookupRoom(roomId)).max_agent_turns, 6);
  assert.equal((await repository.listRoomsForEndpoint(ids.web))[0].max_agent_turns, 6);
});

test('running, queued, promotion, and finish', { skip: !connectionString }, async () => {
  const { repository, roomId, ids, base, run } = await setup();
  const running = await repository.createRoomInvocation({ ...base, invocationId: `inv_1_${run}`, triggerMessageId: `msg_1_${run}`, status: 'running', deliveryId: 'del_a' });
  assert.equal(running.status, 'running');
  assert.equal(running.started_at, NOW.toISOString());
  assert.equal(running.finished_at, null);
  assert.equal(running.reason, null);
  assert.equal(running.reply_message_id, null);
  assert.deepEqual(Object.keys(running).sort(), ['created_at', 'decided_by', 'delivery_id', 'endpoint_id', 'finished_at', 'invocation_id', 'reason', 'reply_message_id', 'room_id', 'started_at', 'status', 'thread_root_id', 'trigger_message_id']);
  await repository.createRoomInvocation({ ...base, invocationId: `inv_2_${run}`, triggerMessageId: `msg_2_${run}`, status: 'queued' });
  assert.equal((await repository.lookupRunningInvocation(roomId, ids.claude)).invocation_id, `inv_1_${run}`);
  assert.equal((await repository.nextQueuedInvocation(roomId, ids.claude)).invocation_id, `inv_2_${run}`);
  const done = await repository.finishInvocation(`inv_1_${run}`, { status: 'completed', replyMessageId: 'msg_reply', now: NOW });
  assert.equal(done.reply_message_id, 'msg_reply');
  assert.equal(await repository.finishInvocation(`inv_1_${run}`, { status: 'failed', now: NOW }), null, 'a terminal row does not move');
  const started = await repository.startInvocation(`inv_2_${run}`, { deliveryId: 'del_b', now: NOW });
  assert.equal(started.status, 'running');
  assert.equal(started.delivery_id, 'del_b');
});

test('a second running invocation for the same agent and room is refused', { skip: !connectionString }, async () => {
  const { repository, base, run } = await setup();
  await repository.createRoomInvocation({ ...base, invocationId: `inv_1_${run}`, triggerMessageId: `msg_1_${run}`, status: 'running' });
  await assert.rejects(
    repository.createRoomInvocation({ ...base, invocationId: `inv_2_${run}`, triggerMessageId: `msg_2_${run}`, status: 'running' }),
    { code: 'ROOM_INVOCATION_RUNNING' },
  );
});

test('the same trigger cannot invoke the same agent twice', { skip: !connectionString }, async () => {
  const { repository, base, run } = await setup();
  await repository.createRoomInvocation({ ...base, invocationId: `inv_1_${run}`, triggerMessageId: `msg_1_${run}`, status: 'refused', reason: 'hop_budget' });
  await assert.rejects(
    repository.createRoomInvocation({ ...base, invocationId: `inv_2_${run}`, triggerMessageId: `msg_1_${run}`, status: 'queued' }),
    { code: 'ROOM_INVOCATION_EXISTS' },
  );
});

test('cancelRoomInvocations cancels queued and running rows only', { skip: !connectionString }, async () => {
  const { repository, roomId, ids, base, run } = await setup();
  await repository.createRoomInvocation({ ...base, invocationId: `inv_1_${run}`, triggerMessageId: `msg_1_${run}`, status: 'running' });
  await repository.createRoomInvocation({ ...base, invocationId: `inv_2_${run}`, triggerMessageId: `msg_2_${run}`, status: 'queued' });
  await repository.createRoomInvocation({ ...base, invocationId: `inv_3_${run}`, triggerMessageId: `msg_3_${run}`, status: 'refused', reason: 'hop_budget' });
  const cancelled = await repository.cancelRoomInvocations(roomId, { now: NOW });
  assert.deepEqual(cancelled.map((row) => row.invocation_id).sort(), [`inv_1_${run}`, `inv_2_${run}`]);
  assert.equal(await repository.lookupRunningInvocation(roomId, ids.claude), null);
  assert.deepEqual((await repository.listRoomInvocations(roomId, { status: 'refused' })).map((row) => row.invocation_id), [`inv_3_${run}`]);
});

test('reserveAgentTurn stops at the limit and resetAgentTurns clears it', { skip: !connectionString }, async () => {
  const { repository, roomId } = await setup();
  for (let turn = 1; turn <= 2; turn += 1) assert.deepEqual(await repository.reserveAgentTurn(roomId, 'msg_root', 2, { now: NOW }), { allowed: true, agent_turns: turn });
  assert.deepEqual(await repository.reserveAgentTurn(roomId, 'msg_root', 2, { now: NOW }), { allowed: false, agent_turns: 2 });
  await repository.resetAgentTurns(roomId, 'msg_root', { now: NOW });
  assert.equal((await repository.reserveAgentTurn(roomId, 'msg_root', 2, { now: NOW })).agent_turns, 1);
});

test('createRoomDelivery writes an open delivery for an existing message', { skip: !connectionString }, async () => {
  const { db, repository, roomId, ids, run } = await setup();
  const messageId = `msg_${run}`;
  await repository.withTransaction(async (client) => {
    const roomSeq = await repository.assignRoomSequence(client, roomId);
    const envelope = {
      protocol: 'sigil/1', message_id: messageId, conversation_id: roomId, message_type: 'room.message',
      sender: { endpoint_id: ids.web, owner_id: ids.human }, broadcast_scope: { conversation_id: roomId },
      body: { text: 'hi' }, context_refs: [], capabilities: [], correlation_id: null, idempotency_key: `idem_${run}`,
      created_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() + 600_000).toISOString(),
      signature: { algorithm: 'Ed25519', key_id: ids.webKey, value: 'sig' },
    };
    return repository.persistAcceptedEnvelope({ envelope, canonical_hash: 'h', action_hash: 'h', canonical_bytes: Buffer.from('canonical'), roomSeq, roomFanout: [] }, client);
  });
  const deliveryId = await repository.createRoomDelivery({ messageId, endpointId: ids.claude, now: NOW });
  assert.match(deliveryId, /^del_/);
  assert.equal(await repository.countOpenDeliveries(ids.claude, db), 1);
});

test('the partial unique index refuses a second running row even without the app check', { skip: !connectionString }, async () => {
  const { db, repository, roomId, workspaceId, ids, base, run } = await setup();
  await repository.createRoomInvocation({ ...base, invocationId: `inv_1_${run}`, triggerMessageId: `msg_1_${run}`, status: 'running' });
  await assert.rejects(db.query(
    `INSERT INTO room_invocations (invocation_id, room_id, workspace_id, trigger_message_id, thread_root_id, endpoint_id, decided_by, status, created_at)
     VALUES ($1,$2,$3,'msg_raw','msg_root',$4,'mention','running',now())`,
    [`inv_raw_${run}`, roomId, workspaceId, ids.claude],
  ), { code: '23505' });
});

test.after(async () => {
  if (pool) await pool.end();
});
