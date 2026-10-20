// Live-Postgres pins for the sigil_admin LISTEN channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { WebSocket } from 'ws';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { publishAdmin, startAdminListener, createAdminMessageHandler, ADMIN_LISTENER_APPLICATION_NAME } from './admin-notify.mjs';
import { PostgresRepository } from './postgres-repository.mjs';
import { createStreamServer } from './stream-server.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function freshPool(t) {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyMigrations(connectionString);
  return pool;
}

function inbox() {
  const messages = [];
  const waiters = [];
  const push = (message) => {
    messages.push(message);
    for (const waiter of waiters.splice(0)) waiter();
  };
  const next = (count, ms = 3000) => new Promise((resolve, reject) => {
    const check = () => { if (messages.length >= count) { clearTimeout(timer); resolve(messages.slice()); return true; } return false; };
    const timer = setTimeout(() => reject(new Error(`expected ${count} admin messages, got ${messages.length}`)), ms);
    if (!check()) waiters.push(function retry() { if (!check()) waiters.push(retry); });
  });
  return { messages, push, next };
}

async function inTx(pool, fn, { rollback = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query(rollback ? 'ROLLBACK' : 'COMMIT');
  } finally { client.release(); }
}

test('listener receives a committed payload and nothing from a rolled-back transaction', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  const received = inbox();
  const listener = await startAdminListener({ pool, onMessage: received.push, logger: null });
  t.after(() => listener.close());

  await inTx(pool, (client) => publishAdmin(client, { type: 'endpoint.revoked', endpoint_id: 'ep_rolled_back' }), { rollback: true });
  await inTx(pool, (client) => publishAdmin(client, { type: 'endpoint.revoked', endpoint_id: 'ep_committed' }));
  await received.next(1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(received.messages, [{ type: 'endpoint.revoked', endpoint_id: 'ep_committed' }]);
});

test('listener ignores malformed payloads and keeps listening', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  const received = inbox();
  const listener = await startAdminListener({ pool, onMessage: received.push, logger: null });
  t.after(() => listener.close());
  await pool.query(`SELECT pg_notify('sigil_admin', 'not json')`);
  await pool.query(`SELECT pg_notify('sigil_admin', '{"type":"drop.tables"}')`);
  await pool.query(`SELECT pg_notify('sigil_admin', '{"type":"human.suspended","human_id":"hum_a"}')`);
  assert.deepEqual(await received.next(1), [{ type: 'human.suspended', human_id: 'hum_a' }]);
});

test('listener reconnects after its backend is terminated and calls onReconnect', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  const received = inbox();
  let reconnects = 0;
  const listener = await startAdminListener({ pool, onMessage: received.push, onReconnect: () => { reconnects += 1; }, logger: null, backoffMs: 100 });
  t.after(() => listener.close());

  const { rows } = await pool.query('SELECT pid FROM pg_stat_activity WHERE application_name = $1 ORDER BY backend_start DESC LIMIT 1', [ADMIN_LISTENER_APPLICATION_NAME]);
  assert.equal(rows.length, 1);
  await pool.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
  const deadline = Date.now() + 5000;
  while (reconnects === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(reconnects >= 1, `expected at least one reconnect, got ${reconnects}`);

  await inTx(pool, (client) => publishAdmin(client, { type: 'human.unsuspended', human_id: 'hum_back' }));
  assert.deepEqual(await received.next(1), [{ type: 'human.unsuspended', human_id: 'hum_back' }]);
});

test('a room.members admin message sends room.updated to a connected human socket', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  const repository = new PostgresRepository({ pool });
  const now = new Date().toISOString();
  const spki = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ('hum_a', 'active', $1)`, [now]);
  await pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at) VALUES ('ep_h', 'hum_a', 'web', 'human', 'inst_h', 'H', 'active', $1)`, [now]);
  await pool.query(`INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ('key_h', 'ep_h', 'Ed25519', $1, 'active', $2)`, [spki, now]);
  await pool.query(`INSERT INTO workspaces (workspace_id, name, created_by, created_at) VALUES ('ws_a', 'ws_a', 'hum_a', $1)`, [now]);
  await pool.query(`INSERT INTO conversations (conversation_id, kind, created_by, created_at) VALUES ('room_a', 'room', 'hum_a', $1)`, [now]);
  await pool.query(`INSERT INTO rooms (conversation_id, workspace_id, name, created_at) VALUES ('room_a', 'ws_a', 'room_a', $1)`, [now]);
  await pool.query(`INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at) VALUES ('room_a', 'ep_h', 'owner', 'hum_a', $1)`, [now]);

  const httpServer = http.createServer();
  const stream = createStreamServer({ server: httpServer, repository, authenticate: () => ({ endpoint_id: 'ep_h', owner_id: 'hum_a', human_id: 'hum_a' }) });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${httpServer.address().port}/v1/stream`);
  // ws waits for open sockets before closing, so terminate first.
  t.after(async () => { socket.terminate(); await stream.close(); await new Promise((resolve) => httpServer.close(resolve)); });
  const frame = new Promise((resolve) => socket.on('message', (data) => resolve(JSON.parse(data))));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const errors = [];
  const auth = { clear() {}, clearAll() {} };
  const handle = createAdminMessageHandler({ auth, stream, repository, logger: { error: (...args) => errors.push(args) } });
  await handle({ type: 'room.members', room_ids: ['room_a'] });
  const received = await Promise.race([frame, new Promise((_, reject) => setTimeout(() => reject(new Error('no room.updated frame')), 2000))]);
  assert.deepEqual(received, { type: 'room.updated', room_id: 'room_a', changed: 'members' });
  assert.deepEqual(errors, []);
});
