// Pins the history contract the browser relies on: listRoomMessages returns
// room.event rows alongside room.message rows (spec line 106).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { emitRoomEvent } from './room-events.mjs';
import { PostgresRepository } from './postgres-repository.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createIdentity } from '../../cli/identity.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { ROOM_SYSTEM_ENDPOINT_ID, ROOM_SYSTEM_OWNER_ID } from './room-system-identity.mjs';

const NOW = new Date('2026-10-02T12:01:00.000Z');

test('memory history returns both a room.message and a room.event row', async () => {
  const web = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_web', { owner_id: 'usr_chris', status: 'active', kind: 'human', key_id: 'key_web', public_key: web.publicKey }]]);
  const repository = createMemoryRepository({ registry: registered });
  const system = createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' });
  await repository.ensureRoomSystemEndpoint({ identity: system, now: NOW });
  await repository.createRoom({ conversationId: 'room_1', workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
  const envelope = {
    protocol: 'sigil/1', message_id: 'msg_1', conversation_id: 'room_1', message_type: 'room.message',
    sender: { endpoint_id: 'ep_web', owner_id: 'usr_chris' }, broadcast_scope: { conversation_id: 'room_1' },
    body: { text: 'hi' }, context_refs: [], capabilities: [], correlation_id: null, idempotency_key: 'idem_1',
    created_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-02T13:00:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: 'key_web', value: '' },
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), web.privateKey).toString('base64url');
  assert.equal((await acceptEnvelopeAsync(envelope, { repository, registered, now: NOW })).status, 202);
  await emitRoomEvent({ identity: system, repository, client: null, room: await repository.lookupRoom('room_1'), body: { kind: 'router_decision', endpoint_ids: [], reason: 'r' }, idempotencyKey: 'evt_1', now: NOW, inboxDepthLimit: 100, registered });
  const history = await repository.listRoomMessages('room_1', 0n, 100);
  assert.deepEqual(history.map((row) => row.envelope.message_type), ['room.message', 'room.event']);
});

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('postgres history returns both a room.message and a room.event row', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  const run = crypto.randomUUID().replaceAll('-', '_');
  const roomId = `room_${run}`;
  const human = `usr_hist_${run}`;
  const web = `ep_web_${run}`;
  t.after(async () => {
    const mine = `SELECT message_id FROM envelopes WHERE conversation_id = '${roomId}'`;
    await pool.query(`DELETE FROM deliveries WHERE message_id IN (${mine})`);
    await pool.query(`DELETE FROM audit_events WHERE subject_id IN (${mine})`);
    await pool.query(`DELETE FROM idempotency_keys WHERE message_id IN (${mine})`);
    await pool.query(`DELETE FROM envelopes WHERE conversation_id = '${roomId}'`);
    await pool.end();
  });
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [human]);
  await pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at) VALUES ($1, $2, 'web', $3, 'web', 'active', NOW())`, [web, human, `install_${web}`]);
  const repository = new PostgresRepository({ pool });
  const system = createIdentity({ ownerId: ROOM_SYSTEM_OWNER_ID, endpointId: ROOM_SYSTEM_ENDPOINT_ID, kind: 'system' });
  await repository.ensureRoomSystemEndpoint({ identity: system, now: NOW });
  await repository.createRoom({ conversationId: roomId, workspaceId: `ws_${human}`, name: `hist_${run}`, createdByHumanId: human, ownerEndpointId: web, now: NOW });
  const room = await repository.lookupRoom(roomId);
  const keys = crypto.generateKeyPairSync('ed25519');
  await pool.query(`INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())`, [`key_${web}`, web, keys.publicKey.export({ type: 'spki', format: 'der' })]);
  const registered = new Map([[web, { owner_id: human, status: 'active', kind: 'human', key_id: `key_${web}`, public_key: keys.publicKey }]]);
  const envelope = {
    protocol: 'sigil/1', message_id: `msg_${run}`, conversation_id: roomId, message_type: 'room.message',
    sender: { endpoint_id: web, owner_id: human }, broadcast_scope: { conversation_id: roomId },
    body: { text: 'hi' }, context_refs: [], capabilities: [], correlation_id: null, idempotency_key: `idem_${run}`,
    created_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-02T13:00:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: `key_${web}`, value: '' },
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.privateKey).toString('base64url');
  assert.equal((await acceptEnvelopeAsync(envelope, { repository, registered, now: NOW })).status, 202);
  await repository.withTransaction((client) => emitRoomEvent({ identity: system, repository, client, room, body: { kind: 'router_decision', endpoint_ids: [], reason: 'r' }, idempotencyKey: `evt_${run}`, now: NOW, inboxDepthLimit: 100, registered }));
  const history = await repository.listRoomMessages(roomId, 0n, 100);
  assert.deepEqual(history.map((row) => row.envelope.message_type), ['room.message', 'room.event']);
});
