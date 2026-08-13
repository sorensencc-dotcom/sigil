import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('migration and repository persist an envelope in live PostgreSQL', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());

  const migrationPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations/001_initial.sql');
  await pool.query(await fs.readFile(migrationPath, 'utf8'));

  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('usr_1', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('ep_codex', 'usr_1', 'codex', 'install_codex', 'Codex', 'active', NOW()),
             ('ep_claude', 'usr_1', 'claude', 'install_claude', 'Claude', 'active', NOW());
    INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
      VALUES ('key_1', 'ep_codex', 'Ed25519', decode('00', 'hex'), 'active', NOW());
    INSERT INTO conversations (conversation_id, kind, created_by, created_at)
      VALUES ('conv_1', 'direct', 'usr_1', NOW());
  `);

  const envelope = {
    message_id: 'msg_live_1', conversation_id: 'conv_1', protocol: 'sigil/1', message_type: 'task.request',
    sender: { endpoint_id: 'ep_codex', owner_id: 'usr_1' }, recipient: { endpoint_id: 'ep_claude' },
    body: { task_id: 'task_live_1' }, context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: 'send_live_1', expires_at: '2030-01-01T00:00:00Z', created_at: '2029-12-31T12:00:00Z',
    signature: { algorithm: 'Ed25519', key_id: 'key_1', value: 'sig' }
  };

  const row = await new PostgresRepository({ pool }).persistAcceptedEnvelope({
    envelope, canonical_bytes: Buffer.from('{"message_id":"msg_live_1"}'), action_hash: 'sha256:live'
  });
  assert.deepEqual(row, { message_id: 'msg_live_1' });

  const persisted = await pool.query(
    'SELECT message_id, envelope_status, sender_endpoint_id, recipient_endpoint_id, canonical_bytes, action_hash FROM envelopes WHERE message_id = $1',
    ['msg_live_1']
  );
  assert.equal(persisted.rowCount, 1);
  assert.equal(persisted.rows[0].envelope_status, 'accepted');
  assert.equal(persisted.rows[0].sender_endpoint_id, 'ep_codex');
  assert.equal(persisted.rows[0].recipient_endpoint_id, 'ep_claude');
  assert.equal(persisted.rows[0].canonical_bytes.toString(), '{"message_id":"msg_live_1"}');
  assert.equal(persisted.rows[0].action_hash, 'sha256:live');
});
