import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { ConnectorDatabase } from './connector-db-adapter.mjs';
import { WebSocketConnectionManager } from './connector-ws-manager.mjs';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Test fixture providing a local mock relay and temporary SQLite database.
 */
async function setupTestEnvironment() {
  const tmpDbPath = join(tmpdir(), `test-connector-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const tmpSchemaPath = join(tmpdir(), `test-schema-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);

  const ddl = `
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS connector_profiles (
      profile_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      relay_url TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      secure_key_reference TEXT NOT NULL,
      secure_token_reference TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS inbox_messages (
      message_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES connector_profiles(profile_id),
      conversation_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      sender_endpoint_id TEXT NOT NULL,
      body_json TEXT NOT NULL,
      canonical_hash TEXT NOT NULL,
      signature_value TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reconciled_at TEXT NOT NULL,
      viewed_state TEXT DEFAULT 'unread',
      processing_state TEXT DEFAULT 'received'
    );

    CREATE TABLE IF NOT EXISTS outbox_messages (
      outbox_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES connector_profiles(profile_id),
      message_id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      recipient_endpoint_id TEXT,
      body_json TEXT NOT NULL,
      canonical_hash TEXT NOT NULL,
      signature_value TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      attempts INTEGER DEFAULT 0,
      last_attempt_at TEXT,
      failure_code TEXT,
      delivery_state TEXT DEFAULT 'queued'
    );

    CREATE TABLE IF NOT EXISTS context_cache (
      integrity_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      local_storage_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS local_approvals (
      approval_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES connector_profiles(profile_id),
      action_hash TEXT NOT NULL,
      capability TEXT NOT NULL,
      scope TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      decision_signature TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      decided_at TEXT
    );
  `;

  writeFileSync(tmpSchemaPath, ddl, 'utf8');

  // Start HTTP and Mock WebSocket Relay Server
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const db = new ConnectorDatabase(tmpDbPath, tmpSchemaPath);
  const profileId = 'prof_tester_001';
  const endpointId = 'ep_tester_001';

  db.upsertProfile({
    profile_id: profileId,
    owner_id: 'user_001',
    endpoint_id: endpointId,
    display_name: 'Test Endpoint',
    relay_url: `ws://127.0.0.1:${port}/v1/stream`,
    status: 'active',
    secure_key_reference: 'trm://keys/test_001',
    secure_token_reference: 'trm://tokens/test_001',
  });

  return {
    db,
    profileId,
    endpointId,
    server,
    wss,
    port,
    async cleanup() {
      db.close();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
      try {
        unlinkSync(tmpDbPath);
        unlinkSync(tmpSchemaPath);
      } catch {
        // Ignore cleanup deletion errors on Windows file locks
      }
    },
  };
}

// =====================================================================
// Integration Tests
// =====================================================================

test('establishes authenticated connection to relay', async () => {
  const env = await setupTestEnvironment();
  let receivedAuthHeader = '';

  env.wss.once('connection', (ws, req) => {
    receivedAuthHeader = req.headers['authorization'];
  });

  const manager = new WebSocketConnectionManager({
    db: env.db,
    profileId: env.profileId,
    bearerToken: 'secret_token_123',
    heartbeatIntervalMs: 5000,
    outboxSweepIntervalMs: 1000,
  });

  await new Promise((resolve) => {
    manager.once('connected', resolve);
    manager.start();
  });

  assert.equal(manager.isConnected, true);
  assert.equal(receivedAuthHeader, 'Bearer secret_token_123');

  manager.close();
  await env.cleanup();
});

test('enforces durable-before-ack on incoming envelope deliveries', async () => {
  const env = await setupTestEnvironment();
  let relayAckReceived = false;

  env.wss.once('connection', (ws) => {
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.action === 'acknowledge' && frame.payload.message_id === 'msg_inbound_001') {
        relayAckReceived = true;
      }
    });

    // Simulate inbound relay delivery frame
    ws.send(
      JSON.stringify({
        action: 'delivery',
        payload: {
          message_id: 'msg_inbound_001',
          conversation_id: 'conv_001',
          message_type: 'task.request',
          sender: 'ep_remote_sender',
          body: { prompt: 'Run data transformation' },
          canonical_hash: 'sha256:abcd1234',
          signature_value: 'sig_valid_001',
          expires_at: '2026-12-31T23:59:59Z',
          created_at: '2026-08-20T22:00:00Z',
        },
      })
    );
  });

  const manager = new WebSocketConnectionManager({
    db: env.db,
    profileId: env.profileId,
    bearerToken: 'secret_token_123',
  });

  await new Promise((resolve) => {
    manager.once('message_received', resolve);
    manager.start();
  });

  // Verify message persisted to SQLite BEFORE relay was acknowledged
  const savedRow = env.db.getInboxMessage('msg_inbound_001');
  assert.notEqual(savedRow, null);
  assert.equal(savedRow.message_id, 'msg_inbound_001');
  assert.equal(savedRow.processing_state, 'received');
  assert.equal(savedRow.sender_endpoint_id, 'ep_remote_sender');

  // Allow next tick for socket acknowledge transmission
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(relayAckReceived, true);

  manager.close();
  await env.cleanup();
});

test('flushes outbound queue and updates delivery states from receipt stream', async () => {
  const env = await setupTestEnvironment();
  let submittedFrame = null;

  env.wss.once('connection', (ws) => {
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.action === 'submit') {
        submittedFrame = frame;

        // Relay responds with an asynchronous delivery receipt
        ws.send(
          JSON.stringify({
            action: 'receipt',
            payload: {
              message_id: frame.payload.message_id,
              state: 'delivered',
              failure_code: null,
            },
          })
        );
      }
    });
  });

  // Enqueue outbound message into SQLite outbox
  env.db.queueOutboundMessage('out_001', env.profileId, {
    message_id: 'msg_outbound_001',
    conversation_id: 'conv_001',
    message_type: 'task.result',
    recipient: { endpoint_id: 'ep_remote_receiver' },
    body: { status: 'completed' },
    canonical_hash: 'sha256:5678efgh',
    signature_value: 'sig_valid_002',
    idempotency_key: 'idem_key_001',
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });

  const manager = new WebSocketConnectionManager({
    db: env.db,
    profileId: env.profileId,
    bearerToken: 'secret_token_123',
    outboxSweepIntervalMs: 50,
  });

  await new Promise((resolve) => {
    manager.once('receipt_processed', resolve);
    manager.start();
  });

  assert.notEqual(submittedFrame, null);
  assert.equal(submittedFrame.payload.message_id, 'msg_outbound_001');

  // Verify delivery state progression recorded in database
  const outboxItem = env.db.statements.getPendingOutboundQueue.all(new Date().toISOString());
  assert.equal(outboxItem.length, 0); // No longer in 'queued' state

  const updatedRecord = env.db.db
    .prepare('SELECT * FROM outbox_messages WHERE message_id = ?')
    .get('msg_outbound_001');
  assert.equal(updatedRecord.delivery_state, 'delivered');
  assert.equal(updatedRecord.attempts, 1);

  manager.close();
  await env.cleanup();
});
