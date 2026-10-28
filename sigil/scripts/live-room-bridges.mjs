#!/usr/bin/env node
// sigil/scripts/live-room-bridges.mjs
// Opt-in live smoke for room bridges that shipped (Task 14 / issue #100).
// Skip (exit 0) unless SIGIL_LIVE_BRIDGES=1.
// Branch B: copilot always; claude/codex when present. Grok/Hermes/Antigravity deferred.
// Not a *.test.mjs file, so `node --test` skips it. Must not reference SIGIL_TEST_DATABASE_URL.
import { spawnSync } from 'node:child_process';
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
import { createCopilotCli } from '../bridges/v1/copilot-cli.mjs';

if (process.env.SIGIL_LIVE_BRIDGES !== '1') {
  console.log('SIGIL_LIVE_BRIDGES not set; skipping live room bridges smoke (exit 0)');
  process.exit(0);
}

function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim().split(/\r?\n/).filter(Boolean)[0] : null;
}

const WAIT_MS = 120_000;
const quiet = { log() {}, warn() {}, error() {} };
const outboxFor = (identity) => new LocalOutbox({
  privateKey: identityKeys(identity).privateKey,
  endpoint: {
    owner_id: identity.owner_id,
    endpoint_id: identity.endpoint_id,
    key_id: identity.key_id,
    kind: identity.kind,
  },
});

const candidates = [
  {
    endpointId: 'ep_copilot',
    bin: 'copilot',
    create: (cwd) => createCopilotCli({ cwd, allowedTools: ['view', 'grep', 'glob'] }),
  },
  {
    endpointId: 'ep_claude',
    bin: 'claude',
    create: (cwd) => createClaudeCli({ cwd }),
  },
  {
    endpointId: 'ep_codex',
    bin: 'codex',
    create: (cwd) => createCodexCli({ cwd }),
  },
];

const available = candidates.filter((c) => which(c.bin));
if (available.length === 0) {
  console.error('SIGIL_LIVE_BRIDGES=1 but none of copilot/claude/codex are on PATH');
  process.exit(1);
}

console.log(`live-room-bridges: Branch B — using ${available.map((c) => c.bin).join(', ')}`);
console.log('live-room-bridges: Grok/Hermes/Antigravity deferred (no live endpoints)');

const human = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_web', kind: 'human' });
const agents = available.map((c) => createIdentity({
  ownerId: 'usr_chris',
  endpointId: c.endpointId,
  kind: 'agent',
}));
const all = [human, ...agents];
const registry = new Map(all.map((id) => [id.endpoint_id, {
  owner_id: id.owner_id,
  endpoint_id: id.endpoint_id,
  key_id: id.key_id,
  kind: id.kind,
  status: 'active',
  public_key: crypto.createPublicKey(id.public_key_pem),
}]));
const tokenHashes = new Map(all.map((id) => [hashBearerToken(id.relay_token), id.endpoint_id]));
const repository = createMemoryRepository({ registry });
const server = createRelayServer({ registry, repository, tokenHashes });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const relayUrl = `http://127.0.0.1:${server.address().port}`;
const ROOM = 'room_live_bridges';

await repository.createRoom({
  conversationId: ROOM,
  workspaceId: 'ws_usr_chris',
  name: 'live-bridges',
  createdByHumanId: 'usr_chris',
  ownerEndpointId: 'ep_web',
});
for (const agent of agents) {
  await repository.addRoomMember({
    conversationId: ROOM,
    endpointId: agent.endpoint_id,
    role: 'member',
    responseMode: 'joins',
    addedByHumanId: 'usr_chris',
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-live-bridges-'));
const cwd = path.join(dir, 'cwd');
fs.mkdirSync(cwd);
fs.writeFileSync(path.join(cwd, 'README.md'), '# live bridges smoke\nReply briefly.\n');

const daemons = available.map((c, i) => {
  const identity = agents[i];
  const cli = c.create(cwd);
  const bridge = createRoomBridge({
    identity,
    relay: new RelayClient({ baseUrl: relayUrl, token: identity.relay_token }),
    outbox: outboxFor(identity),
    cli,
    sessions: createSessionStore(path.join(dir, `${identity.endpoint_id}.json`)),
    pollIntervalMs: 500,
    logger: console,
  });
  const daemon = createAgentDaemon({
    identity,
    relayUrl,
    onRoomMessage: bridge.handle,
    pollIntervalMs: 500,
    logger: quiet,
  });
  daemon.start();
  return daemon;
});

async function shutdown() {
  for (const daemon of daemons) daemon.stop();
  await new Promise((resolve) => server.close(resolve));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* CLI may hold cwd */ }
}

let exitCode = 1;
try {
  const humanClient = new RelayClient({ baseUrl: relayUrl, token: human.relay_token });
  const expected = new Set(agents.map((a) => a.endpoint_id));

  for (const agent of agents) {
    const now = new Date();
    const queued = outboxFor(human).queue({
      protocol: 'sigil/1',
      message_id: `msg_${crypto.randomUUID()}`,
      conversation_id: ROOM,
      message_type: 'room.message',
      broadcast_scope: { conversation_id: ROOM },
      correlation_id: null,
      body: {
        text: `@${agent.endpoint_id} Reply with one short sentence confirming you can read README.md. Do not edit files.`,
        mentions: [agent.endpoint_id],
      },
      context_refs: [],
      capabilities: [],
      idempotency_key: `idem_${crypto.randomUUID()}`,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 3600_000).toISOString(),
    });
    await humanClient.sendEnvelope(queued.envelope);
  }

  const deadline = Date.now() + WAIT_MS;
  const seen = new Set();
  while (Date.now() < deadline && seen.size < expected.size) {
    const messages = await repository.listRoomMessages(ROOM, 0n, 100);
    for (const m of messages) {
      const id = m.envelope.sender.endpoint_id;
      if (expected.has(id) && m.envelope.body?.text?.trim()) seen.add(id);
    }
    if (seen.size >= expected.size) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const messages = await repository.listRoomMessages(ROOM, 0n, 100);
  for (const m of messages) {
    console.log(`[${m.room_seq ?? m.seq}] ${m.envelope.sender.endpoint_id}: ${String(m.envelope.body?.text || '').slice(0, 200)}`);
  }
  console.log(`\nreplies: ${seen.size}/${expected.size} (${[...seen].join(', ') || 'none'})`);
  exitCode = seen.size === expected.size ? 0 : 1;
  if (exitCode === 0) console.log('live-room-bridges: PASS');
  else console.error('live-room-bridges: FAIL — missing replies from', [...expected].filter((id) => !seen.has(id)).join(', '));
} catch (error) {
  console.error(error);
} finally {
  await shutdown();
}
process.exit(exitCode);
