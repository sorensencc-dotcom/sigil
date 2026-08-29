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
  const schemaPath = new URL('./connector-schema.sql', import.meta.url);

  // Start HTTP and Mock WebSocket Relay Server
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const db = new ConnectorDatabase(tmpDbPath, schemaPath);
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

test('ConnectorWebSocketManager requires database adapter on construction', () => {
  assert.throws(
    () => new WebSocketConnectionManager({
      profileId: 'prof_test',
      bearerToken: 'secret',
      wsUrl: 'ws://127.0.0.1:9999/v1/stream',
    }),
    /Database adapter \(db\/dbAdapter\) is required/
  );
});

test('ConnectorWebSocketManager fails closed without ack when database intake fails', async () => {
  const env = await setupTestEnvironment();
  let relayAckReceived = false;

  env.wss.once('connection', (ws) => {
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.action === 'acknowledge') {
        relayAckReceived = true;
      }
    });

    // Simulate inbound delivery with missing message_id
    ws.send(
      JSON.stringify({
        action: 'delivery',
        payload: {
          // message_id omitted to trigger fail-closed intake error
          conversation_id: 'conv_err',
          message_type: 'task.request',
          body: {}
        }
      })
    );
  });

  const manager = new WebSocketConnectionManager({
    db: env.db,
    profileId: env.profileId,
    bearerToken: 'secret_token_123',
  });

  const errorCaptured = new Promise((resolve) => {
    manager.once('error', resolve);
  });

  manager.start();
  await errorCaptured;

  // Wait a tick to confirm no acknowledge frame was transmitted
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(relayAckReceived, false);

  manager.close();
  await env.cleanup();
});

