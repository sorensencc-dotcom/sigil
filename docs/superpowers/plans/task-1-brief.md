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

