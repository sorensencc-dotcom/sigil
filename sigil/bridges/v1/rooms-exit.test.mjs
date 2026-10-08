// sigil/bridges/v1/rooms-exit.test.mjs
// Phase 2 exit: Claude and Codex hold a 6-turn exchange in one room, then the
// hop budget stops them. Also: Stop kills a running CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRelayServer } from '../../relay/v1/http-server.mjs';
import { hashBearerToken } from '../../relay/v1/transport-auth.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createIdentity, identityKeys } from '../../cli/identity.mjs';
import { createAgentDaemon } from '../../cli/agent-daemon.mjs';
import { RelayClient } from '../../connectors/v1/relay-client.mjs';
import { LocalOutbox } from '../../connectors/v1/local-outbox.mjs';
import { createRoomBridge } from './room-bridge.mjs';
import { createSessionStore } from './session-store.mjs';
import { createClaudeCli } from './claude-cli.mjs';
import { createCodexCli } from './codex-cli.mjs';

const fake = new URL('./fixtures/fake-agent-cli.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const quiet = { log() {}, warn() {}, error() {} };

function outboxFor(identity) {
  return new LocalOutbox({ privateKey: identityKeys(identity).privateKey, endpoint: { owner_id: identity.owner_id, endpoint_id: identity.endpoint_id, key_id: identity.key_id, kind: identity.kind } });
}

async function startWorld({ codexEnv = {}, claudeEnv = {} } = {}) {
  const human = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_web', kind: 'human' });
  const claude = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_claude', kind: 'agent' });
  const codex = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_codex', kind: 'agent' });
  const all = [human, claude, codex];
  const registry = new Map(all.map((id) => [id.endpoint_id, { owner_id: id.owner_id, endpoint_id: id.endpoint_id, key_id: id.key_id, kind: id.kind, status: 'active', public_key: crypto.createPublicKey(id.public_key_pem) }]));
  const tokenHashes = new Map(all.map((id) => [hashBearerToken(id.relay_token), id.endpoint_id]));
  const repository = createMemoryRepository({ registry });
  const server = createRelayServer({ registry, repository, tokenHashes });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const relayUrl = `http://127.0.0.1:${server.address().port}`;

  await repository.createRoom({ conversationId: 'room_exit', workspaceId: 'ws_usr_chris', name: 'exit', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web' });
  await repository.addRoomMember({ conversationId: 'room_exit', endpointId: 'ep_claude', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_chris' });
  await repository.addRoomMember({ conversationId: 'room_exit', endpointId: 'ep_codex', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_chris' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-exit-'));
  const daemons = [
    [claude, createClaudeCli({ command: process.execPath, commandArgs: [fake, 'claude'], env: { ...process.env, FAKE_NAME: 'claude', FAKE_PARTNER: 'ep_codex', ...claudeEnv } })],
    [codex, createCodexCli({ command: process.execPath, commandArgs: [fake, 'codex'], env: { ...process.env, FAKE_NAME: 'codex', FAKE_PARTNER: 'ep_claude', ...codexEnv } })],
  ].map(([identity, cli]) => {
    const bridge = createRoomBridge({ identity, relay: new RelayClient({ baseUrl: relayUrl, token: identity.relay_token }), outbox: outboxFor(identity), cli, sessions: createSessionStore(path.join(dir, `${identity.endpoint_id}.json`)), pollIntervalMs: 100, logger: quiet });
    const daemon = createAgentDaemon({ identity, relayUrl, onRoomMessage: bridge.handle, pollIntervalMs: 100, logger: quiet });
    daemon.start();
    return daemon;
  });

  const humanClient = new RelayClient({ baseUrl: relayUrl, token: human.relay_token });
  const humanOutbox = outboxFor(human);
  async function say(text, mentions, threadRootId) {
    const now = new Date();
    const queued = humanOutbox.queue({
      protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: 'room_exit', message_type: 'room.message',
      broadcast_scope: { conversation_id: 'room_exit' }, correlation_id: null,
      body: { text, mentions, ...(threadRootId ? { thread_root_id: threadRootId } : {}) }, context_refs: [], capabilities: [],
      idempotency_key: `idem_${crypto.randomUUID()}`, created_at: now.toISOString(), expires_at: new Date(now.getTime() + 3600_000).toISOString(),
    });
    await humanClient.sendEnvelope(queued.envelope);
    return queued.envelope.message_id;
  }
  async function stop() {
    for (const daemon of daemons) daemon.stop();
    await new Promise((resolve) => server.close(resolve));
  }
  return { repository, humanClient, say, stop };
}

async function waitFor(check, { timeoutMs = 30_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test('Claude and Codex hold a 6-turn exchange, then the hop budget stops them', { timeout: 60_000 }, async () => {
  const world = await startWorld();
  try {
    const root = await world.say('Claude and Codex, discuss. @ep_claude', ['ep_claude']);
    const refused = await waitFor(async () => (await world.repository.listRoomInvocations('room_exit', { status: 'refused' }))[0]);
    assert.equal(refused.reason, 'hop_budget');

    const messages = await world.repository.listRoomMessages('room_exit', 0n, 100);
    const agentTurns = messages.filter((m) => m.envelope.sender.endpoint_id !== 'ep_web');
    assert.equal(agentTurns.length, 6);
    assert.deepEqual(agentTurns.map((m) => m.envelope.sender.endpoint_id), ['ep_claude', 'ep_codex', 'ep_claude', 'ep_codex', 'ep_claude', 'ep_codex']);
    assert.ok(agentTurns.every((m) => m.envelope.body.thread_root_id === root));
    assert.match(agentTurns[2].envelope.body.text, /resumed=true/, 'the third turn resumed the first Claude session');

    const rows = await world.repository.listRoomInvocations('room_exit');
    assert.equal(rows.filter((r) => r.status === 'completed').length, 6);
    assert.equal(rows.filter((r) => r.status === 'running' || r.status === 'queued').length, 0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await world.repository.listRoomMessages('room_exit', 0n, 100)).length, 7, 'nothing more was posted after the budget');

    const human = await world.repository.listInbox('ep_web');
    assert.equal(human.length, 6, 'the human received every agent turn');
  } finally {
    await world.stop();
  }
});

test('Stop cancels the running invocation and kills the CLI before it answers', { timeout: 60_000 }, async () => {
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-stop-')), 'pid');
  const world = await startWorld({ claudeEnv: { FAKE_SLEEP_MS: '20000', FAKE_PID_FILE: pidFile } });
  try {
    await world.say('@ep_claude take your time', ['ep_claude']);
    await waitFor(() => fs.existsSync(pidFile));
    const roomStop = await world.humanClient.request('/v1/rooms/room_exit/stop', { method: 'POST', body: '{}' });
    assert.equal(roomStop.cancelled, 1);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, { timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const messages = await world.repository.listRoomMessages('room_exit', 0n, 100);
    assert.equal(messages.length, 1, 'only the human message; Claude never posted');
    const [row] = await world.repository.listRoomInvocations('room_exit');
    assert.deepEqual([row.status, row.reason], ['cancelled', 'stopped']);
  } finally {
    await world.stop();
  }
});
