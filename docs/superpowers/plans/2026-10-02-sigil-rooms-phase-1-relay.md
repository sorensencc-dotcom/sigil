# Sigil rooms phase 1 (relay rooms) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The relay hosts rooms. A room member posts a signed `room.message`. The relay checks membership, assigns a gapless `room_seq`, writes one delivery per other member, notifies their streams, and serves the room history over HTTP.

**Architecture:** A room is an existing Sigil conversation with `kind = 'room'`. Its roster is `conversation_members`. Room traffic uses the broadcast envelope form (`broadcast_scope: { conversation_id }`, no `recipient`). Most of the new logic lives in one policy module, `room-policy.mjs`, called from the local branch of `acceptWithRepository`. Both repositories, memory and Postgres, gain the same room methods, keeping the design's dual-repository equivalence. Room HTTP routes live in their own module, `room-routes.mjs`, which `http-server.mjs` delegates to.

**Tech stack:** Node 22 ESM (`.mjs`), `node:test`, `pg`, PostgreSQL 15+. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-02-sigil-rooms-design.md` (sections "Relay (room authority)", "Data model", and "Delivery phases" item 1).

## Global constraints

- Protocol stays `sigil/1`. Envelope field names come from `sigil/contracts/v1/envelope.example.json`. No new top-level envelope fields.
- `room_seq` is assigned by the relay, inside the accept transaction, gapless per room in Postgres.
- The relay never trusts the sender identity a client claims. Membership checks use `envelope.sender.endpoint_id`, which `validateEnvelope` proves by signature.
- Non-room conversations must behave exactly as before. Every existing test must stay green.
- In v1, a human may only add endpoints they own (`registry.get(id).owner_id === principal.human_id`).
- No new npm dependencies (`sigil-dep-audit.mjs` runs in `npm test`).
- Run tests with a timeout: `timeout 120 node --test <file>`. Never start a second full-suite run while one is running (overlapping runs deadlocked the shared Postgres on 2026-09-02).
- Live Postgres tests need `SIGIL_TEST_DATABASE_URL=postgres://sigil:sigil_password@localhost:55432/sigil_test` and run through `npm run test:live`.
- Commit messages: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Use the `test:` prefix when a commit mainly adds tests.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `sigil/migrations/027_rooms.sql` | Create | Tables `workspaces` and `rooms`, plus columns `conversation_members.response_mode` and `envelopes.room_seq` |
| `sigil/migrations/027_rooms.test.mjs` | Create | Static checks on the migration SQL |
| `sigil/contracts/v1/room-message-schema.mjs` (+ `.test.mjs`) | Create | Body validation for `room.message` |
| `sigil/relay/v1/validate-envelope.mjs` | Modify | Call the `room.message` body validator |
| `sigil/cli/memory-repository.mjs` | Modify | Room methods and fan-out persistence (memory) |
| `sigil/cli/memory-repository.rooms.test.mjs` | Create | Unit tests for the memory room methods |
| `sigil/relay/v1/postgres-repository.mjs` | Modify | Room methods and fan-out persistence (Postgres) |
| `sigil/relay/v1/rooms.pg.test.mjs` | Create | Live Postgres tests for the room methods |
| `sigil/relay/v1/room-policy.mjs` (+ `.test.mjs`) | Create | Authorizes room envelopes and computes the fan-out list |
| `sigil/relay/v1/accept-envelope.mjs` | Modify | Calls the room policy, assigns `room_seq`, passes the fan-out to persistence |
| `sigil/relay/v1/accept-envelope.rooms.test.mjs` | Create | End-to-end accept tests against the memory repository |
| `sigil/relay/v1/http-server.mjs` | Modify | Notifies the stream for each fan-out recipient; delegates `/v1/rooms*` routes |
| `sigil/relay/v1/room-routes.mjs` (+ `.test.mjs`) | Create | HTTP handlers for room create, list, members, and history |
| `sigil/contracts/v1/relay-api.json` | Modify | Contract entries for the new routes |

## Shared repository interface

Tasks 3 and 4 implement this interface. Tasks 5 to 7 call it. Every method that takes `client` treats it as the open transaction's client in Postgres; the memory repository ignores it.

```text
createRoom({ conversationId, workspaceId, name, description = null, createdByHumanId, ownerEndpointId, now = new Date() })
  -> { conversation_id, workspace_id, name, description, created_at }
  throws { code: 'ROOM_NAME_TAKEN' } when (workspace_id, name) already exists
lookupRoom(conversationId, client) -> room | null
listRoomsForEndpoint(endpointId) -> room[]   (rooms where the endpoint is an active member)
addRoomMember({ conversationId, endpointId, role, responseMode = null, addedByHumanId, now = new Date() })
  -> { endpoint_id, role, response_mode, added_at }
  throws { code: 'ROOM_MEMBER_EXISTS' } when the endpoint is already an active member
removeRoomMember({ conversationId, endpointId, now = new Date() }) -> boolean (true if an active member was removed)
lookupRoomMember(conversationId, endpointId, client) -> { endpoint_id, role, response_mode, added_at } | null (active only)
listRoomMembers(conversationId, client) -> member[] (active only, ordered by added_at)
assignRoomSequence(client, conversationId) -> bigint
listRoomMessages(conversationId, afterSeq = 0n, limit = 100) -> [{ room_seq: string, message_id, envelope }] ordered by room_seq
persistAcceptedEnvelope(row, client)
  row may carry: roomSeq (bigint) and roomFanout (string[] of recipient endpoint ids)
  -> when roomFanout is set, the result also carries fanout: [{ endpoint_id, delivery_id }]
```

Roles are the strings `owner`, `room_manager`, and `member`. Response modes are `joins`, `mentions_only`, or `null` (null for human members).

---

### Task 1: Migration 027_rooms

**Files:**
- Create: `sigil/migrations/027_rooms.sql`
- Test: `sigil/migrations/027_rooms.test.mjs`

**Interfaces:**
- Produces: the tables `workspaces` and `rooms`, the column `conversation_members.response_mode`, the column `envelopes.room_seq`, and the unique index `envelopes_room_seq_idx`.

- [ ] **Step 1: Write the failing test**

```js
// sigil/migrations/027_rooms.test.mjs
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const sql = fs.readFileSync(new URL('./027_rooms.sql', import.meta.url), 'utf8');

test('027 creates workspaces and rooms keyed to conversations', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS workspaces/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS rooms/);
  assert.match(sql, /conversation_id\s+TEXT PRIMARY KEY REFERENCES conversations\(conversation_id\)/);
  assert.match(sql, /UNIQUE \(workspace_id, name\)/);
  assert.match(sql, /next_room_seq\s+BIGINT NOT NULL DEFAULT 1/);
});

test('027 adds response_mode with a closed value set', () => {
  assert.match(sql, /ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS response_mode TEXT/);
  assert.match(sql, /'joins'/);
  assert.match(sql, /'mentions_only'/);
});

test('027 adds a per-room unique room_seq on envelopes', () => {
  assert.match(sql, /ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS room_seq BIGINT/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS envelopes_room_seq_idx\s+ON envelopes \(conversation_id, room_seq\)\s+WHERE room_seq IS NOT NULL/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 120 node --test sigil/migrations/027_rooms.test.mjs`
Expected: FAIL with `ENOENT` (the `.sql` file does not exist).

- [ ] **Step 3: Write the migration**

```sql
-- sigil/migrations/027_rooms.sql
-- Rooms: multi-party conversations with relay-assigned room_seq ordering.
-- A room is a conversations row (kind = 'room'); its roster is conversation_members.

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_by   TEXT NOT NULL REFERENCES humans(human_id),
  created_at   TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(conversation_id),
  workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id),
  name            TEXT NOT NULL,
  description     TEXT,
  next_room_seq   BIGINT NOT NULL DEFAULT 1,
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL,
  UNIQUE (workspace_id, name)
);

ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS response_mode TEXT
  CHECK (response_mode IS NULL OR response_mode IN ('joins', 'mentions_only'));

ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS room_seq BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS envelopes_room_seq_idx
  ON envelopes (conversation_id, room_seq)
  WHERE room_seq IS NOT NULL;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `timeout 120 node --test sigil/migrations/027_rooms.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Apply the migration to the test database**

Run: `SIGIL_DATABASE_URL=postgres://sigil:sigil_password@localhost:55432/sigil_test npm run db:migrate`
Expected: output lists `027_rooms.sql` as applied, with no error. If Postgres is not running, record that in the task report and continue; Task 4 re-checks it.

- [ ] **Step 6: Commit**

```bash
git add sigil/migrations/027_rooms.sql sigil/migrations/027_rooms.test.mjs
git commit -m "feat(sigil): add rooms migration 027"
```

---

### Task 2: room.message body schema

**Files:**
- Create: `sigil/contracts/v1/room-message-schema.mjs`
- Create: `sigil/contracts/v1/room-message-schema.test.mjs`
- Modify: `sigil/relay/v1/validate-envelope.mjs` (imports, and the message-type dispatch near line 116)

**Interfaces:**
- Produces: `validateRoomMessageBody(body)`, which throws `{ code: 'INVALID_ENVELOPE', details: { field, reason } }` on a bad body. `validateEnvelope` calls it when `message_type === 'room.message'`.

- [ ] **Step 1: Write the failing test**

```js
// sigil/contracts/v1/room-message-schema.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRoomMessageBody, ROOM_MESSAGE_TEXT_MAX } from './room-message-schema.mjs';

test('accepts a minimal room message', () => {
  assert.doesNotThrow(() => validateRoomMessageBody({ text: 'hello room' }));
});

test('accepts a threaded reply with mentions', () => {
  assert.doesNotThrow(() => validateRoomMessageBody({ text: 'on it', thread_root_id: 'msg_root', mentions: ['ep_claude', 'ep_codex'] }));
});

for (const [name, body, field] of [
  ['non-object body', 'text', 'body'],
  ['array body', [], 'body'],
  ['missing text', {}, 'text'],
  ['empty text', { text: '' }, 'text'],
  ['oversized text', { text: 'x'.repeat(ROOM_MESSAGE_TEXT_MAX + 1) }, 'text'],
  ['empty thread root', { text: 'a', thread_root_id: '' }, 'thread_root_id'],
  ['mentions not an array', { text: 'a', mentions: 'ep_claude' }, 'mentions'],
  ['empty mention', { text: 'a', mentions: [''] }, 'mentions'],
  ['too many mentions', { text: 'a', mentions: Array.from({ length: 51 }, (_, i) => `ep_${i}`) }, 'mentions'],
  ['unknown field', { text: 'a', priority: 'high' }, 'priority'],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => validateRoomMessageBody(body), (error) => error.code === 'INVALID_ENVELOPE' && error.details.field === field);
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 120 node --test sigil/contracts/v1/room-message-schema.test.mjs`
Expected: FAIL with `Cannot find module` for `room-message-schema.mjs`.

- [ ] **Step 3: Write the schema module**

```js
// sigil/contracts/v1/room-message-schema.mjs
// Pure body-shape validation for message_type: 'room.message' (rooms design, phase 1).
export const ROOM_MESSAGE_TEXT_MAX = 20000;
export const ROOM_MESSAGE_MENTIONS_MAX = 50;
const ALLOWED_FIELDS = new Set(['text', 'thread_root_id', 'mentions']);

function fail(field, reason) {
  throw Object.assign(new Error(`Invalid room.message body: ${reason}`), {
    code: 'INVALID_ENVELOPE',
    details: { field, reason },
  });
}

export function validateRoomMessageBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('body', 'must be an object');
  for (const field of Object.keys(body)) if (!ALLOWED_FIELDS.has(field)) fail(field, 'unknown field');
  if (typeof body.text !== 'string' || !body.text) fail('text', 'required non-empty string');
  if (body.text.length > ROOM_MESSAGE_TEXT_MAX) fail('text', `must be at most ${ROOM_MESSAGE_TEXT_MAX} characters`);
  if ('thread_root_id' in body && (typeof body.thread_root_id !== 'string' || !body.thread_root_id)) fail('thread_root_id', 'must be a non-empty string');
  if ('mentions' in body) {
    if (!Array.isArray(body.mentions)) fail('mentions', 'must be an array');
    if (body.mentions.length > ROOM_MESSAGE_MENTIONS_MAX) fail('mentions', `must have at most ${ROOM_MESSAGE_MENTIONS_MAX} entries`);
    if (body.mentions.some((id) => typeof id !== 'string' || !id)) fail('mentions', 'entries must be non-empty strings');
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `timeout 120 node --test sigil/contracts/v1/room-message-schema.test.mjs`
Expected: PASS (12 tests).

- [ ] **Step 5: Wire the schema into validateEnvelope**

In `sigil/relay/v1/validate-envelope.mjs`, add the import next to the existing `validateSessionResendRequestBody` import:

```js
import { validateRoomMessageBody } from '../../contracts/v1/room-message-schema.mjs';
```

Then add one line after `if (envelope.message_type === 'session.resend_request') validateSessionResendRequestBody(envelope.body);`:

```js
  if (envelope.message_type === 'room.message') validateRoomMessageBody(envelope.body);
```

Add this test to the end of `sigil/relay/v1/validate-envelope.test.mjs`. It uses that file's existing `base`, `privateKey`, and `options` fixtures:

```js
test('rejects a room.message with an invalid body', () => {
  const candidate = { ...base, message_type: 'room.message', body: { text: '' }, recipient: undefined, signature: { ...base.signature }, broadcast_scope: { conversation_id: base.conversation_id } };
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  assert.throws(() => validateEnvelope(candidate, { ...options, broadcastAuthorizer: () => true }), (error) => error.code === 'INVALID_ENVELOPE' && error.details.field === 'text');
});

test('accepts a well-formed room.message broadcast', () => {
  const candidate = { ...base, message_type: 'room.message', body: { text: 'hello room' }, recipient: undefined, signature: { ...base.signature }, broadcast_scope: { conversation_id: base.conversation_id } };
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  assert.equal(validateEnvelope(candidate, { ...options, broadcastAuthorizer: () => true }).accepted, true);
});
```

- [ ] **Step 6: Run both test files**

Run: `timeout 120 node --test sigil/relay/v1/validate-envelope.test.mjs sigil/contracts/v1/room-message-schema.test.mjs`
Expected: PASS, with no previously passing test now failing.

- [ ] **Step 7: Commit**

```bash
git add sigil/contracts/v1/room-message-schema.mjs sigil/contracts/v1/room-message-schema.test.mjs sigil/relay/v1/validate-envelope.mjs sigil/relay/v1/validate-envelope.test.mjs
git commit -m "feat(sigil): validate room.message bodies"
```

---

### Task 3: Memory repository room methods

**Files:**
- Modify: `sigil/cli/memory-repository.mjs` (state inside `createMemoryRepository`, the `persistAcceptedEnvelope` method near line 214, and new methods)
- Test: `sigil/cli/memory-repository.rooms.test.mjs`

**Interfaces:**
- Produces: every method in "Shared repository interface", memory-backed. The memory `assignRoomSequence` is not rolled back by `withTransaction`. That is acceptable for a single-process test repository; document it in a comment.

- [ ] **Step 1: Write the failing test**

```js
// sigil/cli/memory-repository.rooms.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

const NOW = new Date('2026-10-02T12:00:00.000Z');

function makeRoom(repository, overrides = {}) {
  return repository.createRoom({
    conversationId: 'room_1', workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris',
    ownerEndpointId: 'ep_chris_web', now: NOW, ...overrides,
  });
}

test('createRoom registers the room and makes the creator its owner', async () => {
  const repository = createMemoryRepository();
  const room = await makeRoom(repository);
  assert.equal(room.conversation_id, 'room_1');
  assert.deepEqual(await repository.lookupRoom('room_1'), room);
  const owner = await repository.lookupRoomMember('room_1', 'ep_chris_web');
  assert.equal(owner.role, 'owner');
  assert.equal(owner.response_mode, null);
});

test('createRoom rejects a duplicate name in the same workspace', async () => {
  const repository = createMemoryRepository();
  await makeRoom(repository);
  await assert.rejects(makeRoom(repository, { conversationId: 'room_2' }), { code: 'ROOM_NAME_TAKEN' });
});

test('addRoomMember, listRoomMembers, and removeRoomMember manage the roster', async () => {
  const repository = createMemoryRepository();
  await makeRoom(repository);
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_chris', now: NOW });
  await assert.rejects(repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', role: 'member', addedByHumanId: 'usr_chris', now: NOW }), { code: 'ROOM_MEMBER_EXISTS' });
  assert.deepEqual((await repository.listRoomMembers('room_1')).map((m) => m.endpoint_id), ['ep_chris_web', 'ep_claude']);
  assert.equal(await repository.removeRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', now: NOW }), true);
  assert.equal(await repository.lookupRoomMember('room_1', 'ep_claude'), null);
  assert.equal(await repository.removeRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', now: NOW }), false);
  assert.deepEqual((await repository.listRoomsForEndpoint('ep_chris_web')).map((r) => r.conversation_id), ['room_1']);
  assert.deepEqual(await repository.listRoomsForEndpoint('ep_claude'), []);
});

test('assignRoomSequence counts up from 1 per room', async () => {
  const repository = createMemoryRepository();
  await makeRoom(repository);
  assert.equal(await repository.assignRoomSequence(null, 'room_1'), 1n);
  assert.equal(await repository.assignRoomSequence(null, 'room_1'), 2n);
});

test('persistAcceptedEnvelope fans a room message out and lists it by room_seq', async () => {
  const repository = createMemoryRepository();
  await makeRoom(repository);
  const envelope = {
    message_id: 'msg_1', conversation_id: 'room_1', message_type: 'room.message',
    sender: { endpoint_id: 'ep_chris_web', owner_id: 'usr_chris' }, broadcast_scope: { conversation_id: 'room_1' },
    body: { text: 'hi' }, idempotency_key: 'idem_1', created_at: NOW.toISOString(), expires_at: '2026-10-02T13:00:00.000Z',
  };
  const persisted = await repository.persistAcceptedEnvelope({ envelope, message_id: 'msg_1', canonical_hash: 'h', roomSeq: 1n, roomFanout: ['ep_claude', 'ep_codex'] });
  assert.deepEqual(persisted.fanout.map((f) => f.endpoint_id), ['ep_claude', 'ep_codex']);
  assert.equal((await repository.listInbox('ep_claude')).length, 1);
  assert.equal((await repository.listInbox('ep_chris_web')).length, 0);
  const messages = await repository.listRoomMessages('room_1', 0n, 100);
  assert.deepEqual(messages.map((m) => [m.room_seq, m.message_id]), [['1', 'msg_1']]);
  assert.deepEqual(await repository.listRoomMessages('room_1', 1n, 100), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `timeout 120 node --test sigil/cli/memory-repository.rooms.test.mjs`
Expected: FAIL with `repository.createRoom is not a function`.

- [ ] **Step 3: Implement the memory methods**

In `createMemoryRepository`, next to the other state maps, add:

```js
  const workspaces = new Map(); // workspace_id -> row (migration 027)
  const rooms = new Map(); // conversation_id -> room row (migration 027)
  const roomMembers = new Map(); // conversation_id -> Map(endpoint_id -> member row incl. removed_at)
```

Add these methods to the returned object:

```js
    async createRoom({ conversationId, workspaceId, name, description = null, createdByHumanId, ownerEndpointId, now = new Date() }) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      if ([...rooms.values()].some((room) => room.workspace_id === workspaceId && room.name === name)) {
        throw Object.assign(new Error('A room with this name already exists in the workspace'), { code: 'ROOM_NAME_TAKEN' });
      }
      if (!workspaces.has(workspaceId)) workspaces.set(workspaceId, { workspace_id: workspaceId, name: workspaceId, created_by: createdByHumanId, created_at: timestamp });
      const room = { conversation_id: conversationId, workspace_id: workspaceId, name, description, created_at: timestamp };
      rooms.set(conversationId, { ...room, next_room_seq: 1n, archived_at: null });
      roomMembers.set(conversationId, new Map([[ownerEndpointId, { endpoint_id: ownerEndpointId, role: 'owner', response_mode: null, added_by: createdByHumanId, added_at: timestamp, removed_at: null }]]));
      return room;
    },
    async lookupRoom(conversationId) {
      const room = rooms.get(conversationId);
      if (!room) return null;
      const { next_room_seq: _seq, archived_at: _archived, ...visible } = room;
      return visible;
    },
    async listRoomsForEndpoint(endpointId) {
      return [...rooms.keys()]
        .filter((conversationId) => roomMembers.get(conversationId)?.get(endpointId)?.removed_at === null)
        .map((conversationId) => { const { next_room_seq: _seq, archived_at: _archived, ...visible } = rooms.get(conversationId); return visible; });
    },
    async addRoomMember({ conversationId, endpointId, role, responseMode = null, addedByHumanId, now = new Date() }) {
      const members = roomMembers.get(conversationId);
      if (!members) throw Object.assign(new Error('Room not found'), { code: 'ROOM_NOT_FOUND' });
      if (members.get(endpointId)?.removed_at === null) throw Object.assign(new Error('Endpoint is already a room member'), { code: 'ROOM_MEMBER_EXISTS' });
      const member = { endpoint_id: endpointId, role, response_mode: responseMode, added_by: addedByHumanId, added_at: (now instanceof Date ? now : new Date(now)).toISOString(), removed_at: null };
      members.set(endpointId, member);
      return { endpoint_id: member.endpoint_id, role: member.role, response_mode: member.response_mode, added_at: member.added_at };
    },
    async removeRoomMember({ conversationId, endpointId, now = new Date() }) {
      const member = roomMembers.get(conversationId)?.get(endpointId);
      if (!member || member.removed_at !== null) return false;
      member.removed_at = (now instanceof Date ? now : new Date(now)).toISOString();
      return true;
    },
    async lookupRoomMember(conversationId, endpointId) {
      const member = roomMembers.get(conversationId)?.get(endpointId);
      if (!member || member.removed_at !== null) return null;
      return { endpoint_id: member.endpoint_id, role: member.role, response_mode: member.response_mode, added_at: member.added_at };
    },
    async listRoomMembers(conversationId) {
      return [...(roomMembers.get(conversationId)?.values() ?? [])]
        .filter((member) => member.removed_at === null)
        .sort((a, b) => a.added_at.localeCompare(b.added_at))
        .map((member) => ({ endpoint_id: member.endpoint_id, role: member.role, response_mode: member.response_mode, added_at: member.added_at }));
    },
    // Not undone by withTransaction: a rejected accept can leave a gap in the
    // memory repo's room_seq. Postgres assigns inside the accept transaction,
    // so its sequence stays gapless.
    async assignRoomSequence(_client, conversationId) {
      const room = rooms.get(conversationId);
      const assigned = room.next_room_seq;
      room.next_room_seq = assigned + 1n;
      return assigned;
    },
    async listRoomMessages(conversationId, afterSeq = 0n, limit = 100) {
      return [...envelopes.values()]
        .filter((row) => row.envelope.conversation_id === conversationId && row.roomSeq != null && row.roomSeq > BigInt(afterSeq))
        .sort((a, b) => (a.roomSeq < b.roomSeq ? -1 : a.roomSeq > b.roomSeq ? 1 : 0))
        .slice(0, limit)
        .map((row) => ({ room_seq: String(row.roomSeq), message_id: row.message_id, envelope: row.envelope }));
    },
```

Replace the existing `persistAcceptedEnvelope` with this version. The direct-recipient branch is unchanged; the room fan-out branch and the `roomSeq` field are new.

```js
    async persistAcceptedEnvelope(row) {
      const federationHop = row.federation_hop === true;
      envelopes.set(row.message_id, { ...row, streamSeq: row.streamSeq ?? null, roomSeq: row.roomSeq ?? null, federation_hop: federationHop });
      idempotency.set(`${row.envelope.sender.endpoint_id}:${row.envelope.idempotency_key}`, { message_id: row.message_id, canonical_hash: row.canonical_hash });
      if (row.envelope.recipient?.endpoint_id) {
        const deliveryId = `del_${row.message_id}`;
        deliveries.set(deliveryId, {
          delivery_id: deliveryId,
          message_id: row.message_id,
          recipient_endpoint_id: row.envelope.recipient.endpoint_id,
          state: 'delivered',
          queued_at: new Date().toISOString(),
          attempts: 0,
          federation_hop: federationHop
        });
      }
      if (Array.isArray(row.roomFanout)) {
        const fanout = row.roomFanout.map((endpointId) => {
          const deliveryId = `del_${row.message_id}_${endpointId}`;
          deliveries.set(deliveryId, { delivery_id: deliveryId, message_id: row.message_id, recipient_endpoint_id: endpointId, state: 'delivered', queued_at: new Date().toISOString(), attempts: 0, federation_hop: false });
          return { endpoint_id: endpointId, delivery_id: deliveryId };
        });
        return { message_id: row.message_id, duplicate: false, fanout };
      }
      return { message_id: row.message_id, duplicate: false };
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `timeout 120 node --test sigil/cli/memory-repository.rooms.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the existing memory-repository consumers**

Run: `timeout 120 node --test sigil/relay/v1/accept-envelope.stream-sequence.test.mjs sigil/relay/v1/accept-envelope.test.mjs`
Expected: PASS, with no regressions.

- [ ] **Step 6: Commit**

```bash
git add sigil/cli/memory-repository.mjs sigil/cli/memory-repository.rooms.test.mjs
git commit -m "feat(sigil): add room methods to the memory repository"
```

---

### Task 4: Postgres repository room methods

**Files:**
- Modify: `sigil/relay/v1/postgres-repository.mjs` (new methods inside `class PostgresRepository`, and `#insertAcceptedEnvelope` near line 752)
- Test: `sigil/relay/v1/rooms.pg.test.mjs`

**Interfaces:**
- Consumes: migration 027 (Task 1).
- Produces: the same interface as Task 3, Postgres-backed. `assignRoomSequence` takes the row lock on `rooms`, so concurrent accepts into one room serialize, and a rolled-back accept also rolls back its increment.

- [ ] **Step 1: Write the failing live test**

```js
// sigil/relay/v1/rooms.pg.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function seed(pool, suffix) {
  const ids = { human: `usr_rooms_${suffix}`, web: `ep_web_${suffix}`, claude: `ep_claude_${suffix}`, codex: `ep_codex_${suffix}` };
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [ids.human]);
  for (const [endpointId, runtime] of [[ids.web, 'web'], [ids.claude, 'claude'], [ids.codex, 'codex']]) {
    await pool.query(
      `INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
       VALUES ($1, $2, $3, $4, $3, 'active', NOW())`,
      [endpointId, ids.human, runtime, `install_${endpointId}`],
    );
  }
  return ids;
}

test('postgres room lifecycle, ordering, and fan-out', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = await seed(pool, suffix);
  const repository = new PostgresRepository({ pool });
  const conversationId = `room_${suffix}`;
  const now = new Date();

  const room = await repository.createRoom({ conversationId, workspaceId: `ws_${ids.human}`, name: `build_${suffix}`, createdByHumanId: ids.human, ownerEndpointId: ids.web, now });
  assert.equal(room.conversation_id, conversationId);
  await assert.rejects(repository.createRoom({ conversationId: `room2_${suffix}`, workspaceId: `ws_${ids.human}`, name: `build_${suffix}`, createdByHumanId: ids.human, ownerEndpointId: ids.web, now }), { code: 'ROOM_NAME_TAKEN' });

  await repository.addRoomMember({ conversationId, endpointId: ids.claude, role: 'member', responseMode: 'joins', addedByHumanId: ids.human, now });
  await repository.addRoomMember({ conversationId, endpointId: ids.codex, role: 'member', responseMode: 'mentions_only', addedByHumanId: ids.human, now });
  await assert.rejects(repository.addRoomMember({ conversationId, endpointId: ids.codex, role: 'member', addedByHumanId: ids.human, now }), { code: 'ROOM_MEMBER_EXISTS' });
  assert.equal((await repository.lookupRoomMember(conversationId, ids.web)).role, 'owner');
  assert.deepEqual((await repository.listRoomMembers(conversationId)).map((m) => m.endpoint_id).sort(), [ids.claude, ids.codex, ids.web].sort());
  assert.deepEqual((await repository.listRoomsForEndpoint(ids.claude)).map((r) => r.conversation_id), [conversationId]);

  const persisted = await repository.withTransaction(async (client) => {
    const roomSeq = await repository.assignRoomSequence(client, conversationId);
    assert.equal(roomSeq, 1n);
    const envelope = {
      protocol: 'sigil/1', message_id: `msg_${suffix}`, conversation_id: conversationId, message_type: 'room.message',
      sender: { endpoint_id: ids.web, owner_id: ids.human }, broadcast_scope: { conversation_id: conversationId },
      body: { text: 'hi' }, context_refs: [], capabilities: [], correlation_id: null, idempotency_key: `idem_${suffix}`,
      created_at: now.toISOString(), expires_at: new Date(now.getTime() + 600_000).toISOString(),
      signature: { algorithm: 'Ed25519', key_id: 'key_unused', value: 'sig' },
    };
    return repository.persistAcceptedEnvelope({ envelope, canonical_hash: 'h', action_hash: 'h', roomSeq, roomFanout: [ids.claude, ids.codex] }, client);
  });
  assert.deepEqual(persisted.fanout.map((f) => f.endpoint_id).sort(), [ids.claude, ids.codex].sort());
  const deliveries = await pool.query('SELECT recipient_endpoint_id FROM deliveries WHERE message_id = $1 ORDER BY recipient_endpoint_id', [`msg_${suffix}`]);
  assert.deepEqual(deliveries.rows.map((r) => r.recipient_endpoint_id), [ids.claude, ids.codex].sort());
  const members = await pool.query('SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1', [conversationId]);
  assert.equal(members.rows[0].n, 3, 'persisting a room message must not add members');

  const messages = await repository.listRoomMessages(conversationId, 0n, 100);
  assert.deepEqual(messages.map((m) => [m.room_seq, m.message_id]), [['1', `msg_${suffix}`]]);
  assert.equal(messages[0].envelope.body.text, 'hi');

  await assert.rejects(repository.withTransaction(async (client) => {
    await repository.assignRoomSequence(client, conversationId);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(await repository.withTransaction((client) => repository.assignRoomSequence(client, conversationId)), 2n, 'a rolled-back assignment must not leave a gap');

  assert.equal(await repository.removeRoomMember({ conversationId, endpointId: ids.codex, now }), true);
  assert.equal(await repository.lookupRoomMember(conversationId, ids.codex), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `SIGIL_TEST_DATABASE_URL=postgres://sigil:sigil_password@localhost:55432/sigil_test timeout 120 node --test sigil/relay/v1/rooms.pg.test.mjs`
Expected: FAIL with `repository.createRoom is not a function`. If Postgres is not reachable, start it with `docker start sigil_postgres` and re-run. Do not continue past this step with a skipped test.

- [ ] **Step 3: Implement the Postgres methods**

Add these methods to `class PostgresRepository`, near `isConversationMember`:

```js
  async createRoom({ conversationId, workspaceId, name, description = null, createdByHumanId, ownerEndpointId, now = new Date() }) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    try {
      return await this.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO workspaces (workspace_id, name, created_by, created_at) VALUES ($1, $1, $2, $3)
           ON CONFLICT (workspace_id) DO NOTHING`,
          [workspaceId, createdByHumanId, timestamp],
        );
        await client.query(
          `INSERT INTO conversations (conversation_id, kind, created_by, created_at) VALUES ($1, 'room', $2, $3)`,
          [conversationId, createdByHumanId, timestamp],
        );
        const result = await client.query(
          `INSERT INTO rooms (conversation_id, workspace_id, name, description, created_at) VALUES ($1, $2, $3, $4, $5)
           RETURNING conversation_id, workspace_id, name, description, created_at`,
          [conversationId, workspaceId, name, description, timestamp],
        );
        await client.query(
          `INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at, response_mode)
           VALUES ($1, $2, 'owner', $3, $4, NULL)`,
          [conversationId, ownerEndpointId, createdByHumanId, timestamp],
        );
        return roomRow(result.rows[0]);
      });
    } catch (error) {
      if (error.code === '23505' && error.constraint === 'rooms_workspace_id_name_key') {
        throw Object.assign(new Error('A room with this name already exists in the workspace'), { code: 'ROOM_NAME_TAKEN' });
      }
      throw error;
    }
  }
  async lookupRoom(conversationId, client = this.pool) {
    const result = await client.query(
      'SELECT conversation_id, workspace_id, name, description, created_at FROM rooms WHERE conversation_id = $1',
      [conversationId],
    );
    return result.rows[0] ? roomRow(result.rows[0]) : null;
  }
  async listRoomsForEndpoint(endpointId, client = this.pool) {
    const result = await client.query(
      `SELECT r.conversation_id, r.workspace_id, r.name, r.description, r.created_at
         FROM rooms r JOIN conversation_members m ON m.conversation_id = r.conversation_id
        WHERE m.endpoint_id = $1 AND m.removed_at IS NULL
        ORDER BY r.created_at, r.conversation_id`,
      [endpointId],
    );
    return result.rows.map(roomRow);
  }
  async addRoomMember({ conversationId, endpointId, role, responseMode = null, addedByHumanId, now = new Date() }, client = this.pool) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const result = await client.query(
      `INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at, response_mode)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (conversation_id, endpoint_id) DO UPDATE
         SET role = EXCLUDED.role, added_by = EXCLUDED.added_by, added_at = EXCLUDED.added_at,
             response_mode = EXCLUDED.response_mode, removed_at = NULL
         WHERE conversation_members.removed_at IS NOT NULL
       RETURNING endpoint_id, role, response_mode, added_at`,
      [conversationId, endpointId, role, addedByHumanId, timestamp, responseMode],
    );
    if (!result.rows[0]) throw Object.assign(new Error('Endpoint is already a room member'), { code: 'ROOM_MEMBER_EXISTS' });
    return memberRow(result.rows[0]);
  }
  async removeRoomMember({ conversationId, endpointId, now = new Date() }, client = this.pool) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const result = await client.query(
      `UPDATE conversation_members SET removed_at = $3
        WHERE conversation_id = $1 AND endpoint_id = $2 AND removed_at IS NULL`,
      [conversationId, endpointId, timestamp],
    );
    return result.rowCount > 0;
  }
  async lookupRoomMember(conversationId, endpointId, client = this.pool) {
    const result = await client.query(
      `SELECT endpoint_id, role, response_mode, added_at FROM conversation_members
        WHERE conversation_id = $1 AND endpoint_id = $2 AND removed_at IS NULL`,
      [conversationId, endpointId],
    );
    return result.rows[0] ? memberRow(result.rows[0]) : null;
  }
  async listRoomMembers(conversationId, client = this.pool) {
    const result = await client.query(
      `SELECT endpoint_id, role, response_mode, added_at FROM conversation_members
        WHERE conversation_id = $1 AND removed_at IS NULL ORDER BY added_at, endpoint_id`,
      [conversationId],
    );
    return result.rows.map(memberRow);
  }
  async assignRoomSequence(client, conversationId) {
    const result = await client.query(
      `UPDATE rooms SET next_room_seq = next_room_seq + 1 WHERE conversation_id = $1
       RETURNING next_room_seq - 1 AS assigned_seq`,
      [conversationId],
    );
    return BigInt(result.rows[0].assigned_seq);
  }
  async listRoomMessages(conversationId, afterSeq = 0n, limit = 100, client = this.pool) {
    const result = await client.query(
      `SELECT room_seq, message_id, protocol, message_type, body, context_refs, capabilities, correlation_id,
              sender_endpoint_id, sender_owner_id, broadcast_scope, conversation_id, idempotency_key,
              signature_algorithm, signature_key_id, signature_value, expires_at, created_at
         FROM envelopes
        WHERE conversation_id = $1 AND room_seq > $2
        ORDER BY room_seq
        LIMIT $3`,
      [conversationId, String(afterSeq), limit],
    );
    const iso = (value) => (value instanceof Date ? value.toISOString() : value);
    return result.rows.map((row) => ({
      room_seq: String(row.room_seq),
      message_id: row.message_id,
      envelope: {
        protocol: row.protocol,
        message_id: row.message_id,
        conversation_id: row.conversation_id,
        message_type: row.message_type,
        sender: { endpoint_id: row.sender_endpoint_id, owner_id: row.sender_owner_id },
        broadcast_scope: typeof row.broadcast_scope === 'string' ? JSON.parse(row.broadcast_scope) : row.broadcast_scope,
        body: typeof row.body === 'string' ? JSON.parse(row.body) : row.body,
        context_refs: row.context_refs ?? [],
        capabilities: row.capabilities ?? [],
        correlation_id: row.correlation_id,
        idempotency_key: row.idempotency_key,
        created_at: iso(row.created_at),
        expires_at: iso(row.expires_at),
        signature: { algorithm: row.signature_algorithm, key_id: row.signature_key_id, value: row.signature_value },
      },
    }));
  }
```

Add these two module-level helpers above `export class PostgresRepository`:

```js
function roomRow(row) {
  return {
    conversation_id: row.conversation_id,
    workspace_id: row.workspace_id,
    name: row.name,
    description: row.description ?? null,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function memberRow(row) {
  return {
    endpoint_id: row.endpoint_id,
    role: row.role,
    response_mode: row.response_mode ?? null,
    added_at: row.added_at instanceof Date ? row.added_at.toISOString() : row.added_at,
  };
}
```

- [ ] **Step 4: Make `#insertAcceptedEnvelope` room-aware**

Three changes in `#insertAcceptedEnvelope`:

1. Wrap the existing `INSERT INTO conversations ...` and both `INSERT INTO conversation_members ...` statements in `if (row.roomSeq == null) { ... }`. A room message must never create a conversation or add a member.
2. Add `room_seq` to the envelope insert. Change the column list to end with `federation_hop, stream_seq, room_seq, envelope_status`. Change `VALUES` to end with `$21,$22,$23,'accepted'`. Append `row.roomSeq ?? null` to the parameter array, after `row.streamSeq ?? null`.
3. After the existing direct-recipient delivery insert, add the fan-out, and return it:

```js
    let fanout = null;
    if (Array.isArray(row.roomFanout)) {
      fanout = [];
      for (const endpointId of row.roomFanout) {
        const fanoutDeliveryId = `del_${crypto.randomUUID()}`;
        await client.query(
          `INSERT INTO deliveries (delivery_id, message_id, recipient_endpoint_id, state, attempts, queued_at, updated_at, next_attempt_at, federation_hop)
           VALUES ($1,$2,$3,'queued',0,$4,$4,$4,false)`,
          [fanoutDeliveryId, row.envelope.message_id, endpointId, row.envelope.created_at],
        );
        fanout.push({ endpoint_id: endpointId, delivery_id: fanoutDeliveryId });
      }
    }
```

Change the final `return` of `#insertAcceptedEnvelope` to:

```js
    return { message_id: result.rows[0].message_id, duplicate: false, delivery_id: row.envelope.recipient?.endpoint_id ? deliveryId : null, ...(fanout ? { fanout } : {}) };
```

- [ ] **Step 5: Run the live test to verify it passes**

Run: `SIGIL_TEST_DATABASE_URL=postgres://sigil:sigil_password@localhost:55432/sigil_test timeout 120 node --test sigil/relay/v1/rooms.pg.test.mjs`
Expected: PASS (1 test, not skipped).

- [ ] **Step 6: Run the full live gate**

Run: `SIGIL_TEST_DATABASE_URL=postgres://sigil:sigil_password@localhost:55432/sigil_test timeout 600 npm run test:live`
Expected: all live suites pass, including `rooms.pg.test.mjs`. This shows the `#insertAcceptedEnvelope` change did not break direct delivery.

- [ ] **Step 7: Commit**

```bash
git add sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/rooms.pg.test.mjs
git commit -m "feat(sigil): add room methods to the postgres repository"
```

---

### Task 5: Room policy and accept-path wiring

**Files:**
- Create: `sigil/relay/v1/room-policy.mjs`
- Create: `sigil/relay/v1/room-policy.test.mjs`
- Modify: `sigil/relay/v1/accept-envelope.mjs` (start of the local branch near line 268; the `validateEnvelope` call near line 355; the sequence/persist block near lines 394-403)
- Test: `sigil/relay/v1/accept-envelope.rooms.test.mjs`

**Interfaces:**
- Consumes: `lookupRoom`, `lookupRoomMember`, `listRoomMembers`, `assignRoomSequence`, and `persistAcceptedEnvelope` with `roomSeq`/`roomFanout` (Tasks 3-4).
- Produces: `ROOM_MESSAGE_TYPES` (a `Set`) and `async authorizeRoomEnvelope(envelope, room, repository, client) -> string[]` (the fan-out endpoint ids). Also `assertRoomTypeHasRoom(envelope, room)`. The accept result body is unchanged. `persisted.fanout` reaches `options.onPersisted`.

- [ ] **Step 1: Write the failing policy test**

```js
// sigil/relay/v1/room-policy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeRoomEnvelope, assertRoomTypeHasRoom } from './room-policy.mjs';

const room = { conversation_id: 'room_1' };
const members = [
  { endpoint_id: 'ep_web', role: 'owner', response_mode: null },
  { endpoint_id: 'ep_claude', role: 'member', response_mode: 'joins' },
  { endpoint_id: 'ep_codex', role: 'member', response_mode: 'mentions_only' },
];
const repository = {
  async lookupRoomMember(_c, endpointId) { return members.find((m) => m.endpoint_id === endpointId) ?? null; },
  async listRoomMembers() { return members; },
};
const base = { conversation_id: 'room_1', message_type: 'room.message', sender: { endpoint_id: 'ep_web' }, broadcast_scope: { conversation_id: 'room_1' } };

test('a member broadcast fans out to every other active member', async () => {
  assert.deepEqual(await authorizeRoomEnvelope(base, room, repository, null), ['ep_claude', 'ep_codex']);
});

for (const [name, envelope] of [
  ['a direct recipient', { ...base, broadcast_scope: undefined, recipient: { endpoint_id: 'ep_claude' } }],
  ['a broadcast scope naming another conversation', { ...base, broadcast_scope: { conversation_id: 'room_2' } }],
  ['a non-member sender', { ...base, sender: { endpoint_id: 'ep_stranger' } }],
  ['a message type not allowed in rooms', { ...base, message_type: 'chat.message' }],
]) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(authorizeRoomEnvelope(envelope, room, repository, null), { code: 'ROUTE_NOT_AUTHORIZED' });
  });
}

test('room.* message types are rejected outside a room', () => {
  assert.throws(() => assertRoomTypeHasRoom({ message_type: 'room.message' }, null), { code: 'INVALID_ENVELOPE' });
  assert.doesNotThrow(() => assertRoomTypeHasRoom({ message_type: 'chat.message' }, null));
  assert.doesNotThrow(() => assertRoomTypeHasRoom({ message_type: 'room.message' }, room));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 120 node --test sigil/relay/v1/room-policy.test.mjs`
Expected: FAIL with `Cannot find module` for `room-policy.mjs`.

- [ ] **Step 3: Write the policy module**

```js
// sigil/relay/v1/room-policy.mjs
import { reject } from './validate-envelope.mjs';

// Message types a room accepts in phase 1. task.request / task.result carry
// structured delegation inside a room (rooms design: no new delegation frame).
export const ROOM_MESSAGE_TYPES = new Set(['room.message', 'task.request', 'task.result']);

export function assertRoomTypeHasRoom(envelope, room) {
  if (!room && envelope.message_type.startsWith('room.')) {
    throw reject('INVALID_ENVELOPE', 'room.* message types require a room conversation', { field: 'message_type' });
  }
}

// Authorizes an envelope addressed to a room and returns the endpoint ids to
// deliver it to. Direct (recipient) envelopes are refused because
// persistAcceptedEnvelope's direct path auto-adds sender and recipient to
// conversation_members, which would let any endpoint join a room uninvited.
export async function authorizeRoomEnvelope(envelope, room, repository, client) {
  const details = { conversation_id: envelope.conversation_id };
  if (envelope.recipient || !envelope.broadcast_scope) throw reject('ROUTE_NOT_AUTHORIZED', 'Room envelopes must use broadcast_scope', details);
  if (envelope.broadcast_scope.conversation_id !== room.conversation_id) throw reject('ROUTE_NOT_AUTHORIZED', 'broadcast_scope must name the room', details);
  if (!ROOM_MESSAGE_TYPES.has(envelope.message_type)) throw reject('ROUTE_NOT_AUTHORIZED', 'Message type is not allowed in rooms', { ...details, message_type: envelope.message_type });
  const sender = await repository.lookupRoomMember(room.conversation_id, envelope.sender.endpoint_id, client);
  if (!sender) throw reject('ROUTE_NOT_AUTHORIZED', 'Sender is not a room member', details);
  const members = await repository.listRoomMembers(room.conversation_id, client);
  return members.map((member) => member.endpoint_id).filter((endpointId) => endpointId !== envelope.sender.endpoint_id);
}
```

Before relying on `reject`, confirm that `validate-envelope.mjs` exports it (`capability-risk-gate.mjs` already imports `reject` from there) and that it accepts `(code, message, details)`.

- [ ] **Step 4: Run the policy test to verify it passes**

Run: `timeout 120 node --test sigil/relay/v1/room-policy.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing accept test**

```js
// sigil/relay/v1/accept-envelope.rooms.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

const NOW = new Date('2026-10-02T12:01:00.000Z');

function world() {
  const keys = Object.fromEntries(['ep_web', 'ep_claude', 'ep_codex', 'ep_stranger'].map((id) => [id, crypto.generateKeyPairSync('ed25519')]));
  const registered = new Map(Object.entries(keys).map(([id, pair]) => [id, { owner_id: 'usr_chris', status: 'active', key_id: `key_${id}`, public_key: pair.publicKey }]));
  const repository = createMemoryRepository({ registry: registered });
  return { keys, registered, repository };
}

function roomEnvelope(keys, senderId, overrides = {}) {
  const envelope = {
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: 'room_1', message_type: 'room.message',
    sender: { endpoint_id: senderId, owner_id: 'usr_chris' }, broadcast_scope: { conversation_id: 'room_1' },
    body: { text: 'hello room' }, context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: `idem_${crypto.randomUUID()}`, created_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-02T13:00:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: `key_${senderId}`, value: '' },
    ...overrides,
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys[senderId].privateKey).toString('base64url');
  return envelope;
}

async function roomWithMembers(repository) {
  await repository.createRoom({ conversationId: 'room_1', workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_chris', now: NOW });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_codex', role: 'member', responseMode: 'mentions_only', addedByHumanId: 'usr_chris', now: NOW });
}

test('a member room.message is accepted, sequenced, and fanned out', async () => {
  const { keys, registered, repository } = world();
  await roomWithMembers(repository);
  let persistedEvent;
  const first = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_web'), { repository, registered, now: NOW, onPersisted: async (event) => { persistedEvent = event; } });
  assert.equal(first.status, 202);
  const second = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_claude', { body: { text: 'reply', thread_root_id: first.body.message_id } }), { repository, registered, now: NOW });
  assert.equal(second.status, 202);
  const history = await repository.listRoomMessages('room_1', 0n, 100);
  assert.deepEqual(history.map((m) => m.room_seq), ['1', '2']);
  assert.deepEqual(persistedEvent.persisted.fanout.map((f) => f.endpoint_id), ['ep_claude', 'ep_codex']);
  assert.equal((await repository.listInbox('ep_codex')).length, 2);
  assert.equal((await repository.listInbox('ep_web')).length, 1, 'the sender never receives its own message');
});

test('a non-member is refused and nothing is persisted', async () => {
  const { keys, registered, repository } = world();
  await roomWithMembers(repository);
  const result = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_stranger'), { repository, registered, now: NOW });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'ROUTE_NOT_AUTHORIZED');
  assert.deepEqual(await repository.listRoomMessages('room_1', 0n, 100), []);
});

test('a direct envelope into a room conversation is refused', async () => {
  const { keys, registered, repository } = world();
  await roomWithMembers(repository);
  const result = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_web', { broadcast_scope: undefined, recipient: { endpoint_id: 'ep_claude', owner_id: 'usr_chris' } }), { repository, registered, now: NOW });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'ROUTE_NOT_AUTHORIZED');
});

test('room.message outside a room conversation is refused', async () => {
  const { keys, registered, repository } = world();
  const result = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_web', { conversation_id: 'conv_direct', broadcast_scope: undefined, recipient: { endpoint_id: 'ep_claude', owner_id: 'usr_chris' } }), { repository, registered, now: NOW });
  assert.equal(result.body.code, 'INVALID_ENVELOPE');
});

test('a room message replayed with the same idempotency key is a duplicate, not a new room_seq', async () => {
  const { keys, registered, repository } = world();
  await roomWithMembers(repository);
  const envelope = roomEnvelope(keys, 'ep_web');
  await acceptEnvelopeAsync(envelope, { repository, registered, now: NOW });
  const replay = await acceptEnvelopeAsync(envelope, { repository, registered, now: NOW });
  assert.equal(replay.body.duplicate, true);
  assert.deepEqual((await repository.listRoomMessages('room_1', 0n, 100)).map((m) => m.room_seq), ['1']);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `timeout 120 node --test sigil/relay/v1/accept-envelope.rooms.test.mjs`
Expected: FAIL. The first test gets `ROUTE_NOT_AUTHORIZED` ("Broadcast scope is not authorized"), because no `broadcastAuthorizer` is passed yet.

- [ ] **Step 7: Wire the policy into `acceptWithRepository`**

In `sigil/relay/v1/accept-envelope.mjs`, import the policy:

```js
import { authorizeRoomEnvelope, assertRoomTypeHasRoom } from './room-policy.mjs';
```

At the start of the local branch, directly after the `if (route.action === 'forward') { ... }` block and before the recipient lookup, add:

```js
    // Rooms (rooms design, phase 1): a room conversation accepts only member
    // broadcasts; the fan-out list is computed here, on this transaction's client.
    const room = repository.lookupRoom ? await repository.lookupRoom(envelope.conversation_id, client) : null;
    assertRoomTypeHasRoom(envelope, room);
    const roomFanout = room ? await authorizeRoomEnvelope(envelope, room, repository, client) : null;
```

Change the main `validateEnvelope` call (the one directly before `lookupIdempotency`, near line 355) so that room broadcasts, already authorized, pass the broadcast gate:

```js
    const result = validateEnvelope(envelope, { ...options, idempotency: new Map(), capabilityGrants, ...(room ? { broadcastAuthorizer: () => true } : {}) });
```

After the `streamSeq` assignment, and before `persistAcceptedEnvelope`, add:

```js
    const roomSeq = room ? await repository.assignRoomSequence(client, envelope.conversation_id) : null;
```

Change the persist call to pass both new fields:

```js
    const persisted = await repository.persistAcceptedEnvelope({ envelope, ...result, canonical_bytes: signedBytes(envelope), action_hash: result.canonical_hash, streamSeq, roomSeq, roomFanout }, client);
```

The duplicate-idempotency return happens before `assignRoomSequence`, so a replay never consumes a sequence number. Keep that order.

- [ ] **Step 8: Run the room tests and the existing accept suites**

Run: `timeout 120 node --test sigil/relay/v1/accept-envelope.rooms.test.mjs sigil/relay/v1/room-policy.test.mjs sigil/relay/v1/accept-envelope.test.mjs sigil/relay/v1/accept-envelope.stream-sequence.test.mjs sigil/relay/v1/accept-envelope.resend.test.mjs sigil/relay/v1/accept-envelope.federation-queue.test.mjs sigil/relay/v1/accept-envelope.federation-sync.test.mjs`
Expected: PASS. Fake repositories without `lookupRoom` skip the room path, because of the `repository.lookupRoom ?` guard.

- [ ] **Step 9: Commit**

```bash
git add sigil/relay/v1/room-policy.mjs sigil/relay/v1/room-policy.test.mjs sigil/relay/v1/accept-envelope.mjs sigil/relay/v1/accept-envelope.rooms.test.mjs
git commit -m "feat(sigil): accept, sequence, and fan out room messages"
```

---

### Task 6: Stream notification for room fan-out

**Files:**
- Modify: `sigil/relay/v1/http-server.mjs` (`createOnPersisted`, near line 56)
- Test: `sigil/relay/v1/http-server.rooms-stream.test.mjs` (create)

**Interfaces:**
- Consumes: `persisted.fanout` (Task 5).
- Produces: one `stream.notify(endpointId, deliveryId, streamSeq)` per fan-out entry.

- [ ] **Step 1: Write the failing test**

```js
// sigil/relay/v1/http-server.rooms-stream.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnPersisted } from './http-server.mjs';

test('room fan-out notifies every recipient stream', async () => {
  const notified = [];
  const stream = { notify: (endpointId, deliveryId, streamSeq) => notified.push([endpointId, deliveryId, streamSeq]) };
  await createOnPersisted(stream)({
    envelope: { sender: { endpoint_id: 'ep_web' }, broadcast_scope: { conversation_id: 'room_1' }, created_at: '2026-10-02T12:00:00.000Z' },
    persisted: { message_id: 'msg_1', duplicate: false, streamSeq: 3n, fanout: [{ endpoint_id: 'ep_claude', delivery_id: 'del_a' }, { endpoint_id: 'ep_codex', delivery_id: 'del_b' }] },
  });
  assert.deepEqual(notified, [['ep_claude', 'del_a', 3n], ['ep_codex', 'del_b', 3n]]);
});

test('duplicates notify nobody', async () => {
  const notified = [];
  await createOnPersisted({ notify: (...args) => notified.push(args) })({
    envelope: { sender: { endpoint_id: 'ep_web' } },
    persisted: { message_id: 'msg_1', duplicate: true, fanout: [{ endpoint_id: 'ep_claude', delivery_id: 'del_a' }] },
  });
  assert.deepEqual(notified, []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 120 node --test sigil/relay/v1/http-server.rooms-stream.test.mjs`
Expected: the first test FAILs with `notified` equal to `[]`. If it fails instead because `createOnPersisted` is not exported, export it in Step 3 as well (it is already `export function` at line 56; confirm).

- [ ] **Step 3: Notify each fan-out recipient**

In `createOnPersisted`, directly after the existing `if (accepted.recipient?.endpoint_id) stream.notify(...)` line, add:

```js
      for (const target of persisted.fanout ?? []) stream.notify(target.endpoint_id, target.delivery_id, persisted.streamSeq);
```

- [ ] **Step 4: Run the test and the existing HTTP suite**

Run: `timeout 120 node --test sigil/relay/v1/http-server.rooms-stream.test.mjs sigil/relay/v1/http-server.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/http-server.mjs sigil/relay/v1/http-server.rooms-stream.test.mjs
git commit -m "feat(sigil): notify streams for room fan-out deliveries"
```

---

### Task 7: Room HTTP routes and contract

**Files:**
- Create: `sigil/relay/v1/room-routes.mjs`
- Create: `sigil/relay/v1/room-routes.test.mjs`
- Modify: `sigil/relay/v1/http-server.mjs` (delegate to the room routes right after the `/v1/envelopes` handler, near line 417)
- Modify: `sigil/contracts/v1/relay-api.json` (route entries)

**Interfaces:**
- Consumes: the repository room methods (Tasks 3-4); the authenticated `principal` (`{ endpoint_id, owner_id, human_id }`) from `http-server.mjs`.
- Produces: `async handleRoomRoute({ request, response, parsedUrl, principal, repository, registry, requestId, now, readBody }) -> boolean` (true when the route was handled), and these routes:

| Method and path | Who | Success |
|---|---|---|
| `POST /v1/rooms` `{ name, description? }` | any authenticated principal with `human_id` | 201 `{ room }` |
| `GET /v1/rooms` | any authenticated principal | 200 `{ items: room[] }` |
| `GET /v1/rooms/{id}/members` | active room member | 200 `{ items: member[] }` |
| `POST /v1/rooms/{id}/members` `{ endpoint_id, role?, response_mode? }` | room `owner` or `room_manager`; the endpoint must be active and owned by `principal.human_id` | 201 `{ member }` |
| `POST /v1/rooms/{id}/members/{endpoint_id}/remove` | room `owner` or `room_manager`; the owner cannot be removed | 200 `{ removed: true }` |
| `GET /v1/rooms/{id}/messages?after_seq=N&limit=M` | active room member | 200 `{ items, next_after_seq }` |

Error codes: `UNAUTHENTICATED` 401 (already handled by the server gate); `HUMAN_CONTEXT_REQUIRED` 403; `ROOM_NOT_FOUND` 404 (also returned to non-members, so room existence does not leak); `ROUTE_NOT_AUTHORIZED` 403; `INVALID_REQUEST` 400; `ROOM_NAME_TAKEN` 409; `ROOM_MEMBER_EXISTS` 409; `DATABASE_UNAVAILABLE` 503 when the repository lacks room methods.

- [ ] **Step 1: Write the failing route test**

```js
// sigil/relay/v1/room-routes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

const principals = {
  'Bearer chris-web': { endpoint_id: 'ep_web', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer claude': { endpoint_id: 'ep_claude', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer stranger': { endpoint_id: 'ep_stranger', owner_id: 'usr_other', human_id: 'usr_other' },
};
const registry = new Map([
  ['ep_web', { owner_id: 'usr_chris', status: 'active' }],
  ['ep_claude', { owner_id: 'usr_chris', status: 'active' }],
  ['ep_other_agent', { owner_id: 'usr_other', status: 'active' }],
]);

function call(port, method, path, authorization, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(authorization ? { authorization } : {}) } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function withServer(fn) {
  const repository = createMemoryRepository({ registry });
  const server = createRelayServer({ registry, repository, authenticate: async (request) => principals[request.headers.authorization] ?? null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(server.address().port, repository); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('create, list, add member, read history, remove member', async () => {
  await withServer(async (port) => {
    const created = await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'build', description: 'agents' });
    assert.equal(created.status, 201);
    const roomId = created.body.room.conversation_id;
    assert.match(roomId, /^room_/);
    assert.equal((await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'build' })).body.code, 'ROOM_NAME_TAKEN');

    const added = await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_claude', response_mode: 'joins' });
    assert.equal(added.status, 201);
    assert.equal(added.body.member.role, 'member');

    const listed = await call(port, 'GET', '/v1/rooms', 'Bearer claude');
    assert.deepEqual(listed.body.items.map((r) => r.conversation_id), [roomId]);
    const members = await call(port, 'GET', `/v1/rooms/${roomId}/members`, 'Bearer claude');
    assert.deepEqual(members.body.items.map((m) => m.endpoint_id), ['ep_web', 'ep_claude']);

    const history = await call(port, 'GET', `/v1/rooms/${roomId}/messages?after_seq=0`, 'Bearer claude');
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.items, []);
    assert.equal(history.body.next_after_seq, '0');

    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members/ep_web/remove`, 'Bearer chris-web')).body.code, 'ROUTE_NOT_AUTHORIZED', 'the owner cannot be removed');
    const removed = await call(port, 'POST', `/v1/rooms/${roomId}/members/ep_claude/remove`, 'Bearer chris-web');
    assert.equal(removed.status, 200);
    assert.equal((await call(port, 'GET', `/v1/rooms/${roomId}/messages`, 'Bearer claude')).status, 404);
  });
});

test('authorization rules', async () => {
  await withServer(async (port) => {
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'ops' })).body.room.conversation_id;
    assert.equal((await call(port, 'GET', `/v1/rooms/${roomId}/messages`, 'Bearer stranger')).status, 404, 'non-members cannot see the room');
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer stranger', { endpoint_id: 'ep_other_agent' })).status, 404);
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_other_agent' })).body.code, 'ROUTE_NOT_AUTHORIZED', 'v1 adds only endpoints you own');
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_missing' })).body.code, 'ROUTE_NOT_AUTHORIZED');
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_claude', role: 'owner' })).body.code, 'INVALID_REQUEST', 'owner cannot be granted');
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_claude', response_mode: 'always' })).body.code, 'INVALID_REQUEST');
    assert.equal((await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: '' })).body.code, 'INVALID_REQUEST');
    assert.equal((await call(port, 'GET', `/v1/rooms/${roomId}/messages?after_seq=-1`, 'Bearer chris-web')).body.code, 'INVALID_REQUEST');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 120 node --test sigil/relay/v1/room-routes.test.mjs`
Expected: FAIL. `POST /v1/rooms` returns 404 (the route does not exist yet).

- [ ] **Step 3: Write the route module**

```js
// sigil/relay/v1/room-routes.mjs
import crypto from 'node:crypto';

const MANAGER_ROLES = new Set(['owner', 'room_manager']);
const GRANTABLE_ROLES = new Set(['room_manager', 'member']);
const RESPONSE_MODES = new Set(['joins', 'mentions_only']);
const ROOM_METHODS = ['createRoom', 'lookupRoom', 'listRoomsForEndpoint', 'addRoomMember', 'removeRoomMember', 'lookupRoomMember', 'listRoomMembers', 'listRoomMessages'];
const NAME_MAX = 80;
const HISTORY_LIMIT_MAX = 500;

function send(response, requestId, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
  response.end(JSON.stringify({ request_id: requestId, ...body }));
  return true;
}

function fail(response, requestId, status, code, message) {
  return send(response, requestId, status, { code, message, details: {} });
}

async function readJson(request, readBody) {
  try { return JSON.parse((await readBody(request, 64 * 1024)) || '{}'); } catch { return null; }
}

// Returns the caller's active membership, or null. Callers answer ROOM_NOT_FOUND
// for both "no such room" and "not a member" so room existence never leaks.
async function membership(repository, roomId, principal) {
  const room = await repository.lookupRoom(roomId);
  if (!room) return null;
  const member = await repository.lookupRoomMember(roomId, principal.endpoint_id);
  return member ? { room, member } : null;
}

export async function handleRoomRoute({ request, response, parsedUrl, principal, repository, registry, requestId, now, readBody }) {
  const path = parsedUrl.pathname;
  if (path !== '/v1/rooms' && !path.startsWith('/v1/rooms/')) return false;
  if (!repository || ROOM_METHODS.some((method) => typeof repository[method] !== 'function')) return fail(response, requestId, 503, 'DATABASE_UNAVAILABLE', 'Rooms are unavailable');

  if (request.method === 'POST' && path === '/v1/rooms') {
    if (!principal?.human_id) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'An authenticated human context is required');
    const body = await readJson(request, readBody);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > NAME_MAX) return fail(response, requestId, 400, 'INVALID_REQUEST', `name must be 1-${NAME_MAX} characters`);
    if (body.description != null && typeof body.description !== 'string') return fail(response, requestId, 400, 'INVALID_REQUEST', 'description must be a string');
    try {
      const room = await repository.createRoom({
        conversationId: `room_${crypto.randomUUID()}`, workspaceId: `ws_${principal.human_id}`, name, description: body.description ?? null,
        createdByHumanId: principal.human_id, ownerEndpointId: principal.endpoint_id, now,
      });
      return send(response, requestId, 201, { code: 'OK', room });
    } catch (error) {
      if (error.code === 'ROOM_NAME_TAKEN') return fail(response, requestId, 409, 'ROOM_NAME_TAKEN', error.message);
      throw error;
    }
  }

  if (request.method === 'GET' && path === '/v1/rooms') {
    return send(response, requestId, 200, { code: 'OK', items: await repository.listRoomsForEndpoint(principal.endpoint_id) });
  }

  const match = path.match(/^\/v1\/rooms\/([^/]+)\/(members|messages)(?:\/([^/]+)\/(remove))?$/);
  if (!match) return false;
  const [, roomId, resource, targetEndpointId, action] = match;
  const access = await membership(repository, roomId, principal);
  if (!access) return fail(response, requestId, 404, 'ROOM_NOT_FOUND', 'Room not found');

  if (request.method === 'GET' && resource === 'members' && !action) {
    return send(response, requestId, 200, { code: 'OK', items: await repository.listRoomMembers(roomId) });
  }

  if (request.method === 'POST' && resource === 'members' && !action) {
    if (!MANAGER_ROLES.has(access.member.role)) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'Only room managers can add members');
    const body = await readJson(request, readBody);
    const endpointId = body?.endpoint_id;
    const role = body?.role ?? 'member';
    const responseMode = body?.response_mode ?? null;
    if (typeof endpointId !== 'string' || !endpointId) return fail(response, requestId, 400, 'INVALID_REQUEST', 'endpoint_id is required');
    if (!GRANTABLE_ROLES.has(role)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'role must be room_manager or member');
    if (responseMode !== null && !RESPONSE_MODES.has(responseMode)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'response_mode must be joins or mentions_only');
    const endpoint = registry?.get?.(endpointId);
    if (!endpoint || endpoint.status !== 'active' || endpoint.owner_id !== principal.human_id) {
      return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'You can only add active endpoints you own');
    }
    try {
      const member = await repository.addRoomMember({ conversationId: roomId, endpointId, role, responseMode, addedByHumanId: principal.human_id, now });
      return send(response, requestId, 201, { code: 'OK', member });
    } catch (error) {
      if (error.code === 'ROOM_MEMBER_EXISTS') return fail(response, requestId, 409, 'ROOM_MEMBER_EXISTS', error.message);
      throw error;
    }
  }

  if (request.method === 'POST' && resource === 'members' && action === 'remove') {
    if (!MANAGER_ROLES.has(access.member.role)) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'Only room managers can remove members');
    const target = await repository.lookupRoomMember(roomId, targetEndpointId);
    if (!target) return fail(response, requestId, 404, 'ROOM_MEMBER_NOT_FOUND', 'Member not found');
    if (target.role === 'owner') return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'The room owner cannot be removed');
    await repository.removeRoomMember({ conversationId: roomId, endpointId: targetEndpointId, now });
    return send(response, requestId, 200, { code: 'OK', removed: true });
  }

  if (request.method === 'GET' && resource === 'messages' && !action) {
    const afterRaw = parsedUrl.searchParams.get('after_seq') ?? '0';
    const limitRaw = parsedUrl.searchParams.get('limit') ?? '100';
    if (!/^\d+$/.test(afterRaw) || !/^\d+$/.test(limitRaw)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'after_seq and limit must be non-negative integers');
    const limit = Math.min(Math.max(Number(limitRaw), 1), HISTORY_LIMIT_MAX);
    const items = await repository.listRoomMessages(roomId, BigInt(afterRaw), limit);
    return send(response, requestId, 200, { code: 'OK', items, next_after_seq: items.at(-1)?.room_seq ?? afterRaw });
  }

  return false;
}
```

- [ ] **Step 4: Delegate from the HTTP server**

In `sigil/relay/v1/http-server.mjs`, import the module:

```js
import { handleRoomRoute } from './room-routes.mjs';
```

Directly after the closing brace of the `if (request.method === 'POST' && request.url === '/v1/envelopes') { ... }` block, add:

```js
    if (await handleRoomRoute({ request, response, parsedUrl, principal, repository, registry, requestId, now, readBody })) return;
```

It sits after the authentication gate (around line 313), so every room route requires an authenticated principal.

- [ ] **Step 5: Add the contract entries**

In `sigil/contracts/v1/relay-api.json`, add these entries to `routes`, after the `/v1/envelopes` entry:

```json
    {"method":"POST","path":"/v1/rooms","success":201,"errors":["UNAUTHENTICATED","HUMAN_CONTEXT_REQUIRED","INVALID_REQUEST","ROOM_NAME_TAKEN","DATABASE_UNAVAILABLE"]},
    {"method":"GET","path":"/v1/rooms","success":200,"errors":["UNAUTHENTICATED","DATABASE_UNAVAILABLE"]},
    {"method":"GET","path":"/v1/rooms/{room_id}/members","success":200,"errors":["UNAUTHENTICATED","ROOM_NOT_FOUND"]},
    {"method":"POST","path":"/v1/rooms/{room_id}/members","success":201,"errors":["UNAUTHENTICATED","ROOM_NOT_FOUND","ROUTE_NOT_AUTHORIZED","INVALID_REQUEST","ROOM_MEMBER_EXISTS"]},
    {"method":"POST","path":"/v1/rooms/{room_id}/members/{endpoint_id}/remove","success":200,"errors":["UNAUTHENTICATED","ROOM_NOT_FOUND","ROUTE_NOT_AUTHORIZED","ROOM_MEMBER_NOT_FOUND"]},
    {"method":"GET","path":"/v1/rooms/{room_id}/messages?after_seq=<n>&limit=<n>","success":200,"errors":["UNAUTHENTICATED","ROOM_NOT_FOUND","INVALID_REQUEST"]},
```

Then run `timeout 120 node --test sigil/contracts/v1/relay-api.test.mjs sigil/contracts/v1/validate-contracts.test.mjs`. If either test pins the route count or requires error codes to appear in `errors-and-states.json`, add the new codes there (`ROOM_NAME_TAKEN`, `ROOM_MEMBER_EXISTS`, `ROOM_NOT_FOUND`, `ROOM_MEMBER_NOT_FOUND`, `INVALID_REQUEST`, `HUMAN_CONTEXT_REQUIRED`, `DATABASE_UNAVAILABLE`, using its existing entry shape), and update any pinned count.

- [ ] **Step 6: Run the route test and the HTTP and contract suites**

Run: `timeout 120 node --test sigil/relay/v1/room-routes.test.mjs sigil/relay/v1/http-server.test.mjs sigil/contracts/v1/relay-api.test.mjs sigil/contracts/v1/validate-contracts.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add sigil/relay/v1/room-routes.mjs sigil/relay/v1/room-routes.test.mjs sigil/relay/v1/http-server.mjs sigil/contracts/v1/relay-api.json sigil/contracts/v1/errors-and-states.json
git commit -m "feat(sigil): add room HTTP routes and contract entries"
```

---

### Task 8: Full verification

**Files:** none changed unless a check fails.

- [ ] **Step 1: Full unit suite, single run**

Run: `timeout 900 npm test`
Expected: all tests pass, and the dependency and JCS audits pass. Compare the pass count with the latest `main` CI run on GitHub (`gh run list --branch main --limit 1`, then `gh run view <id> --log`). The count must rise by the new tests only, with no new failures or skips.

- [ ] **Step 2: Live Postgres gate**

Run: `SIGIL_TEST_DATABASE_URL=postgres://sigil:sigil_password@localhost:55432/sigil_test timeout 900 npm run test:live`
Expected: all live suites pass, including `rooms.pg.test.mjs`.

- [ ] **Step 3: Packaging check**

Run: `timeout 120 npm pack --dry-run`
Expected: the tarball lists `sigil/migrations/027_rooms.sql`, `sigil/relay/v1/room-policy.mjs`, and `sigil/relay/v1/room-routes.mjs` (covered by the existing `sigil/migrations/*.sql` and `sigil/relay/v1/*.mjs` globs). Known pre-existing defect, confirmed 2026-10-02 on `origin/main` `f0bc829`: `package.json` `files` ships only `sigil/contracts/v1/*.json`, and `npm pack --dry-run` lists zero contract `.mjs` files. But `sigil/relay/v1/validate-envelope.mjs` (which ships) imports `task-request-schema.mjs`, `task-result-schema.mjs`, and `session-resend-request-schema.mjs` from `sigil/contracts/v1/`. In the published package, importing the relay therefore fails with `ERR_MODULE_NOT_FOUND`. `room-message-schema.mjs` inherits the same gap. The fix (adding `"sigil/contracts/v1/*.mjs"` to `files`) belongs in its own `fix(sigil)` PR off `main`, with a test that imports `validate-envelope.mjs` from an unpacked tarball. Link that PR in this phase's PR description. Do not fold it into this branch.

- [ ] **Step 4: Phase 1 exit check, written into STATUS.md**

Record in `STATUS.md`:
- the phase-1 completion date;
- the unit and live pass counts;
- the PR link once opened;
- next action: phase 2 (Claude and Codex bridges plus the loop and cost guards).

Commit with `docs(status): record sigil rooms phase 1 completion`.
