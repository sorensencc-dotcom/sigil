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

async function seedRoomMessage(pool, repository, suffix) {
  const ids = await seed(pool, suffix);
  const conversationId = `room_${suffix}`;
  const now = new Date();
  await repository.createRoom({ conversationId, workspaceId: `ws_${ids.human}`, name: `rcpt_${suffix}`, createdByHumanId: ids.human, ownerEndpointId: ids.web, now });
  await repository.addRoomMember({ conversationId, endpointId: ids.claude, role: 'member', responseMode: 'joins', addedByHumanId: ids.human, now });
  await repository.addRoomMember({ conversationId, endpointId: ids.codex, role: 'member', responseMode: 'mentions_only', addedByHumanId: ids.human, now });

  await repository.withTransaction(async (client) => {
    const roomSeq = await repository.assignRoomSequence(client, conversationId);
    const envelope = {
      protocol: 'sigil/1', message_id: `msg_${suffix}`, conversation_id: conversationId, message_type: 'room.message',
      sender: { endpoint_id: ids.web, owner_id: ids.human }, broadcast_scope: { conversation_id: conversationId },
      body: { text: 'hi' }, context_refs: [], capabilities: [], correlation_id: null, idempotency_key: `idem_${suffix}`,
      created_at: now.toISOString(), expires_at: new Date(now.getTime() + 600_000).toISOString(),
      signature: { algorithm: 'Ed25519', key_id: ids.webKey, value: 'sig' },
    };
    return repository.persistAcceptedEnvelope({ envelope, canonical_hash: 'h', action_hash: 'h', canonical_bytes: Buffer.from('canonical'), roomSeq, roomFanout: [ids.codex, ids.claude] }, client);
  });
  return { ids, messageId: `msg_${suffix}` };
}

test('postgres listReceiptsForMessage orders rows and initialDeliveryState is queued', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const repository = new PostgresRepository({ pool });
  assert.equal(repository.initialDeliveryState, 'queued');

  const { ids } = await seedRoomMessage(pool, repository, suffix);

  const rows = await repository.listReceiptsForMessage(`msg_${suffix}`);
  assert.deepEqual(rows.map((r) => r.recipient_endpoint_id), [ids.claude, ids.codex].sort());
  assert.ok(rows.every((r) => r.state === 'queued'), 'Postgres inserts deliveries as queued');
  assert.deepEqual(await repository.listReceiptsForMessage('msg_missing'), []);
});

test('postgres listInbox flags rows it flipped from queued to delivered, once', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const repository = new PostgresRepository({ pool });
  const { ids, messageId } = await seedRoomMessage(pool, repository, suffix);

  const first = await repository.listInbox(ids.claude);
  assert.equal(first.length, 1);
  assert.equal(first[0].flipped, true, 'first poll moves queued to delivered');
  const [row] = await repository.listReceiptsForMessage(messageId).then((rows) => rows.filter((r) => r.recipient_endpoint_id === ids.claude));
  assert.equal(row.state, 'delivered');
  assert.ok(row.delivered_at, 'the flip stamps delivered_at');

  const second = await repository.listInbox(ids.claude);
  assert.equal(second.length, 1);
  assert.equal(second[0].flipped, false, 'a row that is already delivered is not flagged again');
});
