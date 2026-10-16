// sigil/relay/v1/room-loop-guards.pg.test.mjs
// Rooms phase 6 on Postgres: cap epochs and halt keys against the real
// room_threads and idempotency_keys tables, and event atomicity with the
// refused row. Skipped without SIGIL_TEST_DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { createRelayServer } from './http-server.mjs';
import { createRoomHumanSigner } from './room-human-signer.mjs';
import { dispatchToTarget, emitRefusal } from './room-dispatch.mjs';
import { ROOM_SYSTEM_ENDPOINT_ID, ROOM_SYSTEM_OWNER_ID } from './room-system-identity.mjs';
import { createIdentity } from '../../cli/identity.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

function call(port, method, path, token, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: `Bearer ${token}` } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function world(t) {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  // Open the pool's connections one at a time before use: a burst of connects
  // through the Windows Docker port proxy can reset (ECONNRESET).
  const warm = [];
  for (let n = 0; n < 4; n += 1) { const c = await pool.connect(); await c.query('SELECT 1'); warm.push(c); }
  for (const c of warm) c.release();
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const human = `usr_guard_${suffix}`;
  const web = createIdentity({ ownerId: human, endpointId: `ep_web_${suffix}`, kind: 'human' });
  const agent = createIdentity({ ownerId: human, endpointId: `ep_agent_${suffix}`, kind: 'agent' });
  const agent2 = createIdentity({ ownerId: human, endpointId: `ep_agent2_${suffix}`, kind: 'agent' });
  const system = createIdentity({ ownerId: ROOM_SYSTEM_OWNER_ID, endpointId: ROOM_SYSTEM_ENDPOINT_ID, kind: 'system' });
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [human]);
  for (const [identity, runtime] of [[web, 'web'], [agent, 'claude'], [agent2, 'codex']]) {
    await pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at) VALUES ($1, $2, $3, CASE $3 WHEN 'web' THEN 'human' ELSE 'agent' END, $4, $3, 'active', NOW())`, [identity.endpoint_id, human, runtime, `install_${identity.endpoint_id}`]);
    await pool.query(`INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())`, [identity.key_id, identity.endpoint_id, crypto.createPublicKey(identity.public_key_pem).export({ type: 'spki', format: 'der' })]);
  }
  const repository = new PostgresRepository({ pool });
  await repository.ensureRoomSystemEndpoint({ identity: system, now: new Date() });
  const entry = (identity) => ({ owner_id: identity.owner_id, endpoint_id: identity.endpoint_id, status: 'active', kind: identity.kind, key_id: identity.key_id, public_key: crypto.createPublicKey(identity.public_key_pem) });
  const registry = new Map([[web.endpoint_id, entry(web)], [agent.endpoint_id, entry(agent)], [agent2.endpoint_id, entry(agent2)], [system.endpoint_id, entry(system)]]);
  const logger = { log() {}, warn() {}, error() {} };
  const server = createRelayServer({
    logger, registry, repository, humanSigner: createRoomHumanSigner({ identity: web, repository }), roomSystemIdentity: system,
    authenticate: async (request) => {
      const token = request.headers.authorization;
      if (token === 'Bearer web') return { endpoint_id: web.endpoint_id, owner_id: human, human_id: human };
      if (token === 'Bearer agent') return { endpoint_id: agent.endpoint_id, owner_id: human };
      return null;
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { pool, repository, registry, system, port: server.address().port, web, agent, agent2, human, suffix };
}

async function freshRoom(w, label) {
  const roomId = `room_${label}_${w.suffix}`;
  const now = new Date();
  await w.repository.createRoom({ conversationId: roomId, workspaceId: `ws_${w.human}`, name: `${label}_${w.suffix}`, createdByHumanId: w.human, ownerEndpointId: w.web.endpoint_id, now });
  for (const identity of [w.agent, w.agent2]) {
    await w.repository.addRoomMember({ conversationId: roomId, endpointId: identity.endpoint_id, role: 'member', responseMode: 'mentions_only', addedByHumanId: w.human, now });
  }
  return roomId;
}

const eventsOf = async (w, roomId, kind) => (await w.repository.listRoomMessages(roomId, 0n, 500))
  .map((row) => row.envelope).filter((e) => e.message_type === 'room.event' && (!kind || e.body.kind === kind));

// Runs one dispatch decision for the agent in the thread, as the accept path does.
async function dispatchAndRefuse(w, roomId, threadRootId, endpointId, { failAfter = false } = {}) {
  const now = new Date();
  return w.repository.withTransaction(async (client) => {
    await w.repository.lockRoom(client, roomId);
    const room = await w.repository.lookupRoom(roomId, client);
    const { invocation } = await dispatchToTarget({ room, triggerMessageId: `msg_${crypto.randomUUID()}`, threadRootId, endpointId, decidedBy: 'mention', subjectHumanId: w.human, repository: w.repository, client, now, inboxDepthLimit: 100, registered: w.registry });
    await emitRefusal({ systemIdentity: w.system, repository: w.repository, client, room, invocation, now, inboxDepthLimit: 100, registered: w.registry });
    if (failAfter) throw new Error('rollback requested');
    return invocation;
  });
}

async function exhaust(w, roomId, threadRootId) {
  const room = await w.repository.lookupRoom(roomId);
  for (let n = 0; n < room.max_agent_turns; n += 1) assert.equal((await w.repository.reserveAgentTurn(roomId, threadRootId, room.max_agent_turns, { now: new Date() })).allowed, true);
}

test('cap: one event per epoch, a repeat in the same epoch adds none, a reset starts a new epoch', { skip: !connectionString, timeout: 55_000 }, async (t) => {
  const w = await world(t);
  const roomId = await freshRoom(w, 'cap');
  const root = `msg_root_${w.suffix}`;
  await exhaust(w, roomId, root);
  const first = await dispatchAndRefuse(w, roomId, root, w.agent.endpoint_id);
  assert.equal(first.reason, 'hop_budget');
  const second = await dispatchAndRefuse(w, roomId, root, w.agent2.endpoint_id);
  assert.equal(second.reason, 'hop_budget');
  assert.equal((await eventsOf(w, roomId, 'invocation_refused')).length, 2);
  const caps = await eventsOf(w, roomId, 'agent_cap_reached');
  assert.equal(caps.length, 1);
  assert.deepEqual(caps[0].body.endpoint_ids, [w.agent.endpoint_id]);
  assert.equal(caps[0].sender.endpoint_id, ROOM_SYSTEM_ENDPOINT_ID);

  assert.equal(await w.repository.lookupCapEpoch(roomId, root), 0);
  assert.equal(await w.repository.resetAgentTurns(roomId, root, { now: new Date() }), 1);
  assert.equal(await w.repository.lookupCapEpoch(roomId, root), 1);
  await exhaust(w, roomId, root);
  await dispatchAndRefuse(w, roomId, root, w.agent.endpoint_id);
  assert.equal((await eventsOf(w, roomId, 'agent_cap_reached')).length, 2, 'new epoch, new event');
});

test('cap: the event commits with the refused row, and rolls back with it', { skip: !connectionString, timeout: 55_000 }, async (t) => {
  const w = await world(t);
  const roomId = await freshRoom(w, 'atomic');
  const root = `msg_root_${w.suffix}`;
  await exhaust(w, roomId, root);
  await assert.rejects(dispatchAndRefuse(w, roomId, root, w.agent.endpoint_id, { failAfter: true }), /rollback requested/);
  assert.equal((await w.repository.listRoomInvocations(roomId)).length, 0, 'refused row rolled back');
  assert.equal((await eventsOf(w, roomId)).length, 0, 'no event survives the rollback');
  await dispatchAndRefuse(w, roomId, root, w.agent.endpoint_id);
  assert.equal((await w.repository.listRoomInvocations(roomId)).length, 1);
  assert.equal((await eventsOf(w, roomId, 'agent_cap_reached')).length, 1, 'the retry posts the event the rollback discarded');
});

async function seedRunning(w, roomId, invocationId, endpointId) {
  await w.repository.createRoomInvocation({ invocationId, roomId, workspaceId: `ws_${w.human}`, triggerMessageId: `msg_${invocationId}`, threadRootId: 'msg_root', endpointId, decidedBy: 'mention', status: 'running', subjectHumanId: w.human, now: new Date() });
}

test('halt: Stop posts two invocation_stopped then one room_halted; a second Stop posts none', { skip: !connectionString, timeout: 55_000 }, async (t) => {
  const w = await world(t);
  const roomId = await freshRoom(w, 'halt');
  await seedRunning(w, roomId, `inv_a_${w.suffix}`, w.agent.endpoint_id);
  await seedRunning(w, roomId, `inv_b_${w.suffix}`, w.agent2.endpoint_id);
  const stop = await call(w.port, 'POST', `/v1/rooms/${roomId}/stop`, 'web', {});
  assert.equal(stop.status, 200, JSON.stringify(stop.body));
  assert.equal(stop.body.cancelled, 2);
  const kinds = (await eventsOf(w, roomId)).map((e) => e.body.kind);
  assert.deepEqual(kinds, ['invocation_stopped', 'invocation_stopped', 'room_halted']);
  const [halt] = await eventsOf(w, roomId, 'room_halted');
  assert.deepEqual([...halt.body.endpoint_ids].sort(), [w.agent.endpoint_id, w.agent2.endpoint_id].sort());
  const again = await call(w.port, 'POST', `/v1/rooms/${roomId}/stop`, 'web', {});
  assert.equal(again.body.cancelled, 0);
  assert.equal((await eventsOf(w, roomId, 'room_halted')).length, 1);
});

test('failure: fail posts invocation_failed; a stale invocation_id posts nothing', { skip: !connectionString, timeout: 55_000 }, async (t) => {
  const w = await world(t);
  const roomId = await freshRoom(w, 'fail');
  const id = `inv_f_${w.suffix}`;
  await seedRunning(w, roomId, id, w.agent.endpoint_id);
  const stale = await call(w.port, 'POST', `/v1/rooms/${roomId}/invocations/fail`, 'agent', { invocation_id: 'inv_old', reason: 'late' });
  assert.equal(stale.status, 404);
  assert.equal((await eventsOf(w, roomId, 'invocation_failed')).length, 0);
  const res = await call(w.port, 'POST', `/v1/rooms/${roomId}/invocations/fail`, 'agent', { invocation_id: id, reason: 'cli exited 1' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [event] = await eventsOf(w, roomId, 'invocation_failed');
  assert.equal(event.body.invocation_id, id);
  assert.equal(event.body.reason, 'cli exited 1');
});
