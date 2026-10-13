import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createIdentity, saveIdentity } from './identity.mjs';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const cli = fileURLToPath(new URL('./sigil.mjs', import.meta.url));
const run = promisify(execFile);
const env = { ...process.env, SIGIL_WRAP_KEY_TEST: crypto.randomBytes(32).toString('base64') };
delete env.SIGIL_WRAP_KEY_UNSET;

async function freshPool(t) {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyMigrations(connectionString);
  return pool;
}

test('human add provisions a human, prints ids, and publishes human.provisioned', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  const listener = new pg.Client({ connectionString });
  await listener.connect();
  t.after(() => listener.end());
  const received = new Promise((resolve) => listener.on('notification', (m) => resolve(m.payload)));
  await listener.query('LISTEN sigil_admin');

  const { stdout } = await run(process.execPath, [cli, 'human', 'add', '--name', 'Carol', '--database-url', connectionString, '--room-key-wrap-key', 'SIGIL_WRAP_KEY_TEST'], { env });
  const humanId = /human_id: (hum_[0-9a-f]{32})/.exec(stdout)?.[1];
  const endpointId = /endpoint_id: (ep_[0-9a-f]{32})/.exec(stdout)?.[1];
  assert.ok(humanId && endpointId, stdout);

  const row = (await pool.query('SELECT owner_id, kind, display_name FROM endpoints WHERE endpoint_id = $1', [endpointId])).rows[0];
  assert.deepEqual({ ...row }, { owner_id: humanId, kind: 'human', display_name: 'Carol' });
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM human_signing_keys')).rows[0].n, 1);
  const attr = (await pool.query(`SELECT kind, value_or_ciphertext FROM human_attributes WHERE human_id = $1`, [humanId])).rows;
  assert.equal(attr.length, 1);
  assert.equal(attr[0].kind, 'name');
  assert.equal(attr[0].value_or_ciphertext.toString('utf8'), 'Carol');

  const payload = await Promise.race([received, new Promise((_, reject) => setTimeout(() => reject(new Error('no sigil_admin notification')), 5000))]);
  assert.deepEqual(JSON.parse(payload), { type: 'human.provisioned', human_id: humanId, endpoint_id: endpointId, room_ids: [] });
});

test('human add without a wrap key fails and writes nothing', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  await assert.rejects(
    run(process.execPath, [cli, 'human', 'add', '--name', 'Dan', '--database-url', connectionString, '--room-key-wrap-key', 'SIGIL_WRAP_KEY_UNSET'], { env }),
    (error) => /not set/.test(error.stderr),
  );
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM humans')).rows[0].n, 0);
});


async function provision(name) {
  const { stdout } = await run(process.execPath, [cli, 'human', 'add', '--name', name, '--database-url', connectionString, '--room-key-wrap-key', 'SIGIL_WRAP_KEY_TEST'], { env });
  return { humanId: /human_id: (hum_[0-9a-f]{32})/.exec(stdout)[1], endpointId: /endpoint_id: (ep_[0-9a-f]{32})/.exec(stdout)[1] };
}

async function seedRoom(pool, roomId, owner) {
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO workspaces (workspace_id, name, created_by, created_at) VALUES ('ws_c', 'ws_c', $1, $2) ON CONFLICT DO NOTHING`, [owner.humanId, now]);
  await pool.query(`INSERT INTO conversations (conversation_id, kind, created_by, created_at) VALUES ($1, 'room', $2, $3)`, [roomId, owner.humanId, now]);
  await pool.query(`INSERT INTO rooms (conversation_id, workspace_id, name, created_at) VALUES ($1, 'ws_c', $1, $2)`, [roomId, now]);
  await pool.query(`INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at) VALUES ($1, $2, 'owner', $3, $4)`, [roomId, owner.endpointId, owner.humanId, now]);
}

function identityFor(t, owner) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-h2r-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'identity.json');
  saveIdentity(file, createIdentity({ ownerId: owner.humanId, endpointId: owner.endpointId }));
  return file;
}

test('human add-to-room adds the human to the rooms as the operator and publishes room.members', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  const operator = await provision('Operator');
  const guest = await provision('Guest');
  await seedRoom(pool, 'room_a', operator);
  await seedRoom(pool, 'room_b', operator);
  const listener = new pg.Client({ connectionString });
  await listener.connect();
  t.after(() => listener.end());
  const received = new Promise((resolve) => listener.on('notification', (m) => resolve(m.payload)));
  await listener.query('LISTEN sigil_admin');

  const { stdout } = await run(process.execPath, [cli, 'human', 'add-to-room', '--human', guest.humanId, '--room', 'room_b:room_manager', '--room', 'room_a:member', '--identity', identityFor(t, operator), '--database-url', connectionString], { env });
  assert.match(stdout, /rooms: room_a, room_b/);
  const rows = (await pool.query('SELECT conversation_id, role, added_by FROM conversation_members WHERE endpoint_id = $1 ORDER BY conversation_id', [guest.endpointId])).rows;
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { conversation_id: 'room_a', role: 'member', added_by: operator.humanId },
    { conversation_id: 'room_b', role: 'room_manager', added_by: operator.humanId }]);
  const payload = await Promise.race([received, new Promise((_, reject) => setTimeout(() => reject(new Error('no sigil_admin notification')), 5000))]);
  assert.deepEqual(JSON.parse(payload), { type: 'room.members', room_ids: ['room_a', 'room_b'] });
});

test('human add-to-room fails for an operator who does not manage the room, and for an unknown human', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  const owner = await provision('Owner');
  const outsider = await provision('Outsider');
  const guest = await provision('Guest');
  await seedRoom(pool, 'room_a', owner);
  await assert.rejects(
    run(process.execPath, [cli, 'human', 'add-to-room', '--human', guest.humanId, '--room', 'room_a:member', '--identity', identityFor(t, outsider), '--database-url', connectionString], { env }),
    (error) => /does not manage: room_a/.test(error.stderr),
  );
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM conversation_members WHERE endpoint_id = $1', [guest.endpointId])).rows[0].n, 0);
  await assert.rejects(
    run(process.execPath, [cli, 'human', 'add-to-room', '--human', 'hum_missing', '--room', 'room_a:member', '--identity', identityFor(t, owner), '--database-url', connectionString], { env }),
    (error) => /HUMAN_NOT_FOUND/.test(error.stderr),
  );
});

test('human add --room provisions and adds to rooms in one command as the operator', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  const operator = await provision('Operator');
  await seedRoom(pool, 'room_a', operator);
  await seedRoom(pool, 'room_b', operator);
  const { stdout } = await run(process.execPath, [cli, 'human', 'add', '--name', 'Newbie', '--room', 'room_a:member', '--room', 'room_b:room_manager', '--identity', identityFor(t, operator), '--database-url', connectionString, '--room-key-wrap-key', 'SIGIL_WRAP_KEY_TEST'], { env });
  const endpointId = /endpoint_id: (ep_[0-9a-f]{32})/.exec(stdout)[1];
  const rows = (await pool.query('SELECT conversation_id, role, added_by FROM conversation_members WHERE endpoint_id = $1 ORDER BY conversation_id', [endpointId])).rows;
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { conversation_id: 'room_a', role: 'member', added_by: operator.humanId },
    { conversation_id: 'room_b', role: 'room_manager', added_by: operator.humanId }]);
});

test('human add --room by a non-manager fails ROUTE_NOT_AUTHORIZED and rolls back the human', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  const owner = await provision('Owner');
  const outsider = await provision('Outsider');
  await seedRoom(pool, 'room_a', owner);
  const before = {
    humans: (await pool.query('SELECT count(*)::int AS n FROM humans')).rows[0].n,
    endpoints: (await pool.query('SELECT count(*)::int AS n FROM endpoints')).rows[0].n,
  };
  await assert.rejects(
    run(process.execPath, [cli, 'human', 'add', '--name', 'Rejected', '--room', 'room_a:member', '--identity', identityFor(t, outsider), '--database-url', connectionString, '--room-key-wrap-key', 'SIGIL_WRAP_KEY_TEST'], { env }),
    (error) => /does not manage: room_a/.test(error.stderr),
  );
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM humans')).rows[0].n, before.humans);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM endpoints')).rows[0].n, before.endpoints);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM endpoints WHERE display_name = 'Rejected'`)).rows[0].n, 0);
});

// Invocation policy (Task 13, case 8, CLI): only the agent's owner sets invokable_by.
async function seedAgent(pool, roomId, owner, agentId) {
  await pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at) VALUES ($1, $2, 'claude', 'agent', $3, $1, 'active', NOW())`, [agentId, owner.humanId, `install_${agentId}`]);
  await pool.query(`INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at, response_mode) VALUES ($1, $2, 'member', $3, NOW(), 'joins')`, [roomId, agentId, owner.humanId]);
}

test('agent set-invokable: the owner sets the mode and publishes agent.invokable; a room_manager guest is refused', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  const operator = await provision('Operator');
  const guest = await provision('Guest');
  await seedRoom(pool, 'room_a', operator);
  await seedAgent(pool, 'room_a', operator, 'ep_agent_a');
  await pool.query(`INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at) VALUES ('room_a', $1, 'room_manager', $2, NOW())`, [guest.endpointId, operator.humanId]);
  const mode = async () => (await pool.query(`SELECT invokable_by FROM conversation_members WHERE conversation_id = 'room_a' AND endpoint_id = 'ep_agent_a'`)).rows[0].invokable_by;

  await assert.rejects(
    run(process.execPath, [cli, 'agent', 'set-invokable', '--room', 'room_a', '--agent', 'ep_agent_a', '--mode', 'members', '--identity', identityFor(t, guest), '--database-url', connectionString], { env }),
    (error) => /ROUTE_NOT_AUTHORIZED/.test(error.stderr),
  );
  assert.equal(await mode(), 'owner');
  await assert.rejects(
    run(process.execPath, [cli, 'agent', 'set-invokable', '--room', 'room_a', '--agent', 'ep_agent_a', '--mode', 'everyone', '--identity', identityFor(t, operator), '--database-url', connectionString], { env }),
    (error) => /--mode/.test(error.stderr),
  );

  const listener = new pg.Client({ connectionString });
  await listener.connect();
  t.after(() => listener.end());
  const received = new Promise((resolve) => listener.on('notification', (m) => resolve(m.payload)));
  await listener.query('LISTEN sigil_admin');
  const { stdout } = await run(process.execPath, [cli, 'agent', 'set-invokable', '--room', 'room_a', '--agent', 'ep_agent_a', '--mode', 'members', '--identity', identityFor(t, operator), '--database-url', connectionString], { env });
  assert.match(stdout, /ep_agent_a invokable_by: members/);
  assert.equal(await mode(), 'members');
  const payload = await Promise.race([received, new Promise((_, reject) => setTimeout(() => reject(new Error('no sigil_admin notification')), 5000))]);
  assert.deepEqual(JSON.parse(payload), { type: 'agent.invokable', room_ids: ['room_a'] });
});
