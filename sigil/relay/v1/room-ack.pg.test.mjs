import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('postgres acknowledgeRoomDeliveries moves only the caller\'s rows up to the bound', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const human = `usr_ack_${suffix}`;
  const ep = { web: `ep_web_${suffix}`, claude: `ep_claude_${suffix}`, codex: `ep_codex_${suffix}` };
  const keyId = `key_web_${suffix}`;
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [human]);
  for (const [runtime, endpointId] of Object.entries(ep)) {
    await pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at) VALUES ($1, $2, $3, $4, $3, 'active', NOW())`, [endpointId, human, runtime, `install_${endpointId}`]);
  }
  await pool.query(`INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())`, [keyId, ep.web, Buffer.alloc(32, 1)]);
  const repository = new PostgresRepository({ pool });
  const now = new Date();
  const rooms = [`room_a_${suffix}`, `room_b_${suffix}`];
  for (const [i, conversationId] of rooms.entries()) {
    await repository.createRoom({ conversationId, workspaceId: `ws_${human}`, name: `r${i}_${suffix}`, createdByHumanId: human, ownerEndpointId: ep.web, now });
  }
  const post = async (conversationId, n, roomSeq) => {
    const messageId = `msg_${n}_${conversationId}`;
    const envelope = {
      protocol: 'sigil/1', message_id: messageId, conversation_id: conversationId, message_type: 'room.message',
      sender: { endpoint_id: ep.web, owner_id: human }, broadcast_scope: { conversation_id: conversationId },
      body: { text: 'hi' }, context_refs: [], capabilities: [], correlation_id: null, idempotency_key: `idem_${messageId}`,
      created_at: now.toISOString(), expires_at: new Date(now.getTime() + 600_000).toISOString(),
      signature: { algorithm: 'Ed25519', key_id: keyId, value: 'sig' },
    };
    await repository.withTransaction((client) => repository.persistAcceptedEnvelope({ envelope, canonical_hash: 'h', action_hash: 'h', canonical_bytes: Buffer.from('c'), roomSeq, roomFanout: [ep.claude, ep.codex] }, client));
    return messageId;
  };
  const m1 = await post(rooms[0], 1, 1n);
  const m2 = await post(rooms[0], 2, 2n);
  const m3 = await post(rooms[0], 3, 3n);
  const other = await post(rooms[1], 1, 1n);
  const state = async (messageId, endpointId) => (await pool.query('SELECT state FROM deliveries WHERE message_id = $1 AND recipient_endpoint_id = $2', [messageId, endpointId])).rows[0].state;
  await pool.query(`UPDATE deliveries SET state = 'delivered' WHERE message_id = $1 AND recipient_endpoint_id = $2`, [m2, ep.claude]);
  await pool.query(`UPDATE deliveries SET state = 'processing' WHERE message_id = $1 AND recipient_endpoint_id = $2`, [m3, ep.claude]);
  await pool.query(`UPDATE deliveries SET state = 'processed' WHERE message_id = $1 AND recipient_endpoint_id = $2`, [other, ep.claude]);

  const moved = await repository.acknowledgeRoomDeliveries({ conversationId: rooms[0], endpointId: ep.claude, upToRoomSeq: 2n, now });
  assert.deepEqual(moved.map((r) => [r.message_id, r.sender_endpoint_id, r.state]).sort(), [[m1, ep.web, 'acknowledged'], [m2, ep.web, 'acknowledged']].sort());
  assert.equal(await state(m1, ep.claude), 'acknowledged');
  assert.equal(await state(m2, ep.claude), 'acknowledged');
  assert.equal(await state(m3, ep.claude), 'processing', 'above the bound or in another state: untouched');
  assert.equal(await state(other, ep.claude), 'processed', 'a different room: untouched');
  assert.equal(await state(m1, ep.codex), 'queued', "another endpoint's delivery: untouched");

  const acks = await pool.query('SELECT delivery_id FROM delivery_acknowledgements WHERE endpoint_id = $1', [ep.claude]);
  assert.equal(acks.rowCount, 2);
  const audits = await pool.query(`SELECT subject_id FROM audit_events WHERE event_type = 'delivery.acknowledged' AND endpoint_id = $1 AND conversation_id = $2`, [ep.claude, rooms[0]]);
  assert.equal(audits.rowCount, 2);

  assert.deepEqual(await repository.acknowledgeRoomDeliveries({ conversationId: rooms[0], endpointId: ep.claude, upToRoomSeq: 2n, now }), []);
  assert.equal((await pool.query(`SELECT 1 FROM audit_events WHERE event_type = 'delivery.acknowledged' AND endpoint_id = $1`, [ep.claude])).rowCount, 2, 'a repeat call writes no audit rows');
});
