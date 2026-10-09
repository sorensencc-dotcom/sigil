# Sigil Tincan transport bridge implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add room tools to Sigil's existing stdio MCP server, and build the Tincan transport pieces (Tailscale node-to-endpoint auth, wake dispatcher, retry state machine, immutable held queue) that wake a remote agent bridge on demand.

**Architecture:** Everything is plain Node `.mjs` inside the existing `sigil/` tree, reusing `RelayClient`, `LocalOutbox`, `signedBytes`, and the hand-rolled `mcp-stdio-server.mjs`. No new package, no TypeScript, no MCP SDK or zod dependency. Milestone 1 adds three room tools to the existing MCP handler. Milestone 2 adds a `transport-tincan/` module of four small, injectable units. Milestone 3 is one integration test that proves the units compose and that the held-queue hash matches the relay's real risk gate.

**Tech Stack:** Node 24 `.mjs`, `node:test`, existing Sigil relay contracts. Tailscale local API is injected as a function, so tests need no Tailscale.

**Spec:** `docs/superpowers/specs/2026-10-09-sigil-tincan-transport-bridge.md`

## Global Constraints

- Work only in the worktree `C:\dev\.worktrees\sigil-tincan` on branch `feat/sigil-tincan-bridge` (from `origin/main` at `7a0a4b4`). Never switch branches in `C:\dev\sigil-repo`.
- Run every test under `node --test --test-timeout=30000 <file>`. A run silent for 60 seconds is hung: abort and report.
- Relay authority is unchanged: the relay assigns `room_seq`. Clients and transport code never mint it.
- Agents post room messages as signed `room.message` broadcast envelopes through `RelayClient.sendEnvelope` (`POST /v1/envelopes`). `POST /v1/rooms/{id}/messages` is human-only and returns `403 NO_SIGNING_KEY` for agents. Do not use it from agent code.
- `task.request` and `task.result` are refused inside rooms (`ROOM_MESSAGE_TYPES` in `sigil/relay/v1/room-policy.mjs` is `['room.message']`). No task-dispatch tool ships until the relay re-adds them with an assignee field.
- `POST /v1/rooms/{room_id}/invocations/fail` fails the **caller's own** running invocation. It must be called with the agent endpoint's own bearer token (`RelayClient.failRoomInvocation(roomId, reason, invocationId)`).
- Approval hash is `sha256(signedBytes(envelope))` as a hex digest, using `signedBytes` from `sigil/relay/v1/validate-envelope.mjs`. Never `JSON.stringify`.
- `POST /v1/approval-challenges` body is `{ action_hash, callback_url }`. The endpoint ID comes from the authenticated principal.
- Cumulative wake deadline is 45000 ms, 3 attempts maximum.
- `agent run --room-bridge` accepts `claude|codex|router` only. There is no `grok` bridge on `main`.
- Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Files are LF. Docs follow sentence-case headings, no first-person plural, active voice.

---

## File structure

Modify:
- `sigil/connectors/v1/mcp-stdio-server.mjs`: add three entries to `TOOLS`, load a rooms runtime from the environment.
- `sigil/connectors/v1/mcp-stdio-server.test.mjs`: tool count 6 becomes 9.

Create:
- `sigil/connectors/v1/rooms-mcp-tools.mjs`: `createRoomsRuntime({ relay, outbox })`.
- `sigil/connectors/v1/rooms-mcp-tools.test.mjs`
- `sigil/relay/v1/transport-tincan/whois-auth.mjs` and `.test.mjs`
- `sigil/relay/v1/transport-tincan/wake-dispatcher.mjs` and `.test.mjs`
- `sigil/relay/v1/transport-tincan/dispatch-lifecycle.mjs` and `.test.mjs`
- `sigil/relay/v1/transport-tincan/held-queue.mjs` and `.test.mjs`
- `sigil/relay/v1/transport-tincan/tincan-integration.test.mjs`

---

### Task 1: Rooms runtime for the MCP server

**Files:**
- Create: `sigil/connectors/v1/rooms-mcp-tools.mjs`
- Test: `sigil/connectors/v1/rooms-mcp-tools.test.mjs`

**Interfaces:**
- Consumes: `RelayClient` (`request`, `listRoomMessages`, `sendEnvelope`) and `LocalOutbox` (`queue`) from `sigil/connectors/v1/`.
- Produces: `createRoomsRuntime({ relay, outbox, now? })` returning `{ listRooms(): Promise<Room[]>, readRoom({ room_id, after_seq?, limit? }): Promise<{items, next_after_seq}>, postMessage({ room_id, text, thread_root_id?, mentions?, idempotency_key? }): Promise<unknown> }`.

- [ ] **Step 1: Write the failing test**

```javascript
// sigil/connectors/v1/rooms-mcp-tools.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomsRuntime } from './rooms-mcp-tools.mjs';

function fakes() {
  const sent = [];
  const relay = {
    request: async (path) => { assert.equal(path, '/v1/rooms'); return { items: [{ conversation_id: 'room_1', name: 'triage' }] }; },
    listRoomMessages: async (roomId, afterSeq, limit) => ({ items: [{ room_seq: '1' }], next_after_seq: '1', _args: [roomId, afterSeq, limit] }),
    sendEnvelope: async (envelope) => { sent.push(envelope); return { code: 'OK' }; },
  };
  const outbox = { queue: (envelope) => ({ envelope: { ...envelope, signature: { value: 'sig' } } }) };
  return { relay, outbox, sent };
}

test('listRooms returns relay items', async () => {
  const { relay, outbox } = fakes();
  const rooms = await createRoomsRuntime({ relay, outbox }).listRooms();
  assert.equal(rooms[0].conversation_id, 'room_1');
});

test('readRoom defaults to after_seq 0 and limit 50', async () => {
  const { relay, outbox } = fakes();
  const page = await createRoomsRuntime({ relay, outbox }).readRoom({ room_id: 'room_1' });
  assert.deepEqual(page._args, ['room_1', '0', 50]);
});

test('postMessage sends a signed room.message broadcast with a stable idempotency key', async () => {
  const { relay, outbox, sent } = fakes();
  const runtime = createRoomsRuntime({ relay, outbox, now: () => new Date('2026-10-09T12:00:00Z') });
  await runtime.postMessage({ room_id: 'room_1', text: 'hello', mentions: ['ep_codex'], idempotency_key: 'k1' });
  const envelope = sent[0];
  assert.equal(envelope.message_type, 'room.message');
  assert.equal(envelope.conversation_id, 'room_1');
  assert.deepEqual(envelope.broadcast_scope, { conversation_id: 'room_1' });
  assert.deepEqual(envelope.body, { text: 'hello', thread_root_id: null, mentions: ['ep_codex'] });
  assert.equal(envelope.idempotency_key, 'mcp_post_k1');
  assert.equal(envelope.signature.value, 'sig');
});

test('postMessage rejects empty text and text over 16000 characters', async () => {
  const { relay, outbox } = fakes();
  const runtime = createRoomsRuntime({ relay, outbox });
  await assert.rejects(runtime.postMessage({ room_id: 'room_1', text: '  ' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(runtime.postMessage({ room_id: 'room_1', text: 'x'.repeat(16001) }), { code: 'INVALID_REQUEST' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-timeout=30000 sigil/connectors/v1/rooms-mcp-tools.test.mjs`
Expected: FAIL with `Cannot find module './rooms-mcp-tools.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// sigil/connectors/v1/rooms-mcp-tools.mjs
import crypto from 'node:crypto';

const TEXT_MAX = 16000;
const REPLY_TTL_MS = 24 * 3600_000;

function invalid(message) { return Object.assign(new Error(message), { code: 'INVALID_REQUEST' }); }

export function createRoomsRuntime({ relay, outbox, now = () => new Date() }) {
  return {
    async listRooms() { return (await relay.request('/v1/rooms')).items; },

    async readRoom({ room_id, after_seq = '0', limit = 50 }) {
      if (!room_id) throw invalid('room_id is required');
      return relay.listRoomMessages(room_id, String(after_seq), limit);
    },

    async postMessage({ room_id, text, thread_root_id = null, mentions = [], idempotency_key }) {
      if (!room_id) throw invalid('room_id is required');
      if (typeof text !== 'string' || !text.trim() || text.length > TEXT_MAX) throw invalid(`text must be 1 to ${TEXT_MAX} characters`);
      const created = now();
      const { envelope } = outbox.queue({
        protocol: 'sigil/1',
        message_id: `msg_${crypto.randomUUID()}`,
        conversation_id: room_id,
        message_type: 'room.message',
        broadcast_scope: { conversation_id: room_id },
        correlation_id: null,
        body: { text, thread_root_id, mentions },
        context_refs: [],
        capabilities: [],
        idempotency_key: `mcp_post_${idempotency_key ?? crypto.randomUUID()}`,
        created_at: created.toISOString(),
        expires_at: new Date(created.getTime() + REPLY_TTL_MS).toISOString(),
      });
      return relay.sendEnvelope(envelope);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-timeout=30000 sigil/connectors/v1/rooms-mcp-tools.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add sigil/connectors/v1/rooms-mcp-tools.mjs sigil/connectors/v1/rooms-mcp-tools.test.mjs
git commit -m "feat(mcp): add rooms runtime for list, read, and agent post

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Wire room tools into the stdio MCP server

**Files:**
- Modify: `sigil/connectors/v1/mcp-stdio-server.mjs` (`TOOLS` at line 5, `TOOL_SCHEMAS` at line 14, `runtimeFromEnvironment` at line 59)
- Modify: `sigil/connectors/v1/mcp-stdio-server.test.mjs` (tool count assertion, first test)

**Interfaces:**
- Consumes: `createRoomsRuntime` from Task 1; `loadIdentity`, `identityKeys` from `sigil/cli/identity.mjs`; `RelayClient`, `LocalOutbox`.
- Produces: tools `sigil_list_rooms` (runtime `listRooms`), `sigil_read_room` (`readRoom`), `sigil_post_message` (`postMessage`). Room runtime methods are merged onto the host runtime when `SIGIL_ROOMS_IDENTITY` is set.

- [ ] **Step 1: Write the failing test**

Edit the first test in `mcp-stdio-server.test.mjs`: change `assert.equal(writes[0].result.tools.length, 6)` to `9`. Append:

```javascript
test('stdio MCP handler routes room tools to the runtime', async () => {
  const writes = [];
  const handler = createMcpHandler({
    runtime: 'codex',
    listRooms: async () => [{ conversation_id: 'room_1' }],
    readRoom: async (args) => ({ items: [], echoed: args.room_id }),
    postMessage: async (args) => ({ code: 'OK', text: args.text }),
  });
  const original = process.stdout.write; process.stdout.write = (value) => { writes.push(JSON.parse(value)); return true; };
  try {
    await handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sigil_list_rooms', arguments: {} } });
    await handler({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sigil_read_room', arguments: { room_id: 'room_1' } } });
    await handler({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sigil_post_message', arguments: { room_id: 'room_1', text: 'hi' } } });
  } finally { process.stdout.write = original; }
  assert.equal(JSON.parse(writes[0].result.content[0].text)[0].conversation_id, 'room_1');
  assert.equal(JSON.parse(writes[1].result.content[0].text).echoed, 'room_1');
  assert.equal(JSON.parse(writes[2].result.content[0].text).text, 'hi');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-timeout=30000 sigil/connectors/v1/mcp-stdio-server.test.mjs`
Expected: FAIL (`6 !== 9` and `Unknown Sigil tool`)

- [ ] **Step 3: Write minimal implementation**

In `mcp-stdio-server.mjs`, add imports at the top:

```javascript
import { loadIdentity, identityKeys } from '../../cli/identity.mjs';
import { RelayClient } from './relay-client.mjs';
import { LocalOutbox } from './local-outbox.mjs';
import { createRoomsRuntime } from './rooms-mcp-tools.mjs';
```

Append three rows to `TOOLS` (after the `sigil_resolve_context` row, adding a comma to it):

```javascript
  ['sigil_list_rooms', 'List rooms visible to this endpoint.', 'listRooms'],
  ['sigil_read_room', 'Read room history after a room_seq watermark.', 'readRoom'],
  ['sigil_post_message', 'Post a signed room.message as this endpoint.', 'postMessage']
```

Add schemas inside `TOOL_SCHEMAS` (after `sigil_ack_delivery`, comma-separated):

```javascript
  sigil_read_room: { type: 'object', properties: { room_id: { type: 'string' }, after_seq: { type: 'string' }, limit: { type: 'integer', maximum: 100 } }, required: ['room_id'] },
  sigil_post_message: { type: 'object', properties: { room_id: { type: 'string' }, text: { type: 'string', maxLength: 16000 }, thread_root_id: { type: 'string' }, mentions: { type: 'array', items: { type: 'string' } }, idempotency_key: { type: 'string' } }, required: ['room_id', 'text'] }
```

In `runtimeFromEnvironment`, replace the final `return createCodexHostRuntime({ ...common, ...overrides });` and the claude return so both merge a rooms runtime. Add a helper above `runtimeFromEnvironment`:

```javascript
function roomsRuntimeFromEnvironment(env, common) {
  if (!env.SIGIL_ROOMS_IDENTITY) return {};
  const identity = loadIdentity(env.SIGIL_ROOMS_IDENTITY);
  const relay = new RelayClient({ baseUrl: common.baseUrl, token: common.token });
  const outbox = new LocalOutbox({ privateKey: identityKeys(identity).privateKey, endpoint: { owner_id: identity.owner_id, endpoint_id: identity.endpoint_id, key_id: identity.key_id, kind: identity.kind } });
  return createRoomsRuntime({ relay, outbox });
}
```

Then change the two returns to `return { ...createClaudeHostRuntime({ ...common, ...overrides, processTask }), ...roomsRuntimeFromEnvironment(env, common) };` and `return { ...createCodexHostRuntime({ ...common, ...overrides }), ...roomsRuntimeFromEnvironment(env, common) };`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-timeout=30000 sigil/connectors/v1/mcp-stdio-server.test.mjs sigil/connectors/v1/rooms-mcp-tools.test.mjs`
Expected: PASS, all tests

- [ ] **Step 5: Commit**

```bash
git add sigil/connectors/v1/mcp-stdio-server.mjs sigil/connectors/v1/mcp-stdio-server.test.mjs
git commit -m "feat(mcp): expose room list, read, and post tools on the stdio server

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Tailscale node-to-endpoint auth

**Files:**
- Create: `sigil/relay/v1/transport-tincan/whois-auth.mjs`
- Test: `sigil/relay/v1/transport-tincan/whois-auth.test.mjs`

**Interfaces:**
- Produces: `verifyTailscaleWhoIs({ remoteAddress, senderEndpoint?, targetEndpoint? }, allowlist: Map<nodeKey, {permitted_endpoints: string[], allowed_host_roles: string[]}>, tailscale: { whois(addr): Promise<{Node:{Key,Name}, UserProfile?:{LoginName}}|null> })` resolving to `{ nodeKey, machineName, loginName, allowedRoles }`, or throwing an Error with `.code` of `UNAUTHORIZED_NODE`, `NODE_NOT_IN_ALLOWLIST`, or `NODE_NOT_AUTHORIZED_FOR_ENDPOINT`.

- [ ] **Step 1: Write the failing test**

```javascript
// sigil/relay/v1/transport-tincan/whois-auth.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTailscaleWhoIs } from './whois-auth.mjs';

const node = { Node: { Key: 'nodekey:abc', Name: 'gpu-1' }, UserProfile: { LoginName: 'soren@tailnet' } };
const allowlist = new Map([['nodekey:abc', { permitted_endpoints: ['ep_codex'], allowed_host_roles: ['agent_runner'] }]]);
const tailscale = (value) => ({ whois: async () => value });

test('unknown address fails closed', async () => {
  await assert.rejects(verifyTailscaleWhoIs({ remoteAddress: '100.64.0.1' }, allowlist, tailscale(null)), { code: 'UNAUTHORIZED_NODE' });
});

test('tailnet node missing from the allowlist is refused', async () => {
  await assert.rejects(verifyTailscaleWhoIs({ remoteAddress: '100.64.0.1' }, new Map(), tailscale(node)), { code: 'NODE_NOT_IN_ALLOWLIST' });
});

test('sender endpoint outside permitted_endpoints is refused', async () => {
  await assert.rejects(verifyTailscaleWhoIs({ remoteAddress: '100.64.0.1', senderEndpoint: 'ep_rogue' }, allowlist, tailscale(node)), { code: 'NODE_NOT_AUTHORIZED_FOR_ENDPOINT' });
});

test('target endpoint outside permitted_endpoints is refused before wake', async () => {
  await assert.rejects(verifyTailscaleWhoIs({ remoteAddress: '100.64.0.1', targetEndpoint: 'ep_other' }, allowlist, tailscale(node)), { code: 'NODE_NOT_AUTHORIZED_FOR_ENDPOINT' });
});

test('authorized sender and target pass', async () => {
  const result = await verifyTailscaleWhoIs({ remoteAddress: '100.64.0.1', senderEndpoint: 'ep_codex', targetEndpoint: 'ep_codex' }, allowlist, tailscale(node));
  assert.deepEqual(result, { nodeKey: 'nodekey:abc', machineName: 'gpu-1', loginName: 'soren@tailnet', allowedRoles: ['agent_runner'] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-timeout=30000 sigil/relay/v1/transport-tincan/whois-auth.test.mjs`
Expected: FAIL with `Cannot find module './whois-auth.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// sigil/relay/v1/transport-tincan/whois-auth.mjs
function refuse(code, message, details = {}) { return Object.assign(new Error(message), { code, details }); }

export async function verifyTailscaleWhoIs({ remoteAddress, senderEndpoint, targetEndpoint }, allowlist, tailscale) {
  const whois = await tailscale.whois(remoteAddress);
  if (!whois?.Node?.Key) throw refuse('UNAUTHORIZED_NODE', 'Connection is not from a Tailnet node');
  const nodeKey = whois.Node.Key;
  const config = allowlist.get(nodeKey);
  if (!config) throw refuse('NODE_NOT_IN_ALLOWLIST', `Node ${nodeKey} is not in the allowlist`, { nodeKey });
  for (const endpoint of [senderEndpoint, targetEndpoint]) {
    if (endpoint && !config.permitted_endpoints.includes(endpoint)) {
      throw refuse('NODE_NOT_AUTHORIZED_FOR_ENDPOINT', `Node ${nodeKey} is not authorized for ${endpoint}`, { nodeKey, endpoint });
    }
  }
  return { nodeKey, machineName: whois.Node.Name, loginName: whois.UserProfile?.LoginName, allowedRoles: config.allowed_host_roles };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-timeout=30000 sigil/relay/v1/transport-tincan/whois-auth.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/transport-tincan/whois-auth.mjs sigil/relay/v1/transport-tincan/whois-auth.test.mjs
git commit -m "feat(tincan): add tailscale node-to-endpoint allowlist check

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wake dispatcher

**Files:**
- Create: `sigil/relay/v1/transport-tincan/wake-dispatcher.mjs`
- Test: `sigil/relay/v1/transport-tincan/wake-dispatcher.test.mjs`

**Interfaces:**
- Produces: `createWakeDispatcher({ spawnFn, checkRunningFn })` returning `{ wakeAgent({ endpointId, bridgeType, identityPath, relayUrl, sessionStore? }): Promise<{ alreadyRunning: boolean, endpointId: string, pid?: number }> }`. `bridgeType` must be `claude`, `codex`, or `router`; anything else throws `INVALID_REQUEST`. `spawnFn(command, args)` resolves to `{ pid }`.

- [ ] **Step 1: Write the failing test**

```javascript
// sigil/relay/v1/transport-tincan/wake-dispatcher.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWakeDispatcher } from './wake-dispatcher.mjs';

test('no spawn when the bridge already runs', async () => {
  const dispatcher = createWakeDispatcher({ checkRunningFn: async () => true, spawnFn: async () => { throw new Error('must not spawn'); } });
  const result = await dispatcher.wakeAgent({ endpointId: 'ep_codex', bridgeType: 'codex', identityPath: 'i.json', relayUrl: 'http://127.0.0.1:8791' });
  assert.deepEqual(result, { alreadyRunning: true, endpointId: 'ep_codex' });
});

test('spawns sigil agent run with the real CLI flags for a sleeping bridge', async () => {
  let call;
  const dispatcher = createWakeDispatcher({ checkRunningFn: async () => false, spawnFn: async (command, args) => { call = { command, args }; return { pid: 42 }; } });
  const result = await dispatcher.wakeAgent({ endpointId: 'ep_codex', bridgeType: 'codex', identityPath: 'i.json', relayUrl: 'http://127.0.0.1:8791', sessionStore: 's.json' });
  assert.equal(call.command, 'node');
  assert.deepEqual(call.args, ['sigil/cli/sigil.mjs', 'agent', 'run', '--identity', 'i.json', '--relay-url', 'http://127.0.0.1:8791', '--room-bridge', 'codex', '--room-sessions', 's.json']);
  assert.deepEqual(result, { alreadyRunning: false, endpointId: 'ep_codex', pid: 42 });
});

test('rejects a bridge type the CLI does not support', async () => {
  const dispatcher = createWakeDispatcher({ checkRunningFn: async () => false, spawnFn: async () => ({ pid: 1 }) });
  await assert.rejects(dispatcher.wakeAgent({ endpointId: 'ep_x', bridgeType: 'grok', identityPath: 'i.json', relayUrl: 'u' }), { code: 'INVALID_REQUEST' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-timeout=30000 sigil/relay/v1/transport-tincan/wake-dispatcher.test.mjs`
Expected: FAIL with `Cannot find module './wake-dispatcher.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// sigil/relay/v1/transport-tincan/wake-dispatcher.mjs
const BRIDGES = new Set(['claude', 'codex', 'router']);

export function createWakeDispatcher({ spawnFn, checkRunningFn }) {
  return {
    async wakeAgent({ endpointId, bridgeType, identityPath, relayUrl, sessionStore = '.sigil/room-sessions.json' }) {
      if (!BRIDGES.has(bridgeType)) throw Object.assign(new Error(`Unsupported room bridge: ${bridgeType}`), { code: 'INVALID_REQUEST' });
      if (await checkRunningFn(endpointId)) return { alreadyRunning: true, endpointId };
      const args = ['sigil/cli/sigil.mjs', 'agent', 'run', '--identity', identityPath, '--relay-url', relayUrl, '--room-bridge', bridgeType, '--room-sessions', sessionStore];
      const child = await spawnFn('node', args);
      return { alreadyRunning: false, endpointId, pid: child.pid };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-timeout=30000 sigil/relay/v1/transport-tincan/wake-dispatcher.test.mjs`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/transport-tincan/wake-dispatcher.mjs sigil/relay/v1/transport-tincan/wake-dispatcher.test.mjs
git commit -m "feat(tincan): add wake dispatcher using real agent run flags

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Retry state machine with the 45-second budget

**Files:**
- Create: `sigil/relay/v1/transport-tincan/dispatch-lifecycle.mjs`
- Test: `sigil/relay/v1/transport-tincan/dispatch-lifecycle.test.mjs`

**Interfaces:**
- Produces: `dispatchDeliveryWithRetry({ delivery: { conversation_id, invocation_id }, wakeFn(attemptTimeoutMs), failFn(roomId, reason, invocationId), maxAttempts = 3, timeoutBudgetMs = 45000, backoffMs = [5000, 15000], sleepFn, nowFn })` resolving to the `wakeFn` result on success or `{ status: 'FAILED', reason }` after calling `failFn`.
- `failFn` is `RelayClient.failRoomInvocation` bound to the **agent's own token**. Reasons: `wake_process_failed` (error with `.exitCode`, no retry), `wake_timeout` (retries or budget exhausted).
- Out of scope: `host_unreachable`. The agent's token lives on the unreachable host, so the route cannot be called for it. The spec records this as an open relay-side gap.

- [ ] **Step 1: Write the failing test**

```javascript
// sigil/relay/v1/transport-tincan/dispatch-lifecycle.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchDeliveryWithRetry } from './dispatch-lifecycle.mjs';

const delivery = { conversation_id: 'room_1', invocation_id: 'inv_1' };
const timeout = () => Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });

function harness(overrides = {}) {
  const fails = [];
  let clock = 0;
  return {
    fails,
    args: {
      delivery,
      failFn: async (roomId, reason, invocationId) => { fails.push({ roomId, reason, invocationId }); },
      sleepFn: async (ms) => { clock += ms; },
      nowFn: () => clock,
      ...overrides,
    },
  };
}

test('succeeds on the second attempt without failing the invocation', async () => {
  let calls = 0;
  const { fails, args } = harness({ wakeFn: async () => { if (++calls === 1) throw timeout(); return { status: 'DELIVERED' }; } });
  assert.deepEqual(await dispatchDeliveryWithRetry(args), { status: 'DELIVERED' });
  assert.equal(calls, 2);
  assert.deepEqual(fails, []);
});

test('three timeouts fail the invocation once with wake_timeout', async () => {
  let calls = 0;
  const { fails, args } = harness({ wakeFn: async () => { calls++; throw timeout(); } });
  assert.deepEqual(await dispatchDeliveryWithRetry(args), { status: 'FAILED', reason: 'wake_timeout' });
  assert.equal(calls, 3);
  assert.deepEqual(fails, [{ roomId: 'room_1', reason: 'wake_timeout', invocationId: 'inv_1' }]);
});

test('a crashed child fails immediately with wake_process_failed and no retry', async () => {
  let calls = 0;
  const { fails, args } = harness({ wakeFn: async () => { calls++; throw Object.assign(new Error('exit 1'), { exitCode: 1 }); } });
  assert.deepEqual(await dispatchDeliveryWithRetry(args), { status: 'FAILED', reason: 'wake_process_failed' });
  assert.equal(calls, 1);
  assert.equal(fails[0].reason, 'wake_process_failed');
});

test('the 45 second budget stops retries early', async () => {
  let calls = 0;
  const { fails, args } = harness({ timeoutBudgetMs: 20000, backoffMs: [25000, 25000], wakeFn: async () => { calls++; throw timeout(); } });
  assert.deepEqual(await dispatchDeliveryWithRetry(args), { status: 'FAILED', reason: 'wake_timeout' });
  assert.equal(calls, 1, 'the first backoff alone exceeds the budget');
  assert.equal(fails.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-timeout=30000 sigil/relay/v1/transport-tincan/dispatch-lifecycle.test.mjs`
Expected: FAIL with `Cannot find module './dispatch-lifecycle.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// sigil/relay/v1/transport-tincan/dispatch-lifecycle.mjs
const ATTEMPT_TIMEOUT_MS = 15000;

export async function dispatchDeliveryWithRetry({
  delivery, wakeFn, failFn,
  maxAttempts = 3, timeoutBudgetMs = 45000, backoffMs = [5000, 15000],
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), nowFn = Date.now,
}) {
  const startedAt = nowFn();
  const fail = async (reason) => {
    await failFn(delivery.conversation_id, reason, delivery.invocation_id);
    return { status: 'FAILED', reason };
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await wakeFn(ATTEMPT_TIMEOUT_MS);
    } catch (error) {
      if (error.exitCode) return fail('wake_process_failed');
      const wait = backoffMs[attempt - 1] ?? 0;
      if (attempt === maxAttempts || nowFn() - startedAt + wait >= timeoutBudgetMs) return fail('wake_timeout');
      await sleepFn(wait);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-timeout=30000 sigil/relay/v1/transport-tincan/dispatch-lifecycle.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/transport-tincan/dispatch-lifecycle.mjs sigil/relay/v1/transport-tincan/dispatch-lifecycle.test.mjs
git commit -m "feat(tincan): add wake retry state machine with 45s budget

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Immutable held queue bound to the relay's action hash

**Files:**
- Create: `sigil/relay/v1/transport-tincan/held-queue.mjs`
- Test: `sigil/relay/v1/transport-tincan/held-queue.test.mjs`

**Interfaces:**
- Consumes: `signedBytes` from `sigil/relay/v1/validate-envelope.mjs`.
- Produces: `canonicalEnvelopeHash(envelope): string` (hex sha256 of `signedBytes(envelope)`), and `createHeldQueue({ callbackUrl, submitChallengeFn })` returning `{ holdForApproval(envelope, token): Promise<{actionHash, challengeId}>, releaseEnvelope(actionHash): envelope }`. `submitChallengeFn({ action_hash, callback_url }, token)` resolves to `{ challenge_id }`. Held envelopes are deep-frozen.

- [ ] **Step 1: Write the failing test**

```javascript
// sigil/relay/v1/transport-tincan/held-queue.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signedBytes } from '../validate-envelope.mjs';
import { canonicalEnvelopeHash, createHeldQueue } from './held-queue.mjs';

const envelope = () => ({ protocol: 'sigil/1', message_id: 'msg_1', sender: { endpoint_id: 'ep_claude' }, message_type: 'task.request', body: { task_id: 't1' }, signature: { value: 'abc' } });

test('hash is the hex sha256 of signedBytes and ignores the signature field', () => {
  const expected = crypto.createHash('sha256').update(signedBytes(envelope())).digest('hex');
  assert.equal(canonicalEnvelopeHash(envelope()), expected);
  assert.equal(canonicalEnvelopeHash({ ...envelope(), signature: { value: 'different' } }), expected);
});

test('holdForApproval submits action_hash and callback_url only', async () => {
  let submitted;
  const queue = createHeldQueue({ callbackUrl: 'http://127.0.0.1:8795/v1/approval-callback', submitChallengeFn: async (body, token) => { submitted = { body, token }; return { challenge_id: 'ch_1' }; } });
  const result = await queue.holdForApproval(envelope(), 'tok');
  assert.equal(result.challengeId, 'ch_1');
  assert.deepEqual(Object.keys(submitted.body).sort(), ['action_hash', 'callback_url']);
  assert.equal(submitted.body.action_hash, canonicalEnvelopeHash(envelope()));
  assert.equal(submitted.token, 'tok');
});

test('held envelope is frozen and releases byte-identical', async () => {
  const queue = createHeldQueue({ callbackUrl: 'http://127.0.0.1:8795/cb', submitChallengeFn: async () => ({ challenge_id: 'ch_1' }) });
  const { actionHash } = await queue.holdForApproval(envelope(), 'tok');
  const released = queue.releaseEnvelope(actionHash);
  assert.throws(() => { 'use strict'; released.body.task_id = 'tampered'; }, TypeError);
  assert.equal(canonicalEnvelopeHash(released), actionHash);
  assert.throws(() => queue.releaseEnvelope(actionHash), /not found/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-timeout=30000 sigil/relay/v1/transport-tincan/held-queue.test.mjs`
Expected: FAIL with `Cannot find module './held-queue.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// sigil/relay/v1/transport-tincan/held-queue.mjs
import crypto from 'node:crypto';
import { signedBytes } from '../validate-envelope.mjs';

export function canonicalEnvelopeHash(envelope) {
  return crypto.createHash('sha256').update(signedBytes(envelope)).digest('hex');
}

function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

export function createHeldQueue({ callbackUrl, submitChallengeFn }) {
  const held = new Map();
  return {
    async holdForApproval(envelope, token) {
      const frozen = deepFreeze(structuredClone(envelope));
      const actionHash = canonicalEnvelopeHash(frozen);
      held.set(actionHash, frozen);
      const challenge = await submitChallengeFn({ action_hash: actionHash, callback_url: callbackUrl }, token);
      return { actionHash, challengeId: challenge.challenge_id };
    },
    releaseEnvelope(actionHash) {
      const envelope = held.get(actionHash);
      if (!envelope) throw new Error(`Held envelope not found for ${actionHash}`);
      held.delete(actionHash);
      return envelope;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-timeout=30000 sigil/relay/v1/transport-tincan/held-queue.test.mjs`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/transport-tincan/held-queue.mjs sigil/relay/v1/transport-tincan/held-queue.test.mjs
git commit -m "feat(tincan): add immutable held queue bound to relay action hash

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Integration test against the real risk gate

**Files:**
- Create: `sigil/relay/v1/transport-tincan/tincan-integration.test.mjs`

**Interfaces:**
- Consumes: Tasks 3-6, plus `enforceCapabilityRiskGate` from `sigil/relay/v1/capability-risk-gate.mjs`.

This test proves the units compose and that the held-queue hash is the one the real gate consumes. It uses a fake repository for the gate (`lookupCapabilityRegistration`, `consumeApprovalDecision`) and the real gate code.

- [ ] **Step 1: Write the test**

```javascript
// sigil/relay/v1/transport-tincan/tincan-integration.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTailscaleWhoIs } from './whois-auth.mjs';
import { createWakeDispatcher } from './wake-dispatcher.mjs';
import { dispatchDeliveryWithRetry } from './dispatch-lifecycle.mjs';
import { createHeldQueue } from './held-queue.mjs';
import { enforceCapabilityRiskGate } from '../capability-risk-gate.mjs';

const tailscale = { whois: async () => ({ Node: { Key: 'nodekey:gpu', Name: 'gpu-1' } }) };
const allowlist = new Map([['nodekey:gpu', { permitted_endpoints: ['ep_codex'], allowed_host_roles: ['agent_runner'] }]]);

test('authorized node wakes a sleeping codex bridge and the delivery succeeds', async () => {
  await verifyTailscaleWhoIs({ remoteAddress: '100.64.0.2', targetEndpoint: 'ep_codex' }, allowlist, tailscale);
  const spawned = [];
  const dispatcher = createWakeDispatcher({ checkRunningFn: async () => false, spawnFn: async (command, args) => { spawned.push(args); return { pid: 7 }; } });
  const fails = [];
  const result = await dispatchDeliveryWithRetry({
    delivery: { conversation_id: 'room_1', invocation_id: 'inv_1' },
    wakeFn: async () => { await dispatcher.wakeAgent({ endpointId: 'ep_codex', bridgeType: 'codex', identityPath: 'codex.json', relayUrl: 'http://127.0.0.1:8791' }); return { status: 'DELIVERED' }; },
    failFn: async (...args) => fails.push(args),
  });
  assert.equal(result.status, 'DELIVERED');
  assert.ok(spawned[0].includes('codex'));
  assert.deepEqual(fails, []);
});

test('an unauthorized target never reaches the wake step', async () => {
  await assert.rejects(verifyTailscaleWhoIs({ remoteAddress: '100.64.0.2', targetEndpoint: 'ep_rogue' }, allowlist, tailscale), { code: 'NODE_NOT_AUTHORIZED_FOR_ENDPOINT' });
});

test('the held-queue hash is the exact hash the real risk gate consumes', async () => {
  const envelope = { protocol: 'sigil/1', message_id: 'msg_9', sender: { endpoint_id: 'ep_claude' }, message_type: 'room.message', capabilities: ['fs.write'], body: { text: 'x' }, signature: { value: 's' } };
  const queue = createHeldQueue({ callbackUrl: 'http://127.0.0.1:8795/cb', submitChallengeFn: async () => ({ challenge_id: 'ch_1' }) });
  const { actionHash } = await queue.holdForApproval(envelope, 'tok');
  const consumed = [];
  const repository = {
    lookupCapabilityRegistration: async () => ({ risk_tier: 'high' }),
    consumeApprovalDecision: async ({ endpointId, actionHash: hash }) => { consumed.push({ endpointId, hash }); return hash === actionHash ? { id: 'decision_1' } : null; },
  };
  await enforceCapabilityRiskGate(queue.releaseEnvelope(actionHash), repository, {});
  assert.deepEqual(consumed, [{ endpointId: 'ep_claude', hash: actionHash }]);
});
```

- [ ] **Step 2: Run the test**

Run: `node --test --test-timeout=30000 sigil/relay/v1/transport-tincan/tincan-integration.test.mjs`
Expected: PASS, 3 tests. If the third test fails with `APPROVAL_REQUIRED`, the held-queue hash does not match `capability-risk-gate.mjs:34`: fix `canonicalEnvelopeHash`, not the test.

- [ ] **Step 3: Run the whole new surface plus the touched MCP tests**

Run: `node --test --test-timeout=30000 sigil/relay/v1/transport-tincan/ sigil/connectors/v1/rooms-mcp-tools.test.mjs sigil/connectors/v1/mcp-stdio-server.test.mjs`
Expected: PASS, 0 fail

- [ ] **Step 4: Commit**

```bash
git add sigil/relay/v1/transport-tincan/tincan-integration.test.mjs
git commit -m "test(tincan): prove units compose and match the real risk gate hash

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Deferred, with reason

- `sigil_dispatch_task`: the relay refuses `task.request` in rooms. Needs a relay change that re-adds task types with an assignee field.
- `sigil_my_mentions`: no relay route lists mentions. Needs a relay route first.
- `host_unreachable` invocation failure: `invocations/fail` is caller-owned, and the caller's host is the unreachable one. Needs a relay-side or system-identity failure path.
- Remote xAI Grok CLI bridge: `--room-bridge` has no `grok` value on `main` (rooms phase 5). The multi-host demonstration uses the `codex` bridge until phase 5 lands.
- Real Tailscale `tsnet` binding, HTTP `POST /v1/dispatch` router, and the approval callback receiver (with its bearer secret): they wrap the units above and need a live Tailnet to verify.

## Self-review

1. **Spec coverage:** MCP room tools (Tasks 1-2), node allowlist plus dispatch pre-check (Task 3), wake with real CLI flags (Task 4), 45s retry budget with mapped reasons (Task 5), immutable hash-bound held queue and challenge body (Task 6), composition against the real gate (Task 7). Spec items not covered are listed under Deferred with the reason.
2. **Placeholder scan:** none. Every step carries complete code and an exact command.
3. **Type consistency:** `failFn(roomId, reason, invocationId)` matches `RelayClient.failRoomInvocation(roomId, reason, invocationId)`. `createRoomsRuntime` methods match the `runtime[tool[2]]` names `listRooms`, `readRoom`, `postMessage` used in Task 2. `canonicalEnvelopeHash` is the one name used in Tasks 6 and 7.
