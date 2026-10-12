// Live-Postgres pin: room routes send room.updated in Postgres mode (they
// used to pass client null, which made notifyRoomHumans' member read throw).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { PostgresRepository } from './postgres-repository.mjs';
import { createRelayServer } from './http-server.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('POST /v1/rooms/:id/rename sends room.updated to human members on Postgres', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyMigrations(connectionString);
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

  const frames = [];
  const errors = [];
  const stream = { notifyRoom: (endpointId, frame) => { frames.push([endpointId, frame]); return true; } };
  const logger = { error: (...args) => errors.push(args), warn() {}, info() {}, debug() {} };
  const server = createRelayServer({ registry: new Map(), repository, stream, logger, authenticate: async () => ({ endpoint_id: 'ep_h', owner_id: 'hum_a', human_id: 'hum_a' }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const body = JSON.stringify({ name: 'renamed' });
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: '/v1/rooms/room_a/rename', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(status, 200);
  assert.deepEqual(frames, [['ep_h', { room_id: 'room_a', changed: 'room' }]]);
  assert.deepEqual(errors, []);
});
