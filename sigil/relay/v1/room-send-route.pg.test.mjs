// Rooms phase 4a: racing identical sends against Postgres store one message.
// Multi-human foundation: provisioned humans post through relay-custodial keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { createRelayServer } from './http-server.mjs';
import { createRoomHumanSigner } from './room-human-signer.mjs';
import { provisionHumanTx, addHumanToRoomsTx } from './provision-human.mjs';
import { withTransaction } from './with-transaction.mjs';
import { createIdentity } from '../../cli/identity.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const wrapKey = crypto.randomBytes(32);

function post(port, path, body, token = 'Bearer web') {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: token } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function operatorWorld(t) {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const human = `usr_send_${suffix}`;
  const endpointId = `ep_web_${suffix}`;
  const identity = createIdentity({ ownerId: human, endpointId, kind: 'human' });
  const publicKey = crypto.createPublicKey(identity.public_key_pem);
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [human]);
  await pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at) VALUES ($1, $2, 'web', 'human', $3, 'web', 'active', NOW())`, [endpointId, human, `install_${endpointId}`]);
  await pool.query(`INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())`, [identity.key_id, endpointId, publicKey.export({ type: 'spki', format: 'der' })]);
  const repository = new PostgresRepository({ pool });
  const roomId = `room_${suffix}`;
  await repository.createRoom({ conversationId: roomId, workspaceId: `ws_${human}`, name: `r_${suffix}`, createdByHumanId: human, ownerEndpointId: endpointId, now: new Date() });
  return { pool, suffix, human, endpointId, identity, roomId };
}

async function startServer(t, pool, { identity, human, endpointId }, principals = {}) {
  const repository = new PostgresRepository({ pool });
  const humanSigner = createRoomHumanSigner({ identity, repository, wrapKey });
  await humanSigner.verifyOperator();
  const server = createRelayServer({
    registry: new Map(), repository, humanSigner,
    authenticate: async (request) => {
      if (request.headers.authorization === 'Bearer web') return { endpoint_id: endpointId, owner_id: human, human_id: human };
      return principals[request.headers.authorization] ?? null;
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, repository };
}

async function provisionInto(pool, w, name) {
  const repository = new PostgresRepository({ pool });
  const provisioned = await withTransaction(pool, (client) => provisionHumanTx(client, { displayName: name, wrapKey }));
  await withTransaction(pool, (client) => addHumanToRoomsTx(client, {
    endpointId: provisioned.endpoint_id, memberships: [{ roomId: w.roomId, role: 'member' }], actorHumanId: w.human, repository,
  }));
  return provisioned;
}

const senderOf = async (pool, messageId) => (await pool.query('SELECT sender_endpoint_id FROM envelopes WHERE message_id = $1', [messageId])).rows[0]?.sender_endpoint_id;

test('two identical concurrent sends against postgres answer 2xx and store one message', { skip: !connectionString }, async (t) => {
  const w = await operatorWorld(t);
  const { port } = await startServer(t, w.pool, w);
  const [a, b] = await Promise.all([
    post(port, `/v1/rooms/${w.roomId}/messages`, { text: 'race', idempotency_key: 'racing' }),
    post(port, `/v1/rooms/${w.roomId}/messages`, { text: 'race', idempotency_key: 'racing' }),
  ]);
  assert.ok([a.status, b.status].every((s) => s === 200 || s === 201), JSON.stringify([a, b]));
  assert.equal(a.body.message_id, b.body.message_id);
  const stored = await w.pool.query(`SELECT message_id FROM envelopes WHERE conversation_id = $1 AND message_type = 'room.message'`, [w.roomId]);
  assert.equal(stored.rowCount, 1);
  const again = await post(port, `/v1/rooms/${w.roomId}/messages`, { text: 'race', idempotency_key: 'racing' });
  assert.equal(again.status, 200);
  assert.equal(again.body.message_id, a.body.message_id);
});

test('a provisioned human posts as their own endpoint, also after a restart', { skip: !connectionString }, async (t) => {
  const w = await operatorWorld(t);
  const alice = await provisionInto(w.pool, w, 'Alice');
  const principals = { 'Bearer alice': { endpoint_id: alice.endpoint_id, owner_id: alice.human_id, human_id: alice.human_id } };
  const first = await startServer(t, w.pool, w, principals);
  const res = await post(first.port, `/v1/rooms/${w.roomId}/messages`, { text: 'hi from alice', idempotency_key: 'a1' }, 'Bearer alice');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(await senderOf(w.pool, res.body.message_id), alice.endpoint_id);
  assert.equal(JSON.stringify(res.body).includes('PRIVATE'), false);

  const restarted = await startServer(t, w.pool, w, principals);
  const again = await post(restarted.port, `/v1/rooms/${w.roomId}/messages`, { text: 'after restart', idempotency_key: 'a2' }, 'Bearer alice');
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(await senderOf(w.pool, again.body.message_id), alice.endpoint_id);
});

test('two provisioned humans yield two distinct senders', { skip: !connectionString }, async (t) => {
  const w = await operatorWorld(t);
  const alice = await provisionInto(w.pool, w, 'Alice');
  const bob = await provisionInto(w.pool, w, 'Bob');
  const { port } = await startServer(t, w.pool, w, {
    'Bearer alice': { endpoint_id: alice.endpoint_id, owner_id: alice.human_id, human_id: alice.human_id },
    'Bearer bob': { endpoint_id: bob.endpoint_id, owner_id: bob.human_id, human_id: bob.human_id },
  });
  const a = await post(port, `/v1/rooms/${w.roomId}/messages`, { text: 'a', idempotency_key: 'k' }, 'Bearer alice');
  const b = await post(port, `/v1/rooms/${w.roomId}/messages`, { text: 'b', idempotency_key: 'k' }, 'Bearer bob');
  assert.deepEqual([a.status, b.status], [201, 201], JSON.stringify([a.body, b.body]));
  assert.equal(await senderOf(w.pool, a.body.message_id), alice.endpoint_id);
  assert.equal(await senderOf(w.pool, b.body.message_id), bob.endpoint_id);
  assert.notEqual(alice.endpoint_id, bob.endpoint_id);
});

test('a provisioned human receives a fan-out delivery of the operator post', { skip: !connectionString }, async (t) => {
  const w = await operatorWorld(t);
  const alice = await provisionInto(w.pool, w, 'Alice');
  const { port } = await startServer(t, w.pool, w);
  const res = await post(port, `/v1/rooms/${w.roomId}/messages`, { text: 'to all', idempotency_key: 'fan' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const rows = await w.pool.query('SELECT recipient_endpoint_id FROM deliveries WHERE message_id = $1', [res.body.message_id]);
  assert.ok(rows.rows.some((r) => r.recipient_endpoint_id === alice.endpoint_id), JSON.stringify(rows.rows));
});

test('a human without a custodial key gets 403 NO_SIGNING_KEY', { skip: !connectionString }, async (t) => {
  const w = await operatorWorld(t);
  const keyless = `ep_keyless_${w.suffix}`;
  await w.pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at) VALUES ($1, $2, 'web', 'human', $3, 'k', 'active', NOW())`, [keyless, w.human, `install_${keyless}`]);
  const other = createIdentity({ ownerId: w.human, endpointId: keyless, kind: 'human' });
  await w.pool.query(`INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())`, [other.key_id, keyless, crypto.createPublicKey(other.public_key_pem).export({ type: 'spki', format: 'der' })]);
  const repository = new PostgresRepository({ pool: w.pool });
  await repository.addRoomMember({ conversationId: w.roomId, endpointId: keyless, role: 'member', responseMode: null, addedByHumanId: w.human, now: new Date() });
  const { port } = await startServer(t, w.pool, w, { 'Bearer keyless': { endpoint_id: keyless, owner_id: w.human, human_id: w.human } });
  const res = await post(port, `/v1/rooms/${w.roomId}/messages`, { text: 'x', idempotency_key: 'nk' }, 'Bearer keyless');
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'NO_SIGNING_KEY');
});
