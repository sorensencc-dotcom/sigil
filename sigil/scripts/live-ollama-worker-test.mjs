import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createRelayServer } from '../relay/v1/http-server.mjs';
import { createMemoryRepository } from '../cli/memory-repository.mjs';
import { hashBearerToken } from '../relay/v1/transport-auth.mjs';
import { createIdentity, identityKeys } from '../cli/identity.mjs';
import { createAgentDaemon } from '../cli/agent-daemon.mjs';
import { LocalOutbox } from '../connectors/v1/local-outbox.mjs';
import { RelayClient } from '../connectors/v1/relay-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ollamaWorkerScript = path.resolve(here, 'ollama-worker.mjs');

async function runOllamaWorkflowTest() {
  console.log('[1/5] Setting up local Relay server with endpoint registry & capability grants...');

  const codexId = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_codex', kind: 'agent' });
  const ollamaId = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_ollama', kind: 'agent' });

  const codexKeys = identityKeys(codexId);
  const ollamaKeys = identityKeys(ollamaId);

  const registry = new Map([
    ['ep_codex', {
      owner_id: codexId.owner_id,
      endpoint_id: codexId.endpoint_id,
      kind: codexId.kind,
      key_id: codexId.key_id,
      status: 'active',
      public_key: codexKeys.publicKey,
    }],
    ['ep_ollama', {
      owner_id: ollamaId.owner_id,
      endpoint_id: ollamaId.endpoint_id,
      kind: ollamaId.kind,
      key_id: ollamaId.key_id,
      status: 'active',
      public_key: ollamaKeys.publicKey,
    }],
  ]);

  const tokenHashes = new Map([
    [hashBearerToken(codexId.relay_token), 'ep_codex'],
    [hashBearerToken(ollamaId.relay_token), 'ep_ollama'],
  ]);

  const repository = createMemoryRepository();

  // Issue capability grants for task submission (scope:conversation covers all conversation sub-scopes)
  const expiresAt = new Date(Date.now() + 86400_000).toISOString();
  await repository.createCapabilityGrant({
    grantId: 'grant_codex_submit',
    capability: 'sigil.task/submit',
    scope: 'scope:conversation',
    grantedTo: 'ep_codex',
    expiresAt,
  });

  await repository.createCapabilityGrant({
    grantId: 'grant_ollama_submit',
    capability: 'sigil.task/submit',
    scope: 'scope:conversation',
    grantedTo: 'ep_ollama',
    expiresAt,
  });

  const relayServer = createRelayServer({ registry, repository, tokenHashes });
  await new Promise((resolve) => relayServer.listen(0, '127.0.0.1', resolve));
  const port = relayServer.address().port;
  const relayUrl = `http://127.0.0.1:${port}`;
  const streamUrl = `ws://127.0.0.1:${port}/v1/stream`;

  console.log(`Relay running on: ${relayUrl}`);

  console.log('[2/5] Creating SQLite database for Ollama connector state...');
  const tmpDb = join(tmpdir(), `sigil-ollama-${Date.now()}.db`);

  console.log('[3/5] Starting Ollama Agent Daemon with durable SQLite persistence...');
  const daemon = createAgentDaemon({
    identity: ollamaId,
    relayUrl,
    streamUrl,
    dbPath: tmpDb,
    workerCommand: process.execPath,
    workerArgs: [ollamaWorkerScript],
    autoReply: true,
    logger: {
      error: (...args) => console.error('[DAEMON ERROR]', ...args),
      warn: (...args) => console.warn('[DAEMON WARN]', ...args),
      log: (...args) => console.log('[DAEMON LOG]', ...args),
    },
  });

  daemon.start();

  console.log('[4/5] Sending signed task.request envelope from Codex to Ollama...');
  const codexOutbox = new LocalOutbox({
    privateKey: codexKeys.privateKey,
    endpoint: {
      owner_id: codexId.owner_id,
      endpoint_id: codexId.endpoint_id,
      key_id: codexId.key_id,
      kind: codexId.kind,
    },
  });

  const codexClient = new RelayClient({ baseUrl: relayUrl, token: codexId.relay_token });

  const now = new Date();
  const taskEnvelope = {
    protocol: 'sigil/1',
    message_id: `msg_task_${Date.now()}`,
    conversation_id: 'conv_local_eval_001',
    message_type: 'task.request',
    sender: {
      owner_id: codexId.owner_id,
      endpoint_id: codexId.endpoint_id,
      kind: codexId.kind,
    },
    recipient: {
      owner_id: ollamaId.owner_id,
      endpoint_id: ollamaId.endpoint_id,
    },
    body: {
      task_id: 'task_local_001',
      instruction: 'Analyze code security in local workspace',
    },
    context_refs: [],
    capabilities: ['sigil.task/submit'],
    idempotency_key: `idem_${Date.now()}`,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    signature: { algorithm: 'Ed25519', key_id: codexId.key_id, value: '' },
  };

  const queued = codexOutbox.queue(taskEnvelope);
  const acceptResult = await codexClient.sendEnvelope(queued.envelope);
  console.log(`Task accepted by Relay: Message ID = ${acceptResult.message_id}`);

  console.log('[5/5] Polling daemon and verifying delivery & reply...');
  // Poll daemon to ingest task, run Ollama worker, and emit reply
  const processedCount = await daemon.poll();
  assert.equal(processedCount, 1, 'Daemon should process 1 task');

  // Verify SQLite durable intake
  const storedInbox = daemon.db.getInboxMessage(queued.envelope.message_id);
  assert.notEqual(storedInbox, null, 'Inbox message must be durably stored in SQLite');
  assert.equal(storedInbox.processing_state, 'processed');
  console.log(`✔ Durable intake verified in SQLite: ${storedInbox.message_id} -> ${storedInbox.processing_state}`);

  // Verify reply arrived at Codex inbox on Relay
  const codexInbox = await codexClient.reconcileInbox();
  assert.equal(codexInbox.items.length, 1, 'Codex should receive 1 reply envelope');
  const replyEnv = codexInbox.items[0].envelope;

  assert.equal(replyEnv.message_type, 'task.result');
  assert.equal(replyEnv.sender.endpoint_id, 'ep_ollama');
  assert.equal(replyEnv.correlation_id, queued.envelope.message_id);
  assert.equal(replyEnv.body.status, 'completed');
  assert.match(replyEnv.body.summary, /Analyze code security/);

  console.log(`✔ Ollama worker executed and reply verified:`);
  console.log(`  - Reply Message ID: ${replyEnv.message_id}`);
  console.log(`  - Status: ${replyEnv.body.status}`);
  console.log(`  - Processing Mode: ${replyEnv.body.processing}`);
  console.log(`  - Model: ${replyEnv.body.model}`);
  console.log(`  - Summary: ${replyEnv.body.summary}`);

  // Teardown
  daemon.stop();
  if (daemon.db) daemon.db.close();
  await relayServer.close();
  try { unlinkSync(tmpDb); } catch {}

  console.log('\n[PASS] Ollama agent daemon and durable SQLite workflow verified successfully!');
}

runOllamaWorkflowTest().catch((err) => {
  console.error('[FAIL] Ollama workflow test failed:', err);
  process.exit(1);
});
