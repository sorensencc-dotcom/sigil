import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function seed(pool, suffix) {
  const ids = { human: `usr_rooms_${suffix}`, web: `ep_web_${suffix}`, claude: `ep_claude_${suffix}`, codex: `ep_codex_${suffix}`, webKey: `key_web_${suffix}` };
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [ids.human]);
  for (const [endpointId, runtime] of [[ids.web, 'web'], [ids.claude, 'claude'], [ids.codex, 'codex']]) {
    await pool.query(
      `INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
       VALUES ($1, $2, $3, $4, $3, 'active', NOW())`,
      [endpointId, ids.human, runtime, `install_${endpointId}`],
    );
  }
  await pool.query(
    `INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
     VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())`,
    [ids.webKey, ids.web, Buffer.alloc(32, 1)],
  );
  return ids;
}

test('postgres room lifecycle, ordering, and fan-out', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = await seed(pool, suffix);
  const repository = new PostgresRepository({ pool });
  const conversationId = `room_${suffix}`;
  const now = new Date();

  const room = await repository.createRoom({ conversationId, workspaceId: `ws_${ids.human}`, name: `build_${suffix}`, createdByHumanId: ids.human, ownerEndpointId: ids.web, now });
  assert.equal(room.conversation_id, conversationId);
  await assert.rejects(repository.createRoom({ conversationId: `room2_${suffix}`, workspaceId: `ws_${ids.human}`, name: `build_${suffix}`, createdByHumanId: ids.human, ownerEndpointId: ids.web, now }), { code: 'ROOM_NAME_TAKEN' });

  await repository.addRoomMember({ conversationId, endpointId: ids.claude, role: 'member', responseMode: 'joins', addedByHumanId: ids.human, now });
  await repository.addRoomMember({ conversationId, endpointId: ids.codex, role: 'member', responseMode: 'mentions_only', addedByHumanId: ids.human, now });
  await assert.rejects(repository.addRoomMember({ conversationId, endpointId: ids.codex, role: 'member', addedByHumanId: ids.human, now }), { code: 'ROOM_MEMBER_EXISTS' });
  assert.equal((await repository.lookupRoomMember(conversationId, ids.web)).role, 'owner');
  assert.deepEqual((await repository.listRoomMembers(conversationId)).map((m) => m.endpoint_id).sort(), [ids.claude, ids.codex, ids.web].sort());
  assert.deepEqual((await repository.listRoomsForEndpoint(ids.claude)).map((r) => r.conversation_id), [conversationId]);

  const persisted = await repository.withTransaction(async (client) => {
    const roomSeq = await repository.assignRoomSequence(client, conversationId);
    assert.equal(roomSeq, 1n);
    const envelope = {
      protocol: 'sigil/1', message_id: `msg_${suffix}`, conversation_id: conversationId, message_type: 'room.message',
      sender: { endpoint_id: ids.web, owner_id: ids.human }, broadcast_scope: { conversation_id: conversationId },
      body: { text: 'hi' }, context_refs: [], capabilities: [], correlation_id: null, idempotency_key: `idem_${suffix}`,
      created_at: now.toISOString(), expires_at: new Date(now.getTime() + 600_000).toISOString(),
      signature: { algorithm: 'Ed25519', key_id: ids.webKey, value: 'sig' },
    };
    return repository.persistAcceptedEnvelope({ envelope, canonical_hash: 'h', action_hash: 'h', canonical_bytes: Buffer.from('canonical'), roomSeq, roomFanout: [ids.claude, ids.codex] }, client);
  });
  assert.deepEqual(persisted.fanout.map((f) => f.endpoint_id).sort(), [ids.claude, ids.codex].sort());
  const deliveries = await pool.query('SELECT recipient_endpoint_id FROM deliveries WHERE message_id = $1 ORDER BY recipient_endpoint_id', [`msg_${suffix}`]);
  assert.deepEqual(deliveries.rows.map((r) => r.recipient_endpoint_id), [ids.claude, ids.codex].sort());
  const members = await pool.query('SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1', [conversationId]);
  assert.equal(members.rows[0].n, 3, 'persisting a room message must not add members');

  const messages = await repository.listRoomMessages(conversationId, 0n, 100);
  assert.deepEqual(messages.map((m) => [m.room_seq, m.message_id]), [['1', `msg_${suffix}`]]);
  assert.equal(messages[0].envelope.body.text, 'hi');
  assert.equal(messages[0].canonical_bytes, Buffer.from('canonical').toString('base64url'), 'history carries the stored signed bytes as base64url');

  await assert.rejects(repository.withTransaction(async (client) => {
    await repository.assignRoomSequence(client, conversationId);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(await repository.withTransaction((client) => repository.assignRoomSequence(client, conversationId)), 2n, 'a rolled-back assignment must not leave a gap');

  assert.equal(await repository.removeRoomMember({ conversationId, endpointId: ids.codex, now }), true);
  assert.equal(await repository.lookupRoomMember(conversationId, ids.codex), null);
});
