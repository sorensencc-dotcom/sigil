// sigil/bridges/v1/rooms-router-exit.test.mjs
// Phase 3 exit: an unmentioned human message is routed by the router bridge to
// the right agent, which replies; a router failure posts an event and invokes no one.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRelayServer } from '../../relay/v1/http-server.mjs';
import { hashBearerToken } from '../../relay/v1/transport-auth.mjs';
import { ROOM_SYSTEM_ENDPOINT_ID, ROOM_SYSTEM_OWNER_ID } from '../../relay/v1/room-system-identity.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createIdentity, identityKeys } from '../../cli/identity.mjs';
import { createAgentDaemon } from '../../cli/agent-daemon.mjs';
import { RelayClient } from '../../connectors/v1/relay-client.mjs';
import { LocalOutbox } from '../../connectors/v1/local-outbox.mjs';
import { createRoomBridge } from './room-bridge.mjs';
import { createRoomRouter } from './room-router.mjs';
import { createSessionStore } from './session-store.mjs';
import { createClaudeCli } from './claude-cli.mjs';

const fake = new URL('./fixtures/fake-agent-cli.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const quiet = { log() {}, warn() {}, error() {} };
const ROOM = 'room_router_exit';

function outboxFor(identity) {
  return new LocalOutbox({ privateKey: identityKeys(identity).privateKey, endpoint: { owner_id: identity.owner_id, endpoint_id: identity.endpoint_id, key_id: identity.key_id, kind: identity.kind } });
}

async function startWorld({ chat }) {
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

  await repository.createRoom({ conversationId: ROOM, workspaceId: 'ws_usr_chris', name: 'router exit', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web' });
  await repository.addRoomMember({ conversationId: ROOM, endpointId: 'ep_claude', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_chris' });
  await repository.addRoomMember({ conversationId: ROOM, endpointId: 'ep_codex', role: 'member', responseMode: 'mentions_only', addedByHumanId: 'usr_chris' });
  await repository.addRoomMember({ conversationId: ROOM, endpointId: 'ep_router', role: 'member', responseMode: 'router', addedByHumanId: 'usr_chris' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-router-exit-'));
  const claudeBridge = createRoomBridge({
    identity: claude,
    relay: new RelayClient({ baseUrl: relayUrl, token: claude.relay_token }),
    outbox: outboxFor(claude),
    cli: createClaudeCli({ command: process.execPath, commandArgs: [fake, 'claude'], env: { ...process.env, FAKE_NAME: 'claude' } }),
    sessions: createSessionStore(path.join(dir, 'ep_claude.json')),
    pollIntervalMs: 100,
    logger: quiet,
  });
  const routerBridge = createRoomRouter({
    identity: router,
    relay: new RelayClient({ baseUrl: relayUrl, token: router.relay_token }),
    ollama: { chat },
    model: 'fake-model',
    timeoutMs: 5000,
    logger: quiet,
  });
  const daemons = [
    createAgentDaemon({ identity: claude, relayUrl, onRoomMessage: claudeBridge.handle, pollIntervalMs: 100, logger: quiet }),
    createAgentDaemon({ identity: router, relayUrl, onRoomMessage: routerBridge.handle, pollIntervalMs: 100, logger: quiet }),
  ];
  for (const daemon of daemons) daemon.start();

  const humanClient = new RelayClient({ baseUrl: relayUrl, token: human.relay_token });
  const humanOutbox = outboxFor(human);
  async function say(text, mentions = []) {
    const now = new Date();
    const queued = humanOutbox.queue({
      protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: ROOM, message_type: 'room.message',
      broadcast_scope: { conversation_id: ROOM }, correlation_id: null,
      body: { text, mentions }, context_refs: [], capabilities: [],
      idempotency_key: `idem_${crypto.randomUUID()}`, created_at: now.toISOString(), expires_at: new Date(now.getTime() + 3600_000).toISOString(),
    });
    await humanClient.sendEnvelope(queued.envelope);
    return queued.envelope.message_id;
  }
  async function stop() {
    for (const daemon of daemons) daemon.stop();
    await new Promise((resolve) => server.close(resolve));
  }
  return { repository, say, stop };
}

async function waitFor(check, { timeoutMs = 12_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const events = (messages, kind) => messages.filter((m) => m.envelope.message_type === 'room.event' && m.envelope.body.kind === kind);

test('an unmentioned human message is routed to the right agent, which replies', { timeout: 15_000 }, async () => {
  const world = await startWorld({ chat: async () => JSON.stringify({ invoke: ['ep_claude'], reason: 'code question' }) });
  try {
    const triggerId = await world.say('why does the build fail?');
    const done = await waitFor(async () => (await world.repository.listRoomInvocations(ROOM, { status: 'completed' }))[0]);
    assert.equal(done.endpoint_id, 'ep_claude');
    assert.equal(done.decided_by, 'router');
    assert.equal(done.trigger_message_id, triggerId);

    const messages = await waitFor(async () => {
      const all = await world.repository.listRoomMessages(ROOM, 0n, 100);
      return all.some((m) => m.envelope.sender.endpoint_id === 'ep_claude') ? all : null;
    });
    const human = messages.filter((m) => m.envelope.message_type === 'room.message' && m.envelope.sender.endpoint_id === 'ep_web');
    const replies = messages.filter((m) => m.envelope.message_type === 'room.message' && m.envelope.sender.endpoint_id === 'ep_claude');
    const decisions = events(messages, 'router_decision');
    assert.equal(human.length, 1);
    assert.equal(decisions.length, 1);
    assert.deepEqual(decisions[0].envelope.body.endpoint_ids, ['ep_claude']);
    assert.equal(replies.length, 1);
    const order = [human[0], decisions[0], replies[0]].map((m) => Number(m.room_seq));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'human message, then decision, then reply');

    const rows = await world.repository.listRoomInvocations(ROOM);
    assert.deepEqual(rows.map((r) => r.endpoint_id), ['ep_claude'], 'ep_codex and ep_router were never invoked');
  } finally {
    await world.stop();
  }
});

test('router failure posts an event and invokes no one', { timeout: 15_000 }, async () => {
  const world = await startWorld({ chat: async () => { throw new Error('ollama is down'); } });
  try {
    await world.say('why does the build fail?');
    const messages = await waitFor(async () => {
      const all = await world.repository.listRoomMessages(ROOM, 0n, 100);
      return events(all, 'router_failed').length ? all : null;
    });
    assert.equal(events(messages, 'router_failed').length, 1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(await world.repository.listRoomInvocations(ROOM), []);
    const after = await world.repository.listRoomMessages(ROOM, 0n, 100);
    assert.equal(after.filter((m) => m.envelope.sender.endpoint_id === 'ep_claude').length, 0, 'no agent reply exists');
  } finally {
    await world.stop();
  }
});
