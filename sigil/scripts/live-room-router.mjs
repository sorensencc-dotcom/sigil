// sigil/scripts/live-room-router.mjs
// Live smoke: real Ollama (qwen2.5:7b) routes one unmentioned message to a real `claude` bridge, which replies.
// Refuses to run unless SIGIL_LIVE_ROOM_ROUTER=1. Not a *.test.mjs file, so `node --test` skips it.
// SIGIL_LIVE_ROOM_ROUTER_NO_FALLBACK=1 turns the sole-joins-agent fallback (spec D5) off, so the
// run checks the model's own pick. The output names the decision source: fallback or model.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRelayServer } from '../relay/v1/http-server.mjs';
import { hashBearerToken } from '../relay/v1/transport-auth.mjs';
import { ROOM_SYSTEM_ENDPOINT_ID, ROOM_SYSTEM_OWNER_ID } from '../relay/v1/room-system-identity.mjs';
import { createMemoryRepository } from '../cli/memory-repository.mjs';
import { createIdentity, identityKeys } from '../cli/identity.mjs';
import { createAgentDaemon } from '../cli/agent-daemon.mjs';
import { RelayClient } from '../connectors/v1/relay-client.mjs';
import { LocalOutbox } from '../connectors/v1/local-outbox.mjs';
import { createRoomBridge } from '../bridges/v1/room-bridge.mjs';
import { createRoomRouter, createOllamaClient } from '../bridges/v1/room-router.mjs';
import { createSessionStore } from '../bridges/v1/session-store.mjs';
import { createClaudeCli } from '../bridges/v1/claude-cli.mjs';

if (process.env.SIGIL_LIVE_ROOM_ROUTER !== '1') {
  console.error('Refusing to run: set SIGIL_LIVE_ROOM_ROUTER=1 to use real Ollama and the real claude CLI.');
  process.exit(2);
}

const OLLAMA_URL = 'http://127.0.0.1:11434';
const MODEL = 'qwen2.5:7b';
const WAIT_MS = 60_000;
const ROOM = 'room_live_router';
const SOLE_AGENT_FALLBACK = process.env.SIGIL_LIVE_ROOM_ROUTER_NO_FALLBACK !== '1';
const FALLBACK_PREFIX = 'fallback: only joins agent';

try {
  const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
} catch (error) {
  console.error(`Ollama is unreachable at ${OLLAMA_URL} (${error.message}). Start Ollama and pull ${MODEL} before running this smoke.`);
  process.exit(1);
}

const quiet = { log() {}, warn() {}, error() {} };
const outboxFor = (identity) => new LocalOutbox({ privateKey: identityKeys(identity).privateKey, endpoint: { owner_id: identity.owner_id, endpoint_id: identity.endpoint_id, key_id: identity.key_id, kind: identity.kind } });

const human = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_web', kind: 'human' });
const claude = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_claude', kind: 'agent' });
const codex = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_codex', kind: 'agent' });
const router = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_router', kind: 'agent' });
const system = createIdentity({ ownerId: ROOM_SYSTEM_OWNER_ID, endpointId: ROOM_SYSTEM_ENDPOINT_ID, kind: 'system' });
const all = [human, claude, codex, router];
const registry = new Map(all.map((id) => [id.endpoint_id, { owner_id: id.owner_id, endpoint_id: id.endpoint_id, key_id: id.key_id, kind: id.kind, status: 'active', public_key: crypto.createPublicKey(id.public_key_pem) }]));
const tokenHashes = new Map(all.map((id) => [hashBearerToken(id.relay_token), id.endpoint_id]));
const repository = createMemoryRepository({ registry });
await repository.ensureRoomSystemEndpoint({ identity: system, now: new Date() });
const server = createRelayServer({ registry, repository, tokenHashes, roomSystemIdentity: system });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const relayUrl = `http://127.0.0.1:${server.address().port}`;

await repository.createRoom({ conversationId: ROOM, workspaceId: 'ws_usr_chris', name: 'live router', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web' });
await repository.addRoomMember({ conversationId: ROOM, endpointId: 'ep_router', role: 'member', responseMode: 'router', addedByHumanId: 'usr_chris' });
await repository.addRoomMember({ conversationId: ROOM, endpointId: 'ep_claude', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_chris' });
await repository.addRoomMember({ conversationId: ROOM, endpointId: 'ep_codex', role: 'member', responseMode: 'mentions_only', addedByHumanId: 'usr_chris' });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-live-router-'));
const cwd = path.join(dir, 'cwd');
fs.mkdirSync(cwd);
const claudeBridge = createRoomBridge({
  identity: claude,
  relay: new RelayClient({ baseUrl: relayUrl, token: claude.relay_token }),
  outbox: outboxFor(claude),
  cli: createClaudeCli({ cwd }),
  sessions: createSessionStore(path.join(dir, 'ep_claude.json')),
  pollIntervalMs: 500,
  logger: console,
});
const routerBridge = createRoomRouter({
  identity: router,
  relay: new RelayClient({ baseUrl: relayUrl, token: router.relay_token }),
  ollama: createOllamaClient({ baseUrl: OLLAMA_URL }),
  model: MODEL,
  timeoutMs: 45_000,
  soleAgentFallback: SOLE_AGENT_FALLBACK,
  logger: console,
});
console.log(`sole-agent fallback: ${SOLE_AGENT_FALLBACK ? 'on' : 'off'}`);
const daemons = [
  createAgentDaemon({ identity: claude, relayUrl, onRoomMessage: claudeBridge.handle, pollIntervalMs: 500, logger: quiet }),
  createAgentDaemon({ identity: router, relayUrl, onRoomMessage: routerBridge.handle, pollIntervalMs: 500, logger: quiet }),
];
for (const daemon of daemons) daemon.start();

async function shutdown() {
  for (const daemon of daemons) daemon.stop();
  await new Promise((resolve) => server.close(resolve));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a CLI may still hold the cwd on Windows */ }
}

let exitCode = 1;
try {
  const humanClient = new RelayClient({ baseUrl: relayUrl, token: human.relay_token });
  const now = new Date();
  const queued = outboxFor(human).queue({
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: ROOM, message_type: 'room.message',
    broadcast_scope: { conversation_id: ROOM }, correlation_id: null,
    body: { text: 'Please review the error handling in src/index.js', mentions: [] },
    context_refs: [], capabilities: [], idempotency_key: `idem_${crypto.randomUUID()}`,
    created_at: now.toISOString(), expires_at: new Date(now.getTime() + 3600_000).toISOString(),
  });
  await humanClient.sendEnvelope(queued.envelope);

  const deadline = Date.now() + WAIT_MS;
  let messages = [];
  let decision;
  let reply;
  while (Date.now() < deadline) {
    messages = await repository.listRoomMessages(ROOM, 0n, 100);
    decision = messages.find((m) => m.envelope.message_type === 'room.event' && m.envelope.body.kind === 'router_decision');
    reply = messages.find((m) => m.envelope.message_type === 'room.message' && m.envelope.sender.endpoint_id === 'ep_claude');
    if (decision && reply) break;
    // An empty pick invokes nobody, so no reply will come.
    if (decision && decision.envelope.body.endpoint_ids.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  for (const m of messages) console.log(`[${m.room_seq}] ${m.envelope.message_type} ${m.envelope.sender.endpoint_id}: ${JSON.stringify(m.envelope.body).slice(0, 200)}`);
  if (decision) {
    const source = String(decision.envelope.body.reason ?? '').startsWith(FALLBACK_PREFIX) ? 'fallback' : 'model';
    console.log(`\nrouter decision source: ${source}`);
    console.log(`router decision: invoke=${JSON.stringify(decision.envelope.body.endpoint_ids)} reason=${decision.envelope.body.reason}`);
  }
  if (decision && reply) {
    console.log(`claude reply (first 200 chars): ${String(reply.envelope.body.text).slice(0, 200)}`);
    exitCode = 0;
  } else {
    console.error(`\nFAIL (waited up to ${WAIT_MS / 1000}s): router_decision=${Boolean(decision)}, claude reply=${Boolean(reply)}`);
  }
} catch (error) {
  console.error(error);
} finally {
  await shutdown();
}
process.exit(exitCode);
