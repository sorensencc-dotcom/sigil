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

async function checkOllamaAvailability(host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434') {
  try {
    const res = await fetch(`${host}/api/tags`);
    if (!res.ok) return { available: false, reason: `HTTP ${res.status}` };
    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models.map((m) => m.name) : [];
    if (!models.length) return { available: false, reason: 'Ollama is running but no models are installed' };
    return { available: true, models };
  } catch (err) {
    return { available: false, reason: `Cannot reach Ollama at ${host}: ${err.message}` };
  }
}

async function runLiveOllamaWorkflow() {
  console.log('[1/6] Checking live Ollama service readiness...');
  const ollamaCheck = await checkOllamaAvailability();
  if (!ollamaCheck.available) {
    console.log(`\n[SKIP] Live Ollama test skipped: ${ollamaCheck.reason}`);
    console.log('To run live tests, install a model with: ollama pull llama3.2:1b\n');
    return;
  }

  const modelToUse = process.env.SIGIL_OLLAMA_MODEL || ollamaCheck.models[0];
  console.log(`✔ Live Ollama service ready. Using model: ${modelToUse}`);

  console.log('[2/6] Setting up local Relay server with endpoint registry & capability grants...');
  const codexId = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_codex', kind: 'agent' });
  const ollamaId = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_ollama', kind: 'agent' });

  const codexKeys = identityKeys(codexId);
  const ollamaKeys = identityKeys(ollamaId);

  const registry = new Map([
    [codexId.endpoint_id, {
      owner_id: codexId.owner_id,
      endpoint_id: codexId.endpoint_id,
      kind: codexId.kind,
      key_id: codexId.key_id,
      status: 'active',
      public_key: codexKeys.publicKey,
    }],
    [ollamaId.endpoint_id, {
      owner_id: ollamaId.owner_id,
      endpoint_id: ollamaId.endpoint_id,
      kind: ollamaId.kind,
      key_id: ollamaId.key_id,
      status: 'active',
      public_key: ollamaKeys.publicKey,
    }],
  ]);

  const tokenHashes = new Map([
    [hashBearerToken(codexId.relay_token), codexId.endpoint_id],
    [hashBearerToken(ollamaId.relay_token), ollamaId.endpoint_id],
  ]);

  const repository = createMemoryRepository({ registry });
  const expiresAt = new Date(Date.now() + 86400_000).toISOString();

  await repository.createCapabilityGrant({
    grantId: 'grant_codex_submit',
    capability: 'sigil.task/submit',
    scope: 'scope:conversation',
    grantedTo: codexId.endpoint_id,
    expiresAt,
  });

  await repository.createCapabilityGrant({
    grantId: 'grant_ollama_submit',
    capability: 'sigil.task/submit',
    scope: 'scope:conversation',
    grantedTo: ollamaId.endpoint_id,
    expiresAt,
  });


  const relayServer = createRelayServer({ registry, repository, tokenHashes });
  await new Promise((resolve) => relayServer.listen(0, '127.0.0.1', resolve));
  const port = relayServer.address().port;
  const relayUrl = `http://127.0.0.1:${port}`;
  const streamUrl = `ws://127.0.0.1:${port}/v1/stream`;

  console.log('[3/6] Creating SQLite database for Ollama connector state...');
  const tmpDb = join(tmpdir(), `sigil-ollama-live-${Date.now()}.db`);

  console.log('[4/6] Starting Ollama Agent Daemon (SIGIL_OLLAMA_FALLBACK=0)...');
  const prevFallback = process.env.SIGIL_OLLAMA_FALLBACK;
  const prevModel = process.env.SIGIL_OLLAMA_MODEL;
  process.env.SIGIL_OLLAMA_FALLBACK = '0';
  process.env.SIGIL_OLLAMA_MODEL = modelToUse;

  const daemon = createAgentDaemon({
    identity: ollamaId,
    relayUrl,
    streamUrl,
    dbPath: tmpDb,
    workerCommand: process.execPath,
    workerArgs: [ollamaWorkerScript],
    autoReply: true,
  });

  // Do NOT call daemon.start() here. start() opens a WebSocket stream listener
  // that fires poll() on every relay "delivered" notification. That races with
  // the explicit daemon.poll() call below: both pick up the same unacknowledged
  // task.request and each tries to send a reply with the same idempotency_key
  // but a different body hash → relay returns 409 DUPLICATE_MESSAGE.
  // The test drives polling manually, so the stream listener is unnecessary.

  console.log('[5/6] Sending signed task.request envelope from Codex to Ollama...');
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
    message_id: `msg_task_live_${Date.now()}`,
    conversation_id: 'conv_live_ollama_001',
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
      task_id: 'task_live_001',
      instruction: 'Provide a 1-sentence verification message.',
    },
    context_refs: [],
    capabilities: ['sigil.task/submit'],
    idempotency_key: `idem_live_${Date.now()}`,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    signature: { algorithm: 'Ed25519', key_id: codexId.key_id, value: '' },
  };

  const queued = codexOutbox.queue(taskEnvelope);
  await codexClient.sendEnvelope(queued.envelope);

  console.log('[6/6] Polling daemon and verifying live Ollama model generation...');
  const processedCount = await daemon.poll();
  assert.equal(processedCount, 1, 'Daemon should process 1 task');

  const storedInbox = daemon.db.getInboxMessage(queued.envelope.message_id);
  assert.notEqual(storedInbox, null);
  assert.equal(storedInbox.processing_state, 'processed');

  const codexInbox = await codexClient.reconcileInbox();
  assert.equal(codexInbox.items.length, 1);
  const replyEnv = codexInbox.items[0].envelope;

  assert.equal(replyEnv.message_type, 'task.result');
  assert.equal(replyEnv.sender.endpoint_id, ollamaId.endpoint_id);
  assert.equal(replyEnv.body.status, 'completed');

  assert.equal(replyEnv.body.processing, 'ollama_local_model', 'Live test must verify true Ollama model execution');
  assert.ok(replyEnv.body.summary.length > 0, 'Live model summary must be non-empty');

  console.log(`✔ Live Ollama model output verified:`);
  console.log(`  - Model: ${replyEnv.body.model}`);
  console.log(`  - Processing Mode: ${replyEnv.body.processing}`);
  console.log(`  - Output: ${replyEnv.body.summary}`);

  daemon.stop();
  if (daemon.db) daemon.db.close();
  await relayServer.close();
  try { unlinkSync(tmpDb); } catch {}

  if (prevFallback === undefined) delete process.env.SIGIL_OLLAMA_FALLBACK;
  else process.env.SIGIL_OLLAMA_FALLBACK = prevFallback;
  if (prevModel === undefined) delete process.env.SIGIL_OLLAMA_MODEL;
  else process.env.SIGIL_OLLAMA_MODEL = prevModel;

  console.log('\n[PASS] Live Ollama model execution verified successfully!');
}

runLiveOllamaWorkflow().catch((err) => {
  console.error('[FAIL] Live Ollama workflow test failed:', err);
  process.exit(1);
});
