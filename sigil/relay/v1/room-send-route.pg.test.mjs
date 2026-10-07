// Rooms phase 4a: racing identical sends against Postgres store one message.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { createRelayServer } from './http-server.mjs';
import { createRoomHumanSigner } from './room-human-signer.mjs';
import { createIdentity } from '../../cli/identity.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

function post(port, path, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: 'Bearer web' } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('two identical concurrent sends against postgres answer 2xx and store one message', { skip: !connectionString }, async (t) => {
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
  await pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at) VALUES ($1, $2, 'web', $3, 'web', 'active', NOW())`, [endpointId, human, `install_${endpointId}`]);
  await pool.query(`INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())`, [identity.key_id, endpointId, Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')]);
  const repository = new PostgresRepository({ pool });
  const roomId = `room_${suffix}`;
  await repository.createRoom({ conversationId: roomId, workspaceId: `ws_${human}`, name: `r_${suffix}`, createdByHumanId: human, ownerEndpointId: endpointId, now: new Date() });
  const registry = new Map([[endpointId, { owner_id: human, status: 'active', kind: 'human', key_id: identity.key_id, public_key: publicKey }]]);
  const server = createRelayServer({
    registry, repository, humanSigner: createRoomHumanSigner({ identity, registry }),
    authenticate: async (request) => (request.headers.authorization === 'Bearer web' ? { endpoint_id: endpointId, owner_id: human, human_id: human } : null),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const [a, b] = await Promise.all([
    post(port, `/v1/rooms/${roomId}/messages`, { text: 'race', idempotency_key: 'racing' }),
    post(port, `/v1/rooms/${roomId}/messages`, { text: 'race', idempotency_key: 'racing' }),
  ]);
  assert.ok([a.status, b.status].every((s) => s === 200 || s === 201), JSON.stringify([a, b]));
  assert.equal(a.body.message_id, b.body.message_id);
  const stored = await pool.query(`SELECT message_id FROM envelopes WHERE conversation_id = $1 AND message_type = 'room.message'`, [roomId]);
  assert.equal(stored.rowCount, 1);
  const again = await post(port, `/v1/rooms/${roomId}/messages`, { text: 'race', idempotency_key: 'racing' });
  assert.equal(again.status, 200);
  assert.equal(again.body.message_id, a.body.message_id);
});
