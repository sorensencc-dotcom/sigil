import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import pg from 'pg';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { PostgresRepository } from './postgres-repository.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const migrationPath = new URL('../../migrations/020_stream_sequence.sql', import.meta.url);

async function freshRepository(t) {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await applyMigrations(connectionString, { reset: true });
  return { pool, repository: new PostgresRepository({ pool }) };
}

async function seedStream(pool) {
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = {
    senderOwnerId: `usr_sender_${suffix}`,
    recipientOwnerId: `usr_recipient_${suffix}`,
    senderEndpointId: `ep_sender_${suffix}`,
    recipientEndpointId: `ep_recipient_${suffix}`,
    conversationId: `conv_${suffix}`,
  };
  await pool.query(
    `INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', now()), ($2, 'active', now());
     INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
     VALUES ($3, $1, 'test', $3, 'sender', 'active', now()), ($4, $2, 'test', $4, 'recipient', 'active', now());
     INSERT INTO conversations (conversation_id, kind, created_by, created_at) VALUES ($5, 'direct', $1, now());`,
    [ids.senderOwnerId, ids.recipientOwnerId, ids.senderEndpointId, ids.recipientEndpointId, ids.conversationId],
  );
  return ids;
}

function acceptedRow(ids, { messageId, streamSeq = null }) {
  const now = new Date().toISOString();
  return {
    streamSeq,
    envelope: {
      protocol: 'sigil/1.0',
      message_id: messageId,
      conversation_id: ids.conversationId,
      message_type: 'message',
      sender: { endpoint_id: ids.senderEndpointId, owner_id: ids.senderOwnerId },
      recipient: { endpoint_id: ids.recipientEndpointId },
      body: { text: 'test' },
      context_refs: [],
      capabilities: [],
      correlation_id: null,
      idempotency_key: `idem_${messageId}`,
      created_at: now,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: { algorithm: 'Ed25519', key_id: 'key_test', value: 'signature' },
    },
    canonical_hash: `hash_${messageId}`,
  };
}

test('020 migration exists and the repository exposes assignStreamSequence', async () => {
  const migrationExists = await fs.access(migrationPath).then(() => true, () => false);
  const methodExists = typeof PostgresRepository.prototype.assignStreamSequence === 'function';
  assert.equal(migrationExists && methodExists, true, '020 migration and assignStreamSequence must exist');
});

test('020 applies stream sequence schema and its partial unique index', { skip: !connectionString }, async (t) => {
  const { pool } = await freshRepository(t);
  await applyMigrations(connectionString);

  const columns = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name IN ('stream_sequences', 'envelopes') AND column_name IN ('next_seq', 'stream_seq')
     ORDER BY table_name, column_name`,
  );
  assert.deepEqual(columns.rows, [
    { column_name: 'stream_seq', data_type: 'bigint' },
    { column_name: 'next_seq', data_type: 'bigint' },
  ]);
  const index = await pool.query(`SELECT pg_get_indexdef('envelopes_stream_seq_idx'::regclass) AS definition`);
  assert.match(index.rows[0].definition, /ON public\.envelopes USING btree \(sender_endpoint_id, conversation_id, stream_seq\) WHERE \(stream_seq IS NOT NULL\)/);
});

test('assignStreamSequence starts at 1, is contiguous under concurrency, and rolls back with its transaction', { skip: !connectionString }, async (t) => {
  const { pool, repository } = await freshRepository(t);
  const ids = await seedStream(pool);

  const first = await repository.withTransaction((client) =>
    repository.assignStreamSequence(client, ids.senderEndpointId, ids.conversationId),
  );
  assert.equal(first, 1n);

  const concurrent = await Promise.all(Array.from({ length: 12 }, () =>
    repository.withTransaction((client) => repository.assignStreamSequence(client, ids.senderEndpointId, ids.conversationId)),
  ));
  assert.deepEqual([...concurrent].sort((a, b) => Number(a - b)), Array.from({ length: 12 }, (_, index) => BigInt(index + 2)));

  const rollbackIds = await seedStream(pool);
  await assert.rejects(repository.withTransaction(async (client) => {
    assert.equal(await repository.assignStreamSequence(client, rollbackIds.senderEndpointId, rollbackIds.conversationId), 1n);
    throw new Error('force rollback');
  }));
  assert.equal(
    await repository.withTransaction((client) => repository.assignStreamSequence(client, rollbackIds.senderEndpointId, rollbackIds.conversationId)),
    1n,
  );
});

test('listInbox preserves NULL streamSeq when disabled and returns assigned streamSeq', { skip: !connectionString }, async (t) => {
  const { pool, repository } = await freshRepository(t);
  const ids = await seedStream(pool);
  const nullMessageId = `msg_null_${crypto.randomUUID()}`;
  const sequencedMessageId = `msg_seq_${crypto.randomUUID()}`;
  await repository.persistAcceptedEnvelope(acceptedRow(ids, { messageId: nullMessageId }));
  await repository.persistAcceptedEnvelope(acceptedRow(ids, { messageId: sequencedMessageId, streamSeq: 7n }));

  const inbox = await repository.listInbox(ids.recipientEndpointId);
  const byMessageId = new Map(inbox.map((item) => [item.message_id, item]));
  assert.equal(byMessageId.get(nullMessageId).streamSeq, null);
  assert.equal(byMessageId.get(sequencedMessageId).streamSeq, '7');
});
