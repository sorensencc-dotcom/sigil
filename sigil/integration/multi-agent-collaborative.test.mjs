import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';

import { createIdentity, identityKeys } from '../cli/identity.mjs';
import { createMemoryRepository } from '../cli/memory-repository.mjs';
import { LocalOutbox } from '../connectors/v1/local-outbox.mjs';
import { LocalInbox } from '../connectors/v1/local-inbox.mjs';
import { RelayClient } from '../connectors/v1/relay-client.mjs';
import { ConnectorDatabase } from '../connectors/v1/connector-db-adapter.mjs';
import { createRelayServer } from '../relay/v1/http-server.mjs';
import { createStreamServer } from '../relay/v1/stream-server.mjs';
import { hashBearerToken } from '../relay/v1/transport-auth.mjs';

const schemaPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'connectors',
  'v1',
  'connector-schema.sql'
);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function openStreamSocket(url, bearerToken) {
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${bearerToken}` }
  });
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function createEventCollector(socket) {
  const events = [];
  const waiters = [];

  socket.on('message', (raw) => {
    try {
      const parsed = JSON.parse(raw.toString());
      events.push(parsed);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const { predicate, resolve } = waiters[i];
        if (predicate(parsed)) {
          waiters.splice(i, 1);
          resolve(parsed);
        }
      }
    } catch {}
  });

  return {
    waitFor(predicate, timeoutMs = 5000) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === resolve);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`Timed out waiting for socket event after ${timeoutMs}ms (buffered events: ${JSON.stringify(events)})`));
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (val) => {
            clearTimeout(timer);
            resolve(val);
          }
        });
      });
    },
    get events() { return events; }
  };
}

function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once('close', resolve);
    socket.close();
  });
}

test('Multi-agent collaborative relay: end-to-end task delegation, streaming chunks, and receipt tracking', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-collab-test-'));
  const codexDbPath = path.join(tmpDir, 'codex.db');
  const claudeDbPath = path.join(tmpDir, 'claude.db');

  const codexDb = new ConnectorDatabase(codexDbPath, schemaPath);
  const claudeDb = new ConnectorDatabase(claudeDbPath, schemaPath);

  // 1. Initialize Identities & Cryptographic Keys for ep_codex and ep_claude
  const codexIdentity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_codex', kind: 'agent' });
  const claudeIdentity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_claude', kind: 'agent' });

  const codexKeys = identityKeys(codexIdentity);
  const claudeKeys = identityKeys(claudeIdentity);

  const codexEndpoint = {
    owner_id: codexIdentity.owner_id,
    endpoint_id: codexIdentity.endpoint_id,
    key_id: codexIdentity.key_id,
    kind: codexIdentity.kind,
    status: 'active',
    public_key: codexKeys.publicKey
  };

  const claudeEndpoint = {
    owner_id: claudeIdentity.owner_id,
    endpoint_id: claudeIdentity.endpoint_id,
    key_id: claudeIdentity.key_id,
    kind: claudeIdentity.kind,
    status: 'active',
    public_key: claudeKeys.publicKey
  };

  // Upsert local connector database profiles to satisfy foreign key constraints
  codexDb.upsertProfile({
    profile_id: 'prof_ep_codex',
    owner_id: codexIdentity.owner_id,
    endpoint_id: codexIdentity.endpoint_id,
    display_name: 'Codex Agent',
    relay_url: 'http://127.0.0.1:0',
    status: 'active',
    secure_key_reference: `key://${codexIdentity.key_id}`,
    secure_token_reference: `token://${codexIdentity.endpoint_id}`
  });

  claudeDb.upsertProfile({
    profile_id: 'prof_ep_claude',
    owner_id: claudeIdentity.owner_id,
    endpoint_id: claudeIdentity.endpoint_id,
    display_name: 'Claude Agent',
    relay_url: 'http://127.0.0.1:0',
    status: 'active',
    secure_key_reference: `key://${claudeIdentity.key_id}`,
    secure_token_reference: `token://${claudeIdentity.endpoint_id}`
  });

  // 2. Setup Memory Repository & Capabilities
  const repository = createMemoryRepository();
  const conversationId = 'conv_collab_01';

  // Grant task submission capability to ep_codex and ep_claude for this conversation
  await repository.createCapabilityGrant({
    grantId: 'grant_collab_codex',
    capability: 'sigil.task/submit',
    scope: `scope:conversation/${conversationId}`,
    grantedTo: 'ep_codex',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    now: new Date()
  });

  await repository.createCapabilityGrant({
    grantId: 'grant_collab_claude',
    capability: 'sigil.task/submit',
    scope: `scope:conversation/${conversationId}`,
    grantedTo: 'ep_claude',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    now: new Date()
  });

  const registry = new Map([
    ['ep_codex', codexEndpoint],
    ['ep_claude', claudeEndpoint]
  ]);

  const tokenHashes = new Map([
    [hashBearerToken(codexIdentity.relay_token), codexIdentity.endpoint_id],
    [hashBearerToken(claudeIdentity.relay_token), claudeIdentity.endpoint_id]
  ]);

  // 3. Launch HTTP Relay & WebSocket Stream Server
  let streamServer;
  const streamAdapter = {
    notify: (...args) => streamServer?.notify(...args),
    notifyReceipt: (...args) => streamServer?.notifyReceipt(...args),
    close: () => streamServer?.close()
  };

  const relayHttpServer = createRelayServer({
    registry,
    repository,
    tokenHashes,
    stream: streamAdapter
  });

  streamServer = createStreamServer({
    server: relayHttpServer,
    tokenHashes
  });

  const port = await listen(relayHttpServer);
  const relayUrl = `http://127.0.0.1:${port}`;
  const streamUrl = `ws://127.0.0.1:${port}/v1/stream`;

  const codexRelay = new RelayClient({ baseUrl: relayUrl, token: codexIdentity.relay_token });
  const claudeRelay = new RelayClient({ baseUrl: relayUrl, token: claudeIdentity.relay_token });

  const codexOutbox = new LocalOutbox({ privateKey: codexKeys.privateKey, endpoint: codexEndpoint });
  const claudeOutbox = new LocalOutbox({ privateKey: claudeKeys.privateKey, endpoint: claudeEndpoint });

  let codexSocket;
  let claudeSocket;

  try {
    // 4. Connect WebSocket streams and start event collectors
    codexSocket = await openStreamSocket(streamUrl, codexIdentity.relay_token);
    claudeSocket = await openStreamSocket(streamUrl, claudeIdentity.relay_token);

    const codexCollector = createEventCollector(codexSocket);
    const claudeCollector = createEventCollector(claudeSocket);

    // ------------------------------------------------------------------------
    // Step A: ep_codex delegates task.request to ep_claude with capability token
    // ------------------------------------------------------------------------
    const taskMessage = {
      protocol: 'sigil/1',
      message_id: `msg_task_${crypto.randomUUID()}`,
      conversation_id: conversationId,
      message_type: 'task.request',
      sender: codexEndpoint,
      recipient: claudeEndpoint,
      correlation_id: null,
      capabilities: ['sigil.task/submit'],
      context_refs: [{ uri: 'graft://ast/symbols/ConnectorWebSocketManager' }],
      body: {
        task_id: 'task_ast_analysis_01',
        instruction: 'Analyze AST liveness guarantees and report stream chunks.',
        parameters: { chunk_count: 3 }
      },
      idempotency_key: `idemp_${crypto.randomUUID()}`,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600000).toISOString()
    };

    const queuedTask = codexOutbox.queue(taskMessage);
    codexDb.queueOutboundMessage(`out_${queuedTask.envelope.message_id}`, `prof_ep_codex`, queuedTask.envelope);

    const submitResult = await codexRelay.sendEnvelope(queuedTask.envelope);
    assert.equal(submitResult.code, 'ACCEPTED');
    assert.equal(submitResult.duplicate, false);

    // Expect delivery notification on claude's stream
    const deliveredEvt = await claudeCollector.waitFor((evt) => evt.type === 'delivered');
    assert.ok(deliveredEvt.delivery_id);

    // ------------------------------------------------------------------------
    // Step B: ep_claude reconciles inbox, commits Durable-Before-Ack, and ACKs
    // ------------------------------------------------------------------------
    const claudeInboxPage = await claudeRelay.reconcileInbox('');
    assert.equal(claudeInboxPage.items.length, 1);
    const incomingTask = claudeInboxPage.items[0];

    assert.equal(incomingTask.envelope.message_id, queuedTask.envelope.message_id);
    assert.equal(incomingTask.envelope.body.task_id, 'task_ast_analysis_01');

    // 1. Commit durable intake into Claude's SQLite DB BEFORE sending acknowledgement
    claudeDb.commitDurableInboxIntake(incomingTask.envelope, 'prof_ep_claude', new Date().toISOString());
    const storedTask = claudeDb.getInboxMessage(incomingTask.envelope.message_id);
    assert.ok(storedTask, 'Message must be safely committed to SQLite store');

    // 2. Acknowledge delivery to relay
    await claudeRelay.acknowledge(incomingTask.delivery_id);

    // 3. Verify codex receives the real-time delivery.receipt over WebSocket
    const ackReceipt = await codexCollector.waitFor(
      (evt) => evt.type === 'delivery.receipt' && evt.state === 'acknowledged'
    );
    assert.equal(ackReceipt.message_id, queuedTask.envelope.message_id);
    assert.equal(ackReceipt.state, 'acknowledged');

    // Update codex outbox delivery state in SQLite
    codexDb.updateOutboxDeliveryState(queuedTask.envelope.message_id, {
      state: 'acknowledged',
      attemptIncrement: 1,
      lastAttemptAt: new Date().toISOString()
    });

    // ------------------------------------------------------------------------
    // Step C: ep_claude streams intermediate structured chunks to ep_codex
    // ------------------------------------------------------------------------
    const streamedChunks = [
      { chunk_index: 0, total_chunks: 3, stage: 'AST_EXTRACTION', details: 'Parsed AST node symbols' },
      { chunk_index: 1, total_chunks: 3, stage: 'GRAPH_ANALYSIS', details: 'Verified liveness call edges' },
      { chunk_index: 2, total_chunks: 3, stage: 'SYNTHESIS_COMPLETE', details: 'Synthesized telemetry metrics' }
    ];

    for (const chunk of streamedChunks) {
      const chunkMessage = {
        protocol: 'sigil/1',
        message_id: `msg_chunk_${chunk.chunk_index}_${crypto.randomUUID()}`,
        conversation_id: conversationId,
        message_type: 'chat.message',
        sender: claudeEndpoint,
        recipient: codexEndpoint,
        correlation_id: queuedTask.envelope.message_id,
        capabilities: ['sigil.task/submit'],
        context_refs: [],
        body: chunk,
        idempotency_key: `idemp_chunk_${chunk.chunk_index}_${crypto.randomUUID()}`,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString()
      };

      const signedChunk = claudeOutbox.queue(chunkMessage);

      const chunkSendRes = await claudeRelay.sendEnvelope(signedChunk.envelope);
      assert.equal(chunkSendRes.code, 'ACCEPTED');

      // Wait for chunk delivery notice on codex socket
      const chunkDeliveryEvt = await codexCollector.waitFor(
        (evt) => evt.type === 'delivered' && evt.delivery_id === signedChunk.envelope.message_id
      );
      assert.ok(chunkDeliveryEvt);

      // Codex receives and acknowledges chunk
      const codexInboxPage = await codexRelay.reconcileInbox('');
      const chunkItem = codexInboxPage.items.find((i) => i.envelope.message_id === signedChunk.envelope.message_id);
      assert.ok(chunkItem, `Codex must receive chunk ${chunk.chunk_index}`);
      assert.equal(chunkItem.envelope.body.chunk_index, chunk.chunk_index);

      // Persist in Codex DB and acknowledge
      codexDb.commitDurableInboxIntake(chunkItem.envelope, 'prof_ep_codex', new Date().toISOString());
      await codexRelay.acknowledge(chunkItem.delivery_id);
    }

    // ------------------------------------------------------------------------
    // Step D: ep_claude dispatches final task.result envelope
    // ------------------------------------------------------------------------
    const resultMessage = {
      protocol: 'sigil/1',
      message_id: `msg_res_${crypto.randomUUID()}`,
      conversation_id: conversationId,
      message_type: 'task.result',
      sender: claudeEndpoint,
      recipient: codexEndpoint,
      correlation_id: queuedTask.envelope.message_id,
      capabilities: [],
      context_refs: [],
      body: {
        task_id: 'task_ast_analysis_01',
        status: 'completed',
        summary: 'All 3 stream chunks verified and synthesized successfully.'
      },
      idempotency_key: `idemp_res_${crypto.randomUUID()}`,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600000).toISOString()
    };

    const signedResult = claudeOutbox.queue(resultMessage);
    const resultSendRes = await claudeRelay.sendEnvelope(signedResult.envelope);
    assert.equal(resultSendRes.code, 'ACCEPTED');

    await codexCollector.waitFor(
      (evt) => evt.type === 'delivered' && evt.delivery_id === signedResult.envelope.message_id
    );

    const finalInboxPage = await codexRelay.reconcileInbox('');
    const finalItem = finalInboxPage.items.find((i) => i.envelope.message_id === signedResult.envelope.message_id);
    assert.ok(finalItem);
    assert.equal(finalItem.envelope.body.status, 'completed');

    codexDb.commitDurableInboxIntake(finalItem.envelope, 'prof_ep_codex', new Date().toISOString());
    await codexRelay.acknowledge(finalItem.delivery_id);

  } finally {
    await closeSocket(codexSocket);
    await closeSocket(claudeSocket);
    await streamServer.close();
    await new Promise((resolve) => relayHttpServer.close(resolve));
    codexDb.close();
    claudeDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Multi-agent capability delegation chain and revocation boundary enforcement', async () => {
  const codexIdentity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_codex', kind: 'agent' });
  const claudeIdentity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_claude', kind: 'agent' });
  const reviewerIdentity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_reviewer', kind: 'agent' });

  const codexKeys = identityKeys(codexIdentity);
  const claudeKeys = identityKeys(claudeIdentity);
  const reviewerKeys = identityKeys(reviewerIdentity);

  const endpoint = (id, keys) => ({
    owner_id: id.owner_id,
    endpoint_id: id.endpoint_id,
    key_id: id.key_id,
    kind: id.kind,
    status: 'active',
    public_key: keys.publicKey
  });

  const registry = new Map([
    ['ep_codex', endpoint(codexIdentity, codexKeys)],
    ['ep_claude', endpoint(claudeIdentity, claudeKeys)],
    ['ep_reviewer', endpoint(reviewerIdentity, reviewerKeys)]
  ]);

  const repository = createMemoryRepository();
  const conversationId = 'conv_chain_delegation_01';

  // Step 1: Grant capability 'sigil.task/submit' to ep_claude
  const grant = await repository.createCapabilityGrant({
    grantId: 'grant_review_01',
    capability: 'sigil.task/submit',
    scope: `scope:conversation/${conversationId}`,
    grantedTo: 'ep_claude',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    now: new Date()
  });

  const claudeOutbox = new LocalOutbox({
    privateKey: claudeKeys.privateKey,
    endpoint: endpoint(claudeIdentity, claudeKeys)
  });

  const tokenHashes = new Map([
    [hashBearerToken(claudeIdentity.relay_token), claudeIdentity.endpoint_id],
    [hashBearerToken(reviewerIdentity.relay_token), reviewerIdentity.endpoint_id]
  ]);

  const relayServer = createRelayServer({
    registry,
    repository,
    tokenHashes
  });

  const port = await listen(relayServer);
  const relayUrl = `http://127.0.0.1:${port}`;
  const claudeRelay = new RelayClient({ baseUrl: relayUrl, token: claudeIdentity.relay_token });

  try {
    // Step 2: ep_claude dispatches review request using valid capability grant
    const validMessage = {
      protocol: 'sigil/1',
      message_id: `msg_rev_${crypto.randomUUID()}`,
      conversation_id: conversationId,
      message_type: 'task.request',
      sender: endpoint(claudeIdentity, claudeKeys),
      recipient: endpoint(reviewerIdentity, reviewerKeys),
      correlation_id: null,
      capabilities: ['sigil.task/submit'],
      context_refs: [{ uri: 'file://src/relay.mjs' }],
      body: { task_id: 'task_rev_01', instruction: 'Review diff: + console.log("reviewed");' },
      idempotency_key: `idemp_rev_${crypto.randomUUID()}`,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600000).toISOString()
    };

    const queued1 = claudeOutbox.queue(validMessage);
    const sendRes1 = await claudeRelay.sendEnvelope(queued1.envelope);
    assert.equal(sendRes1.code, 'ACCEPTED');

    // Step 3: Revoke capability grant
    await repository.revokeCapabilityGrant(grant.grant_id, { now: new Date() });

    // Step 4: ep_claude attempts to dispatch another request with revoked capability
    const revokedMessage = {
      protocol: 'sigil/1',
      message_id: `msg_rev_blocked_${crypto.randomUUID()}`,
      conversation_id: conversationId,
      message_type: 'task.request',
      sender: endpoint(claudeIdentity, claudeKeys),
      recipient: endpoint(reviewerIdentity, reviewerKeys),
      correlation_id: null,
      capabilities: ['sigil.task/submit'],
      context_refs: [{ uri: 'file://src/relay.mjs' }],
      body: { task_id: 'task_rev_02', instruction: 'Review diff: + console.log("unauthorized");' },
      idempotency_key: `idemp_rev_blocked_${crypto.randomUUID()}`,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600000).toISOString()
    };

    const queued2 = claudeOutbox.queue(revokedMessage);

    let rejectedError = null;
    try {
      await claudeRelay.sendEnvelope(queued2.envelope);
    } catch (err) {
      rejectedError = err;
    }

    assert.ok(rejectedError, 'Must reject envelope with revoked capability grant');
    assert.equal(rejectedError.status, 403);
    assert.equal(rejectedError.code, 'CAPABILITY_DENIED');

  } finally {
    await new Promise((resolve) => relayServer.close(resolve));
  }
});

test('Multi-agent tamper and replay attack rejection across stream channels', async () => {
  const codexIdentity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_codex', kind: 'agent' });
  const claudeIdentity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_claude', kind: 'agent' });

  const codexKeys = identityKeys(codexIdentity);
  const claudeKeys = identityKeys(claudeIdentity);

  const endpoint = (id, keys) => ({
    owner_id: id.owner_id,
    endpoint_id: id.endpoint_id,
    key_id: id.key_id,
    kind: id.kind,
    status: 'active',
    public_key: keys.publicKey
  });

  const registry = new Map([
    ['ep_codex', endpoint(codexIdentity, codexKeys)],
    ['ep_claude', endpoint(claudeIdentity, claudeKeys)]
  ]);

  const repository = createMemoryRepository();
  const tokenHashes = new Map([
    [hashBearerToken(codexIdentity.relay_token), codexIdentity.endpoint_id],
    [hashBearerToken(claudeIdentity.relay_token), claudeIdentity.endpoint_id]
  ]);

  const relayServer = createRelayServer({ registry, repository, tokenHashes });
  const port = await listen(relayServer);
  const relayUrl = `http://127.0.0.1:${port}`;

  const codexRelay = new RelayClient({ baseUrl: relayUrl, token: codexIdentity.relay_token });
  const codexOutbox = new LocalOutbox({ privateKey: codexKeys.privateKey, endpoint: endpoint(codexIdentity, codexKeys) });

  try {
    const validMessage = {
      protocol: 'sigil/1',
      message_id: `msg_security_${crypto.randomUUID()}`,
      conversation_id: 'conv_sec_01',
      message_type: 'chat.message',
      sender: endpoint(codexIdentity, codexKeys),
      recipient: endpoint(claudeIdentity, claudeKeys),
      correlation_id: null,
      capabilities: [],
      context_refs: [],
      body: { text: 'Legitimate encrypted directive' },
      idempotency_key: `idemp_sec_${crypto.randomUUID()}`,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600000).toISOString()
    };

    const queued = codexOutbox.queue(validMessage);

    // 1. First legitimate send passes
    const sendRes = await codexRelay.sendEnvelope(queued.envelope);
    assert.equal(sendRes.code, 'ACCEPTED');

    // 2. Replay attack with new idempotency_key is rejected (§18 #13)
    const replayed = { ...queued.envelope, idempotency_key: 'malicious_replay_key' };
    let replayError = null;
    try {
      await codexRelay.sendEnvelope(replayed);
    } catch (err) {
      replayError = err;
    }
    assert.ok(replayError);
    assert.equal(replayError.status, 409);
    assert.equal(replayError.code, 'REPLAY_DETECTED');

    // 3. Tampered payload with altered body fails Ed25519 signature verification
    const tampered = {
      ...queued.envelope,
      message_id: `msg_tampered_${crypto.randomUUID()}`,
      idempotency_key: `idemp_tampered_${crypto.randomUUID()}`,
      body: { text: 'Tampered malicious directive' }
    };
    let tamperError = null;
    try {
      await codexRelay.sendEnvelope(tampered);
    } catch (err) {
      tamperError = err;
    }
    assert.ok(tamperError);
    assert.equal(tamperError.status, 401);
    assert.equal(tamperError.code, 'INVALID_SIGNATURE');

  } finally {
    await new Promise((resolve) => relayServer.close(resolve));
  }
});

test('Concurrent bidirectional multi-agent stream exchange and SQLite state reconciliation', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-bidir-test-'));
  const codexDb = new ConnectorDatabase(path.join(tmpDir, 'codex.db'), schemaPath);
  const claudeDb = new ConnectorDatabase(path.join(tmpDir, 'claude.db'), schemaPath);

  const codexIdentity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_codex', kind: 'agent' });
  const claudeIdentity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_claude', kind: 'agent' });

  const codexKeys = identityKeys(codexIdentity);
  const claudeKeys = identityKeys(claudeIdentity);

  const endpoint = (id, keys) => ({
    owner_id: id.owner_id,
    endpoint_id: id.endpoint_id,
    key_id: id.key_id,
    kind: id.kind,
    status: 'active',
    public_key: keys.publicKey
  });

  const codexEndpoint = endpoint(codexIdentity, codexKeys);
  const claudeEndpoint = endpoint(claudeIdentity, claudeKeys);

  codexDb.upsertProfile({
    profile_id: 'prof_ep_codex',
    owner_id: codexIdentity.owner_id,
    endpoint_id: codexIdentity.endpoint_id,
    display_name: 'Codex Agent',
    relay_url: 'http://127.0.0.1:0',
    status: 'active',
    secure_key_reference: `key://${codexIdentity.key_id}`,
    secure_token_reference: `token://${codexIdentity.endpoint_id}`
  });

  claudeDb.upsertProfile({
    profile_id: 'prof_ep_claude',
    owner_id: claudeIdentity.owner_id,
    endpoint_id: claudeIdentity.endpoint_id,
    display_name: 'Claude Agent',
    relay_url: 'http://127.0.0.1:0',
    status: 'active',
    secure_key_reference: `key://${claudeIdentity.key_id}`,
    secure_token_reference: `token://${claudeIdentity.endpoint_id}`
  });

  const registry = new Map([
    ['ep_codex', codexEndpoint],
    ['ep_claude', claudeEndpoint]
  ]);

  const repository = createMemoryRepository();
  const tokenHashes = new Map([
    [hashBearerToken(codexIdentity.relay_token), codexIdentity.endpoint_id],
    [hashBearerToken(claudeIdentity.relay_token), claudeIdentity.endpoint_id]
  ]);

  const relayServer = createRelayServer({ registry, repository, tokenHashes });
  const port = await listen(relayServer);
  const relayUrl = `http://127.0.0.1:${port}`;

  const codexRelay = new RelayClient({ baseUrl: relayUrl, token: codexIdentity.relay_token });
  const claudeRelay = new RelayClient({ baseUrl: relayUrl, token: claudeIdentity.relay_token });

  const codexOutbox = new LocalOutbox({ privateKey: codexKeys.privateKey, endpoint: codexEndpoint });
  const claudeOutbox = new LocalOutbox({ privateKey: claudeKeys.privateKey, endpoint: claudeEndpoint });

  const BATCH_SIZE = 8;
  const conversationId = 'conv_bidirectional_parallel_01';

  try {
    // Both agents dispatch concurrent messages to each other
    const codexSends = Array.from({ length: BATCH_SIZE }, async (_, i) => {
      const msg = {
        protocol: 'sigil/1',
        message_id: `msg_c2c_${i}_${crypto.randomUUID()}`,
        conversation_id: conversationId,
        message_type: 'chat.message',
        sender: codexEndpoint,
        recipient: claudeEndpoint,
        correlation_id: null,
        capabilities: [],
        context_refs: [],
        body: { index: i, text: `Codex message ${i}` },
        idempotency_key: `idemp_c2c_${i}_${crypto.randomUUID()}`,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString()
      };
      const queued = codexOutbox.queue(msg);
      codexDb.queueOutboundMessage(`out_${queued.envelope.message_id}`, 'prof_ep_codex', queued.envelope);
      return codexRelay.sendEnvelope(queued.envelope);
    });

    const claudeSends = Array.from({ length: BATCH_SIZE }, async (_, i) => {
      const msg = {
        protocol: 'sigil/1',
        message_id: `msg_c2x_${i}_${crypto.randomUUID()}`,
        conversation_id: conversationId,
        message_type: 'chat.message',
        sender: claudeEndpoint,
        recipient: codexEndpoint,
        correlation_id: null,
        capabilities: [],
        context_refs: [],
        body: { index: i, text: `Claude reply ${i}` },
        idempotency_key: `idemp_c2x_${i}_${crypto.randomUUID()}`,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString()
      };
      const queued = claudeOutbox.queue(msg);
      claudeDb.queueOutboundMessage(`out_${queued.envelope.message_id}`, 'prof_ep_claude', queued.envelope);
      return claudeRelay.sendEnvelope(queued.envelope);
    });

    const sendResults = await Promise.all([...codexSends, ...claudeSends]);
    for (const res of sendResults) {
      assert.equal(res.code, 'ACCEPTED');
    }

    // Reconcile inboxes on both sides
    const claudeInbox = await claudeRelay.reconcileInbox('');
    assert.equal(claudeInbox.items.length, BATCH_SIZE);

    for (const item of claudeInbox.items) {
      claudeDb.commitDurableInboxIntake(item.envelope, 'prof_ep_claude', new Date().toISOString());
      await claudeRelay.acknowledge(item.delivery_id);
    }

    const codexInbox = await codexRelay.reconcileInbox('');
    assert.equal(codexInbox.items.length, BATCH_SIZE);

    for (const item of codexInbox.items) {
      codexDb.commitDurableInboxIntake(item.envelope, 'prof_ep_codex', new Date().toISOString());
      await codexRelay.acknowledge(item.delivery_id);
    }

    // Assert that inboxes are now completely drained on the relay
    assert.equal((await claudeRelay.reconcileInbox('')).items.length, 0);
    assert.equal((await codexRelay.reconcileInbox('')).items.length, 0);

  } finally {
    await new Promise((resolve) => relayServer.close(resolve));
    codexDb.close();
    claudeDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

