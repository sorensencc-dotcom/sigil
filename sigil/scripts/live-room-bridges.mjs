// sigil/scripts/live-room-bridges.mjs
// Live smoke: real `claude` and `codex` CLIs hold a room exchange until the hop budget stops them.
// Refuses to run unless SIGIL_LIVE_ROOM_BRIDGES=1. Not a *.test.mjs file, so `node --test` skips it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRelayServer } from '../relay/v1/http-server.mjs';
import { hashBearerToken } from '../relay/v1/transport-auth.mjs';
import { createMemoryRepository } from '../cli/memory-repository.mjs';
import { createIdentity, identityKeys } from '../cli/identity.mjs';
import { createAgentDaemon } from '../cli/agent-daemon.mjs';
import { RelayClient } from '../connectors/v1/relay-client.mjs';
import { LocalOutbox } from '../connectors/v1/local-outbox.mjs';
import { createRoomBridge } from '../bridges/v1/room-bridge.mjs';
import { createSessionStore } from '../bridges/v1/session-store.mjs';
import { createClaudeCli } from '../bridges/v1/claude-cli.mjs';
import { createCodexCli } from '../bridges/v1/codex-cli.mjs';

if (process.env.SIGIL_LIVE_ROOM_BRIDGES !== '1') {
  console.error('Refusing to run: set SIGIL_LIVE_ROOM_BRIDGES=1 to use the real claude and codex CLIs.');
  process.exit(2);
}

const WAIT_MS = 15 * 60_000;
const quiet = { log() {}, warn() {}, error() {} };
const outboxFor = (identity) => new LocalOutbox({ privateKey: identityKeys(identity).privateKey, endpoint: { owner_id: identity.owner_id, endpoint_id: identity.endpoint_id, key_id: identity.key_id, kind: identity.kind } });

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

await repository.createRoom({ conversationId: 'room_live', workspaceId: 'ws_usr_chris', name: 'live', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web' });
for (const id of ['ep_claude', 'ep_codex']) {
  await repository.addRoomMember({ conversationId: 'room_live', endpointId: id, role: 'member', responseMode: 'joins', addedByHumanId: 'usr_chris' });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-live-'));
const cwd = path.join(dir, 'cwd');
fs.mkdirSync(cwd);
const daemons = [[claude, createClaudeCli({ cwd })], [codex, createCodexCli({ cwd })]].map(([identity, cli]) => {
  const bridge = createRoomBridge({ identity, relay: new RelayClient({ baseUrl: relayUrl, token: identity.relay_token }), outbox: outboxFor(identity), cli, sessions: createSessionStore(path.join(dir, `${identity.endpoint_id}.json`)), pollIntervalMs: 500, logger: console });
  const daemon = createAgentDaemon({ identity, relayUrl, onRoomMessage: bridge.handle, pollIntervalMs: 500, logger: quiet });
  daemon.start();
  return daemon;
});

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
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: 'room_live', message_type: 'room.message',
    broadcast_scope: { conversation_id: 'room_live' }, correlation_id: null,
    body: { text: '@ep_claude Agree with @ep_codex on a name for a CLI that syncs notes. Each turn, propose or critique one name, then hand over with an @mention.', mentions: ['ep_claude'] },
    context_refs: [], capabilities: [], idempotency_key: `idem_${crypto.randomUUID()}`,
    created_at: now.toISOString(), expires_at: new Date(now.getTime() + 3600_000).toISOString(),
  });
  await humanClient.sendEnvelope(queued.envelope);

  const deadline = Date.now() + WAIT_MS;
  let refused;
  while (Date.now() < deadline) {
    refused = (await repository.listRoomInvocations('room_live', { status: 'refused' })).find((r) => r.reason === 'hop_budget');
    if (refused && !(await repository.listRoomInvocations('room_live')).some((r) => r.status === 'running' || r.status === 'queued')) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const messages = await repository.listRoomMessages('room_live', 0n, 100);
  const turns = messages.filter((m) => m.envelope.sender.endpoint_id !== 'ep_web');
  for (const m of messages) console.log(`[${m.room_seq ?? m.seq}] ${m.envelope.sender.endpoint_id}: ${m.envelope.body.text}`);
  console.log('\nendpoint_id status reason');
  for (const r of await repository.listRoomInvocations('room_live')) console.log(`${r.endpoint_id} ${r.status} ${r.reason ?? ''}`);

  const senders = turns.map((m) => m.envelope.sender.endpoint_id);
  const alternates = senders.every((s, i) => i === 0 || s !== senders[i - 1]);
  console.log(`\nagent turns: ${turns.length}, alternating: ${alternates}, hop_budget refusal: ${Boolean(refused)}`);
  exitCode = turns.length === 6 && alternates && refused ? 0 : 1;
} catch (error) {
  console.error(error);
} finally {
  await shutdown();
}
process.exit(exitCode);
