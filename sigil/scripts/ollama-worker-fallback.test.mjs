import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

test('ollama-worker fails closed when Ollama is unavailable and fallback is not enabled', async () => {
  const child = spawn(process.execPath, [ollamaWorkerScript], {
    env: { ...process.env, OLLAMA_HOST: 'http://127.0.0.1:0', SIGIL_OLLAMA_FALLBACK: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });

  const exitCode = await new Promise((resolve) => {
    child.on('close', resolve);
    child.stdin.end(JSON.stringify({ task_id: 'task_fail_001', instruction: 'test' }));
  });

  assert.equal(exitCode, 1, 'Worker must exit with 1 when Ollama is unavailable');
  assert.match(stderr, /Ollama model inference failed/);
});

test('ollama-worker returns local_deterministic_fallback only when explicitly enabled', async () => {
  const child = spawn(process.execPath, [ollamaWorkerScript], {
    env: { ...process.env, OLLAMA_HOST: 'http://127.0.0.1:0', SIGIL_OLLAMA_FALLBACK: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });

  const exitCode = await new Promise((resolve) => {
    child.on('close', resolve);
    child.stdin.end(JSON.stringify({ task_id: 'task_fb_001', instruction: 'offline test' }));
  });

  assert.equal(exitCode, 0, 'Worker must exit with 0 when fallback is enabled');
  const result = JSON.parse(stdout.trim());
  assert.equal(result.status, 'completed');
  assert.equal(result.processing, 'local_deterministic_fallback');
  assert.match(result.summary, /Processed \(offline fallback\)/);
});

test('agent daemon handles fallback workflow with SQLite persistence when configured', async () => {
  const codexId = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_codex', kind: 'agent' });
  const ollamaId = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_ollama', kind: 'agent' });

  const codexKeys = identityKeys(codexId);
  const ollamaKeys = identityKeys(ollamaId);

  const registry = new Map([
    ['ep_codex', {
      owner_id: codexId.owner_id, endpoint_id: codexId.endpoint_id,
      kind: codexId.kind, key_id: codexId.key_id, status: 'active', public_key: codexKeys.publicKey,
    }],
    ['ep_ollama', {
      owner_id: ollamaId.owner_id, endpoint_id: ollamaId.endpoint_id,
      kind: ollamaId.kind, key_id: ollamaId.key_id, status: 'active', public_key: ollamaKeys.publicKey,
    }],
  ]);

  const tokenHashes = new Map([
    [hashBearerToken(codexId.relay_token), 'ep_codex'],
    [hashBearerToken(ollamaId.relay_token), 'ep_ollama'],
  ]);

  const repository = createMemoryRepository();
  const expiresAt = new Date(Date.now() + 86400_000).toISOString();
  await repository.createCapabilityGrant({
    grantId: 'grant_codex_submit', capability: 'sigil.task/submit',
    scope: 'scope:conversation', grantedTo: 'ep_codex', expiresAt,
  });
  await repository.createCapabilityGrant({
    grantId: 'grant_ollama_submit', capability: 'sigil.task/submit',
    scope: 'scope:conversation', grantedTo: 'ep_ollama', expiresAt,
  });

  const relayServer = createRelayServer({ registry, repository, tokenHashes });
  await new Promise((resolve) => relayServer.listen(0, '127.0.0.1', resolve));
  const port = relayServer.address().port;
  const relayUrl = `http://127.0.0.1:${port}`;
  const streamUrl = `ws://127.0.0.1:${port}/v1/stream`;

  const tmpDb = join(tmpdir(), `sigil-ollama-fallback-${Date.now()}.db`);

  const prevFallback = process.env.SIGIL_OLLAMA_FALLBACK;
  process.env.SIGIL_OLLAMA_FALLBACK = '1';

  const daemon = createAgentDaemon({
    identity: ollamaId,
    relayUrl,
    streamUrl,
    dbPath: tmpDb,
    workerCommand: process.execPath,
    workerArgs: [ollamaWorkerScript],
    autoReply: true,
  });

  daemon.start();

  const codexOutbox = new LocalOutbox({
    privateKey: codexKeys.privateKey,
    endpoint: { owner_id: codexId.owner_id, endpoint_id: codexId.endpoint_id, key_id: codexId.key_id, kind: codexId.kind },
  });

  const codexClient = new RelayClient({ baseUrl: relayUrl, token: codexId.relay_token });
  const now = new Date();
  const taskEnvelope = {
    protocol: 'sigil/1',
    message_id: `msg_task_fb_${Date.now()}`,
    conversation_id: 'conv_fallback_001',
    message_type: 'task.request',
    sender: { owner_id: codexId.owner_id, endpoint_id: codexId.endpoint_id, kind: codexId.kind },
    recipient: { owner_id: ollamaId.owner_id, endpoint_id: ollamaId.endpoint_id },
    body: { task_id: 'task_fb_001', instruction: 'Fallback verification instruction' },
    context_refs: [],
    capabilities: ['sigil.task/submit'],
    idempotency_key: `idem_fb_${Date.now()}`,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 24 * 3600_000).toISOString(),
    signature: { algorithm: 'Ed25519', key_id: codexId.key_id, value: '' },
  };

  const queued = codexOutbox.queue(taskEnvelope);
  await codexClient.sendEnvelope(queued.envelope);

  const processedCount = await daemon.poll();
  assert.equal(processedCount, 1);

  const storedInbox = daemon.db.getInboxMessage(queued.envelope.message_id);
  assert.equal(storedInbox.processing_state, 'processed');

  const codexInbox = await codexClient.reconcileInbox();
  assert.equal(codexInbox.items.length, 1);
  const replyEnv = codexInbox.items[0].envelope;

  assert.equal(replyEnv.body.status, 'completed');
  assert.equal(replyEnv.body.processing, 'local_deterministic_fallback');

  daemon.stop();
  if (daemon.db) daemon.db.close();
  await relayServer.close();
  try { unlinkSync(tmpDb); } catch {}
  if (prevFallback === undefined) delete process.env.SIGIL_OLLAMA_FALLBACK;
  else process.env.SIGIL_OLLAMA_FALLBACK = prevFallback;
});
