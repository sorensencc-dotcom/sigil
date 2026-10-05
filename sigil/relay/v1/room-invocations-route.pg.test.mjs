// sigil/relay/v1/room-invocations-route.pg.test.mjs
// Atomicity of the router invocations route against real Postgres.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { createRelayServer } from './http-server.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { createIdentity } from '../../cli/identity.mjs';
import { ROOM_SYSTEM_ENDPOINT_ID, ROOM_SYSTEM_OWNER_ID } from './room-system-identity.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const NOW = new Date();

function call(port, path, authorization, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function setup(t) {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  const cleanSystem = async () => {
    const sent = `SELECT message_id FROM envelopes WHERE sender_endpoint_id = 'ep_relay_system'`;
    await pool.query(`DELETE FROM deliveries WHERE message_id IN (${sent})`);
    await pool.query(`DELETE FROM audit_events WHERE subject_id IN (${sent})`);
    await pool.query(`DELETE FROM idempotency_keys WHERE endpoint_id = 'ep_relay_system'`);
    await pool.query(`DELETE FROM envelopes WHERE sender_endpoint_id = 'ep_relay_system'`);
    await pool.query(`DELETE FROM endpoint_keys WHERE endpoint_id = 'ep_relay_system'`);
    await pool.query(`DELETE FROM endpoints WHERE endpoint_id = 'ep_relay_system'`);
    await pool.query(`DELETE FROM humans WHERE human_id = 'relay_system'`);
  };
  await cleanSystem();
  const run = crypto.randomUUID().replaceAll('-', '_');
  const human = `usr_rt_${run}`;
  const ids = { web: `ep_web_${run}`, claude: `ep_claude_${run}`, claudeB: `ep_claude_b_${run}`, outsider: `ep_outsider_${run}`, router: `ep_router_${run}` };
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [human]);
  for (const [endpointId, runtime] of [[ids.web, 'web'], [ids.claude, 'claude'], [ids.claudeB, 'claude'], [ids.outsider, 'claude'], [ids.router, 'claude']]) {
    await pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at) VALUES ($1, $2, $3, $4, $1, 'active', NOW())`, [endpointId, human, runtime, `install_${endpointId}`]);
  }
  await pool.query(`INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())`, [`key_${ids.web}`, ids.web, Buffer.alloc(32, 1)]);
  const repository = new PostgresRepository({ pool });
  const system = createIdentity({ ownerId: ROOM_SYSTEM_OWNER_ID, endpointId: ROOM_SYSTEM_ENDPOINT_ID, kind: 'system' });
  await repository.ensureRoomSystemEndpoint({ identity: system, now: NOW });
  const roomId = `room_${run}`;
  await repository.createRoom({ conversationId: roomId, workspaceId: `ws_${human}`, name: `rt_${run}`, createdByHumanId: human, ownerEndpointId: ids.web, now: NOW });
  await repository.addRoomMember({ conversationId: roomId, endpointId: ids.claude, role: 'member', responseMode: 'joins', addedByHumanId: human, now: NOW });
  await repository.addRoomMember({ conversationId: roomId, endpointId: ids.claudeB, role: 'member', responseMode: 'joins', addedByHumanId: human, now: NOW });
  await repository.addRoomMember({ conversationId: roomId, endpointId: ids.router, role: 'member', responseMode: 'router', addedByHumanId: human, now: NOW });
  const triggerId = `msg_trigger_${run}`;
  await repository.withTransaction(async (client) => {
    const roomSeq = await repository.assignRoomSequence(client, roomId);
    const envelope = {
      protocol: 'sigil/1', message_id: triggerId, conversation_id: roomId, message_type: 'room.message',
      sender: { endpoint_id: ids.web, owner_id: human }, broadcast_scope: { conversation_id: roomId }, body: { text: 'who can help?' },
      context_refs: [], capabilities: [], correlation_id: null, idempotency_key: `idem_${run}`, created_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 600_000).toISOString(), signature: { algorithm: 'Ed25519', key_id: `key_${ids.web}`, value: 'sig' },
    };
    return repository.persistAcceptedEnvelope({ envelope, canonical_hash: 'h', action_hash: 'h', canonical_bytes: Buffer.from('canonical'), roomSeq, roomFanout: [] }, client);
  });
  const registry = new Map([
    [ids.web, { owner_id: human, status: 'active', kind: 'human' }],
    [ids.claude, { owner_id: human, status: 'active', kind: 'agent' }],
    [ids.claudeB, { owner_id: human, status: 'active', kind: 'agent' }],
    [ids.outsider, { owner_id: human, status: 'active', kind: 'agent' }],
    [ids.router, { owner_id: human, status: 'active', kind: 'agent' }],
  ]);
  const server = createRelayServer({ registry, repository, authenticate: async (request) => (request.headers.authorization === 'Bearer router' ? { endpoint_id: ids.router, owner_id: human } : null), roomSystemIdentity: system });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await cleanSystem(); await pool.end(); });
  return { pool, repository, roomId, ids, triggerId, port: server.address().port };
}

const countRows = async (pool, sql, params) => (await pool.query(sql, params)).rows[0].n;

test('a router pick commits one invocation row and one router_decision envelope together', { skip: !connectionString }, async (t) => {
  const s = await setup(t);
  const res = await call(s.port, `/v1/rooms/${s.roomId}/invocations`, 'Bearer router', { trigger_message_id: s.triggerId, invoke: [s.ids.claude], reason: 'claude fits' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.items[0].status, 'running');
  assert.equal(res.body.items[0].decided_by, 'router');
  assert.equal(await countRows(s.pool, `SELECT count(*)::int AS n FROM room_invocations WHERE trigger_message_id = $1 AND decided_by = 'router'`, [s.triggerId]), 1);
  const evt = await s.pool.query(`SELECT body FROM envelopes WHERE conversation_id = $1 AND message_type = 'room.event' AND idempotency_key = $2`, [s.roomId, `${s.roomId}:evt_router_${s.triggerId}`]);
  assert.equal(evt.rowCount, 1);
  const body = typeof evt.rows[0].body === 'string' ? JSON.parse(evt.rows[0].body) : evt.rows[0].body;
  assert.equal(body.kind, 'router_decision');
  assert.deepEqual(body.endpoint_ids, [s.ids.claude]);
  const again = await call(s.port, `/v1/rooms/${s.roomId}/invocations`, 'Bearer router', { trigger_message_id: s.triggerId, invoke: [s.ids.claude] });
  assert.equal(again.body.duplicate, true);
  assert.equal(await countRows(s.pool, `SELECT count(*)::int AS n FROM room_invocations WHERE trigger_message_id = $1`, [s.triggerId]), 1);
});

test('a failing decision event rolls back the invocation row', { skip: !connectionString }, async (t) => {
  const s = await setup(t);
  const original = s.repository.persistAcceptedEnvelope.bind(s.repository);
  s.repository.persistAcceptedEnvelope = async (row, client) => {
    if (row.envelope.message_type === 'room.event' && row.envelope.idempotency_key.includes(':evt_router_')) throw new Error('injected decision failure');
    return original(row, client);
  };
  const res = await call(s.port, `/v1/rooms/${s.roomId}/invocations`, 'Bearer router', { trigger_message_id: s.triggerId, invoke: [s.ids.claude] });
  assert.ok(res.status >= 500, `expected a server error, got ${res.status}`);
  assert.equal(await countRows(s.pool, `SELECT count(*)::int AS n FROM room_invocations WHERE trigger_message_id = $1`, [s.triggerId]), 0);
  assert.equal(await countRows(s.pool, `SELECT count(*)::int AS n FROM deliveries WHERE message_id = $1 AND recipient_endpoint_id = $2`, [s.triggerId, s.ids.claude]), 0);
});

test('a router decision naming two joins agents and a non-member commits one row per endpoint', { skip: !connectionString }, async (t) => {
  const s = await setup(t);
  const res = await call(s.port, `/v1/rooms/${s.roomId}/invocations`, 'Bearer router', { trigger_message_id: s.triggerId, invoke: [s.ids.claude, s.ids.claudeB, s.ids.outsider], reason: 'both fit' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.duplicate, false);
  assert.deepEqual(res.body.items.map((item) => [item.endpoint_id, item.status]), [[s.ids.claude, 'running'], [s.ids.claudeB, 'running'], [s.ids.outsider, 'refused']]);
  assert.equal(await countRows(s.pool, `SELECT count(*)::int AS n FROM room_invocations WHERE trigger_message_id = $1 AND decided_by = 'router'`, [s.triggerId]), 3);
  const again = await call(s.port, `/v1/rooms/${s.roomId}/invocations`, 'Bearer router', { trigger_message_id: s.triggerId, invoke: [s.ids.claude, s.ids.claudeB, s.ids.outsider] });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(await countRows(s.pool, `SELECT count(*)::int AS n FROM room_invocations WHERE trigger_message_id = $1`, [s.triggerId]), 3);
});
