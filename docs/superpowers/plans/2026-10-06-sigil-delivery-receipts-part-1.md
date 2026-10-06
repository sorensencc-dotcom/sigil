# Sigil delivery receipts, Part 1 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sender can read the receipt state of every recipient of a message through `GET /v1/messages/{message_id}/receipts`, and the `delivery.receipt` frame names the recipient and carries the mapped state, with one frame per fan-out target and truthful `queued`/`delivered` states on Postgres.

**Architecture:** A pure state-mapping module feeds a new sender-only route backed by a new `listReceiptsForMessage` repository method (Postgres and in-memory). A shared `sendReceiptFrame` helper sends post-commit frames from the ack, processing, and inbox routes, each in its own `try`. `createOnPersisted` sends one frame per fan-out target using a `deliveryState` that `acceptEnvelopeAsync` reads from the repository.

**Tech Stack:** Node.js ESM, `node:test`, `pg`, `ws`. Tests run with `node --test <file>`. Postgres tests need `SIGIL_TEST_DATABASE_URL` pointing at a disposable database and skip without it.

**Spec:** `docs/superpowers/specs/2026-10-05-sigil-delivery-receipts-design.md` (Part 1 section, States table, Recipient set, frame timing). Read it before Task 1. Part 2 and Part 3 are out of scope for this plan, as is every 4a item (`room.updated`, browser acks).

## Global Constraints

- Work only in `C:\dev\.worktrees\sigil-receipts-p1` on branch `plan/sigil-receipts-part1`. Run `npm ci` there first if `node_modules` is missing, or the pre-push hook fails with `ERR_MODULE_NOT_FOUND`.
- Run tests with a hard timeout: `timeout 60 node --test <file>`. The full suite runs in the pre-push hook (about 45 seconds). Run one full-suite push at a time.
- The relay is plain `.mjs` with no build step and no TypeScript. Match the surrounding style: single quotes, semicolons, two-space indent, `node:` import prefixes.
- A receipt state shown to the sender is mapped as in the spec States table: `queued`→`queued`, `delivered`→`delivered`, `acknowledged` and `processing`→`read`, `processed`→`processed`, `delivery_rejected`, `processing_failed`, and `dead_letter`→`failed`. The route also returns the raw state.
- Only the original sender endpoint may read a message's receipts. Any other caller and any unknown `message_id` get the same `404` body (apart from `request_id`).
- Frames are hints and never replayed. A frame must never announce an uncommitted state.
- The in-memory repository keeps inserting deliveries as `delivered` in this plan. The spec leaves that choice to the plan: leave it, because the in-memory `listInbox` only returns `delivered` rows and has no flip. Add no `queued` insert there.
- Commit messages end with the attribution line given in the session, and use a `feat(sigil):`, `test(sigil):`, or `docs(sigil):` prefix. Commit tests with the code they cover.

## File structure

- Create `sigil/relay/v1/receipt-state.mjs`: `mapReceiptState`, `receiptTimestamp`, `toReceiptRow`. Pure functions, no I/O.
- Create `sigil/relay/v1/receipt-state.test.mjs`.
- Create `sigil/relay/v1/receipt-notify.mjs`: `sendReceiptFrame`, the post-commit frame sender shared by three routes.
- Create `sigil/relay/v1/receipt-notify.test.mjs`.
- Create `sigil/relay/v1/receipts.route.test.mjs`: route tests and the ack/processing/inbox frame tests (HTTP level, fake repositories).
- Create `sigil/relay/v1/receipts.pg.test.mjs`: Postgres `listReceiptsForMessage` and the `listInbox` flip.
- Create `sigil/cli/memory-repository.receipts.test.mjs`.
- Modify `sigil/relay/v1/http-server.mjs`: the new route, `createOnPersisted`, the ack/processing/inbox routes.
- Modify `sigil/relay/v1/postgres-repository.mjs`: `initialDeliveryState`, `listReceiptsForMessage`, the `listInbox` flip.
- Modify `sigil/cli/memory-repository.mjs`: `initialDeliveryState`, `listReceiptsForMessage`.
- Modify `sigil/relay/v1/accept-envelope.mjs:438`: add `deliveryState`.
- Modify `sigil/relay/v1/room-dispatch.mjs`: add `message_id` to room delivery entries.
- Modify `sigil/cli/sigil.mjs:399`: pass `{ repository, logger }` to `createOnPersisted`.
- Modify `sigil/contracts/v1/relay-api.json` and `CHANGELOG.md`.

---

### Task 1: Receipt state mapping

**Files:**
- Create: `sigil/relay/v1/receipt-state.mjs`
- Test: `sigil/relay/v1/receipt-state.test.mjs`

**Interfaces:**
- Produces: `mapReceiptState(rawState: string): 'queued'|'delivered'|'read'|'processed'|'failed'|'unknown'`; `receiptTimestamp(row): string|null`; `toReceiptRow(row): { recipient_endpoint_id, state, raw_state, at }`. Later tasks import these exact names.

- [ ] **Step 1: Write the failing test**

Create `sigil/relay/v1/receipt-state.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapReceiptState, receiptTimestamp, toReceiptRow } from './receipt-state.mjs';

test('mapReceiptState follows the spec States table', () => {
  assert.equal(mapReceiptState('queued'), 'queued');
  assert.equal(mapReceiptState('delivered'), 'delivered');
  assert.equal(mapReceiptState('acknowledged'), 'read');
  assert.equal(mapReceiptState('processing'), 'read');
  assert.equal(mapReceiptState('processed'), 'processed');
  for (const raw of ['delivery_rejected', 'processing_failed', 'dead_letter']) assert.equal(mapReceiptState(raw), 'failed');
  assert.equal(mapReceiptState('something_new'), 'unknown');
});

test('receiptTimestamp picks the column that matches the state and falls back to queued_at', () => {
  const base = { queued_at: '2026-10-06T00:00:00.000Z', updated_at: '2026-10-06T00:00:09.000Z' };
  assert.equal(receiptTimestamp({ ...base, state: 'queued' }), base.queued_at);
  assert.equal(receiptTimestamp({ ...base, state: 'delivered', delivered_at: '2026-10-06T00:00:01.000Z' }), '2026-10-06T00:00:01.000Z');
  assert.equal(receiptTimestamp({ ...base, state: 'delivered', delivered_at: null }), base.queued_at, 'in-memory rows have no delivered_at');
  assert.equal(receiptTimestamp({ ...base, state: 'acknowledged', acknowledged_at: '2026-10-06T00:00:02.000Z' }), '2026-10-06T00:00:02.000Z');
  assert.equal(receiptTimestamp({ ...base, state: 'processing', processing_at: '2026-10-06T00:00:03.000Z' }), '2026-10-06T00:00:03.000Z');
  assert.equal(receiptTimestamp({ ...base, state: 'processed', processed_at: '2026-10-06T00:00:04.000Z' }), '2026-10-06T00:00:04.000Z');
  assert.equal(receiptTimestamp({ ...base, state: 'processing_failed' }), base.updated_at);
  assert.equal(receiptTimestamp({ ...base, state: 'dead_letter' }), base.updated_at);
});

test('receiptTimestamp converts Date values from pg to ISO strings', () => {
  const at = new Date('2026-10-06T01:02:03.000Z');
  assert.equal(receiptTimestamp({ state: 'delivered', delivered_at: at, queued_at: at }), '2026-10-06T01:02:03.000Z');
});

test('toReceiptRow returns the mapped and raw state side by side', () => {
  const row = toReceiptRow({ recipient_endpoint_id: 'ep_a', state: 'processing_failed', queued_at: '2026-10-06T00:00:00.000Z', updated_at: '2026-10-06T00:00:05.000Z' });
  assert.deepEqual(row, { recipient_endpoint_id: 'ep_a', state: 'failed', raw_state: 'processing_failed', at: '2026-10-06T00:00:05.000Z' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:\dev\.worktrees\sigil-receipts-p1 && timeout 60 node --test sigil/relay/v1/receipt-state.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `receipt-state.mjs`.

- [ ] **Step 3: Write the implementation**

Create `sigil/relay/v1/receipt-state.mjs`:

```js
// Maps the relay's `deliveries.state` to what a sender sees. `read` means the
// recipient's client acked; it does not prove a person or model read the
// message. `failed` can be current-state rather than final, because
// `processing_failed` may retry (delivery-state.mjs).
const MAPPED = Object.freeze({
  queued: 'queued',
  delivered: 'delivered',
  acknowledged: 'read',
  processing: 'read',
  processed: 'processed',
  delivery_rejected: 'failed',
  processing_failed: 'failed',
  dead_letter: 'failed',
});

export function mapReceiptState(rawState) {
  return MAPPED[rawState] ?? 'unknown';
}

function iso(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

// The timestamp that matches the state. The in-memory repository never sets
// `delivered_at`, so `delivered` falls back to `queued_at`.
export function receiptTimestamp(row) {
  switch (row.state) {
    case 'delivered': return iso(row.delivered_at) ?? iso(row.queued_at);
    case 'acknowledged': return iso(row.acknowledged_at) ?? iso(row.updated_at) ?? iso(row.queued_at);
    case 'processing': return iso(row.processing_at) ?? iso(row.updated_at) ?? iso(row.queued_at);
    case 'processed': return iso(row.processed_at) ?? iso(row.updated_at) ?? iso(row.queued_at);
    case 'delivery_rejected':
    case 'processing_failed':
    case 'dead_letter': return iso(row.updated_at) ?? iso(row.queued_at);
    default: return iso(row.queued_at);
  }
}

export function toReceiptRow(row) {
  return {
    recipient_endpoint_id: row.recipient_endpoint_id,
    state: mapReceiptState(row.state),
    raw_state: row.state,
    at: receiptTimestamp(row),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `timeout 60 node --test sigil/relay/v1/receipt-state.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/receipt-state.mjs sigil/relay/v1/receipt-state.test.mjs
git commit -m "feat(sigil): receipt state mapping"
```

---

### Task 2: `listReceiptsForMessage` and `initialDeliveryState` in both repositories

**Files:**
- Modify: `sigil/cli/memory-repository.mjs` (inside the object returned at line 97; add next to `lookupMessageSender`, about line 592)
- Modify: `sigil/relay/v1/postgres-repository.mjs` (class at line 173; add next to `lookupMessageSender`, about line 248)
- Test: `sigil/cli/memory-repository.receipts.test.mjs`, `sigil/relay/v1/receipts.pg.test.mjs`

**Interfaces:**
- Produces: `repository.listReceiptsForMessage(messageId): Promise<Row[]>`, raw `deliveries`-shaped rows ordered by `queued_at` then `recipient_endpoint_id`. `repository.initialDeliveryState`: `'queued'` on Postgres, `'delivered'` in memory. Task 3 and Task 5 rely on both.

- [ ] **Step 1: Write the failing in-memory test**

Create `sigil/cli/memory-repository.receipts.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

function row(messageId, roomFanout) {
  return {
    message_id: messageId,
    envelope: { message_id: messageId, sender: { endpoint_id: 'ep_sender' }, idempotency_key: `k_${messageId}`, recipient: null },
    canonical_hash: 'h',
    roomFanout,
  };
}

test('in-memory repository reports its initial delivery state', () => {
  assert.equal(createMemoryRepository().initialDeliveryState, 'delivered');
});

test('listReceiptsForMessage returns one row per delivery, ordered by queued_at then recipient', async () => {
  const repository = createMemoryRepository();
  await repository.persistAcceptedEnvelope(row('msg_a', ['ep_z', 'ep_b', 'ep_m']));
  await repository.persistAcceptedEnvelope(row('msg_other', ['ep_x']));
  const rows = await repository.listReceiptsForMessage('msg_a');
  assert.deepEqual(rows.map((r) => r.recipient_endpoint_id).sort(), ['ep_b', 'ep_m', 'ep_z']);
  for (let i = 1; i < rows.length; i += 1) {
    const [prev, next] = [rows[i - 1], rows[i]];
    assert.ok(prev.queued_at < next.queued_at || (prev.queued_at === next.queued_at && prev.recipient_endpoint_id < next.recipient_endpoint_id), 'rows must be ordered');
  }
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.message_id === 'msg_a'));
});

test('listReceiptsForMessage returns an empty list for a message with no deliveries', async () => {
  const repository = createMemoryRepository();
  assert.deepEqual(await repository.listReceiptsForMessage('msg_missing'), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 60 node --test sigil/cli/memory-repository.receipts.test.mjs`
Expected: FAIL: `initialDeliveryState` is `undefined` and `listReceiptsForMessage is not a function`.

- [ ] **Step 3: Implement the in-memory side**

In `sigil/cli/memory-repository.mjs`, directly after the `async lookupMessageSender(messageId) { ... },` method (about line 592-595), add:

```js
    // What a freshly inserted delivery's state is. The accept-time receipt
    // frame reads it so the sender sees the row's real state. This store
    // inserts `delivered` directly and its `listInbox` has no queued-to-delivered flip.
    initialDeliveryState: 'delivered',
    async listReceiptsForMessage(messageId) {
      return [...deliveries.values()]
        .filter((d) => d.message_id === messageId)
        .sort((a, b) => {
          if (a.queued_at !== b.queued_at) return a.queued_at < b.queued_at ? -1 : 1;
          if (a.recipient_endpoint_id === b.recipient_endpoint_id) return 0;
          return a.recipient_endpoint_id < b.recipient_endpoint_id ? -1 : 1;
        })
        .map((d) => ({ ...d }));
    },
```

- [ ] **Step 4: Run it to verify it passes**

Run: `timeout 60 node --test sigil/cli/memory-repository.receipts.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing Postgres test**

Create `sigil/relay/v1/receipts.pg.test.mjs`. Copy the `seed` function from `sigil/relay/v1/rooms.pg.test.mjs` (lines 11-33) and the imports (lines 1-9) verbatim, then add:

```js
test('postgres listReceiptsForMessage orders rows and initialDeliveryState is queued', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = await seed(pool, suffix);
  const repository = new PostgresRepository({ pool });
  assert.equal(repository.initialDeliveryState, 'queued');

  const conversationId = `room_${suffix}`;
  const now = new Date();
  await repository.createRoom({ conversationId, workspaceId: `ws_${ids.human}`, name: `rcpt_${suffix}`, createdByHumanId: ids.human, ownerEndpointId: ids.web, now });
  await repository.addRoomMember({ conversationId, endpointId: ids.claude, role: 'member', responseMode: 'joins', addedByHumanId: ids.human, now });
  await repository.addRoomMember({ conversationId, endpointId: ids.codex, role: 'member', responseMode: 'mentions_only', addedByHumanId: ids.human, now });

  await repository.withTransaction(async (client) => {
    const roomSeq = await repository.assignRoomSequence(client, conversationId);
    const envelope = {
      protocol: 'sigil/1', message_id: `msg_${suffix}`, conversation_id: conversationId, message_type: 'room.message',
      sender: { endpoint_id: ids.web, owner_id: ids.human }, broadcast_scope: { conversation_id: conversationId },
      body: { text: 'hi' }, context_refs: [], capabilities: [], correlation_id: null, idempotency_key: `idem_${suffix}`,
      created_at: now.toISOString(), expires_at: new Date(now.getTime() + 600_000).toISOString(),
      signature: { algorithm: 'Ed25519', key_id: ids.webKey, value: 'sig' },
    };
    return repository.persistAcceptedEnvelope({ envelope, canonical_hash: 'h', action_hash: 'h', canonical_bytes: Buffer.from('canonical'), roomSeq, roomFanout: [ids.codex, ids.claude] }, client);
  });

  const rows = await repository.listReceiptsForMessage(`msg_${suffix}`);
  assert.deepEqual(rows.map((r) => r.recipient_endpoint_id), [ids.claude, ids.codex].sort());
  assert.ok(rows.every((r) => r.state === 'queued'), 'Postgres inserts deliveries as queued');
  assert.deepEqual(await repository.listReceiptsForMessage('msg_missing'), []);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `SIGIL_TEST_DATABASE_URL=<disposable url> timeout 60 node --test sigil/relay/v1/receipts.pg.test.mjs`
Expected: FAIL with `repository.listReceiptsForMessage is not a function`. Without a database URL the test is skipped. Use the local docker Postgres (`sigil_postgres`, port 55432, database `sigil_test`, see the memory note) and confirm it is the disposable one: `assertDisposableTestDatabase` refuses a non-test database.

- [ ] **Step 7: Implement the Postgres side**

In `sigil/relay/v1/postgres-repository.mjs`, directly after the `lookupMessageSender` method (about line 248-251), add:

```js
  // Deliveries are inserted `queued` and flip to `delivered` when the
  // recipient polls (listInbox). The accept-time receipt frame reads this.
  get initialDeliveryState() { return 'queued'; }
  // One row per delivery for a message. Ordered so two reads of the same
  // message return the same order: `queued_at`, then recipient endpoint.
  async listReceiptsForMessage(messageId, client = this.pool) {
    const result = await client.query(
      'SELECT * FROM deliveries WHERE message_id = $1 ORDER BY queued_at, recipient_endpoint_id',
      [messageId]
    );
    return result.rows;
  }
```

- [ ] **Step 8: Run both tests to verify they pass**

Run: `SIGIL_TEST_DATABASE_URL=<disposable url> timeout 60 node --test sigil/relay/v1/receipts.pg.test.mjs sigil/cli/memory-repository.receipts.test.mjs`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add sigil/cli/memory-repository.mjs sigil/cli/memory-repository.receipts.test.mjs sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/receipts.pg.test.mjs
git commit -m "feat(sigil): listReceiptsForMessage and initialDeliveryState in both repositories"
```

---

### Task 3: `GET /v1/messages/{message_id}/receipts`

**Files:**
- Modify: `sigil/relay/v1/http-server.mjs` (add the route directly before the `GET /v1/inbox` branch, about line 429; add the import at the top)
- Test: `sigil/relay/v1/receipts.route.test.mjs`

**Interfaces:**
- Consumes: `toReceiptRow` from Task 1; `repository.lookupMessageSender`, `repository.listReceiptsForMessage` from Task 2.
- Produces: the route. Response `200 {request_id, code: 'OK', message_id, receipts: [{recipient_endpoint_id, state, raw_state, at}]}`. `404 MESSAGE_NOT_FOUND` for non-senders and unknown IDs. `503` when the repository lacks either method. `503 DATABASE_UNAVAILABLE` when a repository call throws.

- [ ] **Step 1: Write the failing tests**

Create `sigil/relay/v1/receipts.route.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ port, path }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    }).on('error', reject);
  });
}

async function withServer(options, fn) {
  const server = createRelayServer({ now: new Date('2026-10-06T00:00:00.000Z'), ...options });
  await new Promise((resolve) => server.listen(0, resolve));
  try { return await fn(server.address().port); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function repositoryWith(rows) {
  return {
    async lookupMessageSender(id) { return id === 'msg_1' ? { endpoint_id: 'ep_sender' } : null; },
    async listReceiptsForMessage(id) { return id === 'msg_1' ? rows : []; },
  };
}

const ROWS = [
  { recipient_endpoint_id: 'ep_a', state: 'acknowledged', queued_at: '2026-10-06T00:00:00.000Z', acknowledged_at: '2026-10-06T00:00:02.000Z' },
  { recipient_endpoint_id: 'ep_b', state: 'queued', queued_at: '2026-10-06T00:00:00.000Z' },
];

test('the original sender reads one mapped row per recipient, with the raw state', async () => {
  await withServer({ repository: repositoryWith(ROWS), authenticate: async () => ({ endpoint_id: 'ep_sender' }) }, async (port) => {
    const result = await getJson(port, '/v1/messages/msg_1/receipts');
    assert.equal(result.status, 200);
    assert.equal(result.body.message_id, 'msg_1');
    assert.deepEqual(result.body.receipts, [
      { recipient_endpoint_id: 'ep_a', state: 'read', raw_state: 'acknowledged', at: '2026-10-06T00:00:02.000Z' },
      { recipient_endpoint_id: 'ep_b', state: 'queued', raw_state: 'queued', at: '2026-10-06T00:00:00.000Z' },
    ]);
  });
});

test('a message with no deliveries returns 200 and an empty list', async () => {
  const repository = { ...repositoryWith([]) };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_sender' }) }, async (port) => {
    const result = await getJson(port, '/v1/messages/msg_1/receipts');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.receipts, []);
  });
});

test('a non-sender and an unknown message get the same 404 body', async () => {
  const strip = ({ request_id, ...rest }) => rest;
  const nonSender = await withServer({ repository: repositoryWith(ROWS), authenticate: async () => ({ endpoint_id: 'ep_recipient' }) }, (port) => getJson(port, '/v1/messages/msg_1/receipts'));
  const unknown = await withServer({ repository: repositoryWith(ROWS), authenticate: async () => ({ endpoint_id: 'ep_sender' }) }, (port) => getJson(port, '/v1/messages/msg_nope/receipts'));
  assert.equal(nonSender.status, 404);
  assert.equal(unknown.status, 404);
  assert.deepEqual(strip(nonSender.body), strip(unknown.body));
  assert.equal(nonSender.body.code, 'MESSAGE_NOT_FOUND');
});

test('a forwarded federation message (no local envelope row) returns 404 to its sender', async () => {
  // lookupMessageSender finds nothing because the origin relay never wrote an envelopes row.
  const repository = { async lookupMessageSender() { return null; }, async listReceiptsForMessage() { return ROWS; } };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_sender' }) }, async (port) => {
    assert.equal((await getJson(port, '/v1/messages/msg_fed/receipts')).status, 404);
  });
});

test('a repository without listReceiptsForMessage answers 503', async () => {
  const repository = { async lookupMessageSender() { return { endpoint_id: 'ep_sender' }; } };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_sender' }) }, async (port) => {
    assert.equal((await getJson(port, '/v1/messages/msg_1/receipts')).status, 503);
  });
});

test('a repository failure answers 503 DATABASE_UNAVAILABLE, not a stack trace', async () => {
  const repository = { async lookupMessageSender() { throw new Error('boom'); }, async listReceiptsForMessage() { return []; } };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_sender' }) }, async (port) => {
    const result = await getJson(port, '/v1/messages/msg_1/receipts');
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'DATABASE_UNAVAILABLE');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 60 node --test sigil/relay/v1/receipts.route.test.mjs`
Expected: FAIL. The route does not exist, so the first test gets a non-200 status.

- [ ] **Step 3: Implement the route**

In `sigil/relay/v1/http-server.mjs`, add to the imports near the top, after `import { transitionDelivery } from './delivery-state.mjs';`:

```js
import { toReceiptRow } from './receipt-state.mjs';
```

Directly before the line `if (request.method === 'GET' && request.url.startsWith('/v1/inbox')) {` insert:

```js
    const receiptsMatch = request.method === 'GET' ? request.url.match(/^\/v1\/messages\/([^/?]+)\/receipts$/) : null;
    if (receiptsMatch) {
      if (!repository?.listReceiptsForMessage || !repository?.lookupMessageSender) return response.writeHead(503).end();
      const messageId = decodeURIComponent(receiptsMatch[1]);
      let rows = null;
      try {
        const sender = await repository.lookupMessageSender(messageId);
        // Same answer for a non-sender and an unknown message, so message IDs
        // cannot be probed. A forwarded federation message has no local
        // envelopes row, so its sender gets this 404 too.
        if (sender?.endpoint_id === principal.endpoint_id) rows = await repository.listReceiptsForMessage(messageId);
      } catch (error) {
        logger?.error?.('receipts read failed', error);
        response.writeHead(503, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'DATABASE_UNAVAILABLE', message: 'Receipts temporarily unavailable', details: {} }));
      }
      if (!rows) {
        response.writeHead(404, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'MESSAGE_NOT_FOUND', message: 'Message not found', details: {} }));
      }
      response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(JSON.stringify({ request_id: requestId, code: 'OK', message_id: messageId, receipts: rows.map(toReceiptRow) }));
    }
```

- [ ] **Step 4: Run them to verify they pass**

Run: `timeout 60 node --test sigil/relay/v1/receipts.route.test.mjs`
Expected: PASS, 6 tests. If `principal` is `undefined` for a case, check that the route sits inside the authenticated block (after `principal` is resolved, as the `GET /v1/inbox` branch is).

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/http-server.mjs sigil/relay/v1/receipts.route.test.mjs
git commit -m "feat(sigil): sender-only GET /v1/messages/{id}/receipts route"
```

---

### Task 4: `sendReceiptFrame` and isolated post-commit frames on ack and processing

**Files:**
- Create: `sigil/relay/v1/receipt-notify.mjs`
- Test: `sigil/relay/v1/receipt-notify.test.mjs`; extend `sigil/relay/v1/receipts.route.test.mjs`
- Modify: `sigil/relay/v1/http-server.mjs` (the `ack` and `processing` branches, about lines 462-500)

**Interfaces:**
- Consumes: `mapReceiptState` (Task 1).
- Produces: `sendReceiptFrame({ stream, repository, logger }, { message_id, delivery_id, recipient_endpoint_id, state, at })`, resolves to `true` when a frame was sent, `false` otherwise, and never throws. Task 5 and Task 6 call it. The frame gains `recipient_endpoint_id` and `mapped_state` next to the existing `message_id`, `delivery_id`, `state`, `at`, `streamSeq`.

- [ ] **Step 1: Write the failing helper test**

Create `sigil/relay/v1/receipt-notify.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendReceiptFrame } from './receipt-notify.mjs';

function setup(overrides = {}) {
  const frames = [];
  const stream = { notifyReceipt: (endpointId, frame) => { frames.push({ endpointId, frame }); return true; } };
  const repository = {
    async lookupMessageSender(id) { return id === 'msg_1' ? { endpoint_id: 'ep_sender' } : null; },
    async lookupEnvelopeStreamSequence() { return 7n; },
    ...overrides,
  };
  const logged = [];
  return { frames, stream, repository, logger: { error: (...args) => logged.push(args) }, logged };
}

const INPUT = { message_id: 'msg_1', delivery_id: 'del_1', recipient_endpoint_id: 'ep_r', state: 'acknowledged', at: '2026-10-06T00:00:00.000Z' };

test('sends a frame naming the recipient with the mapped state to the sender', async () => {
  const { frames, stream, repository, logger } = setup();
  assert.equal(await sendReceiptFrame({ stream, repository, logger }, INPUT), true);
  assert.deepEqual(frames, [{ endpointId: 'ep_sender', frame: { message_id: 'msg_1', delivery_id: 'del_1', recipient_endpoint_id: 'ep_r', state: 'acknowledged', mapped_state: 'read', at: INPUT.at, streamSeq: 7n } }]);
});

test('returns false and sends nothing when the sender is unknown', async () => {
  const { frames, stream, repository, logger } = setup();
  assert.equal(await sendReceiptFrame({ stream, repository, logger }, { ...INPUT, message_id: 'msg_other' }), false);
  assert.equal(frames.length, 0);
});

test('a failing lookup is logged and never thrown', async () => {
  const { frames, stream, repository, logger, logged } = setup({ async lookupMessageSender() { throw new Error('lookup failed'); } });
  assert.equal(await sendReceiptFrame({ stream, repository, logger }, INPUT), false);
  assert.equal(frames.length, 0);
  assert.equal(logged.length, 1);
});

test('returns false without a stream or without notifyReceipt', async () => {
  const { repository, logger } = setup();
  assert.equal(await sendReceiptFrame({ stream: null, repository, logger }, INPUT), false);
  assert.equal(await sendReceiptFrame({ stream: {}, repository, logger }, INPUT), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 60 node --test sigil/relay/v1/receipt-notify.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `receipt-notify.mjs`.

- [ ] **Step 3: Implement the helper**

Create `sigil/relay/v1/receipt-notify.mjs`:

```js
import { mapReceiptState } from './receipt-state.mjs';

// Sends one `delivery.receipt` frame to the message's sender. Callers invoke it
// AFTER the state change has committed, so a frame never announces an
// uncommitted state. Never throws: a failed sender lookup after a commit
// must not turn the committed request into an error response.
export async function sendReceiptFrame({ stream, repository, logger = null }, { message_id, delivery_id, recipient_endpoint_id, state, at }) {
  if (!stream || typeof stream.notifyReceipt !== 'function' || typeof repository?.lookupMessageSender !== 'function') return false;
  try {
    const sender = await repository.lookupMessageSender(message_id);
    if (!sender) return false;
    const streamSeq = typeof repository.lookupEnvelopeStreamSequence === 'function'
      ? await repository.lookupEnvelopeStreamSequence(message_id)
      : null;
    stream.notifyReceipt(sender.endpoint_id, { message_id, delivery_id, recipient_endpoint_id, state, mapped_state: mapReceiptState(state), at, streamSeq });
    return true;
  } catch (error) {
    logger?.error?.('delivery.receipt frame failed after commit', error);
    return false;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `timeout 60 node --test sigil/relay/v1/receipt-notify.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing route tests for ack and processing**

Append to `sigil/relay/v1/receipts.route.test.mjs`:

```js
function postJson(port, path, body = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method: 'POST', path, headers: { 'content-type': 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('ack sends a frame naming the recipient and the mapped state', async () => {
  const frames = [];
  const repository = {
    async acknowledgeDelivery({ deliveryId }) { return { delivery_id: deliveryId, message_id: 'msg_1' }; },
    async lookupMessageSender() { return { endpoint_id: 'ep_sender' }; },
  };
  const stream = { notifyReceipt: (endpointId, frame) => { frames.push({ endpointId, frame }); return true; } };
  await withServer({ repository, stream, authenticate: async () => ({ endpoint_id: 'ep_recipient' }) }, async (port) => {
    assert.equal((await postJson(port, '/v1/deliveries/del_1/ack')).status, 204);
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].endpointId, 'ep_sender');
  assert.equal(frames[0].frame.recipient_endpoint_id, 'ep_recipient');
  assert.equal(frames[0].frame.state, 'acknowledged');
  assert.equal(frames[0].frame.mapped_state, 'read');
});

test('a sender lookup that throws after the ack committed still answers 204', async () => {
  let committed = 0;
  const repository = {
    async acknowledgeDelivery({ deliveryId }) { committed += 1; return { delivery_id: deliveryId, message_id: 'msg_1' }; },
    async lookupMessageSender() { throw new Error('lookup failed after commit'); },
  };
  const stream = { notifyReceipt: () => true };
  await withServer({ repository, stream, authenticate: async () => ({ endpoint_id: 'ep_recipient' }) }, async (port) => {
    assert.equal((await postJson(port, '/v1/deliveries/del_1/ack')).status, 204);
  });
  assert.equal(committed, 1);
});

test('a sender lookup that throws after a processing transition still answers 204', async () => {
  const repository = {
    async getDelivery(deliveryId, endpointId) { return { delivery_id: deliveryId, recipient_endpoint_id: endpointId, message_id: 'msg_1', state: 'acknowledged', attempts: 0 }; },
    async transitionDelivery(_id, _endpoint, _state, { next }) { return next; },
    async lookupMessageSender() { throw new Error('lookup failed after commit'); },
  };
  await withServer({ repository, stream: { notifyReceipt: () => true }, authenticate: async () => ({ endpoint_id: 'ep_recipient' }) }, async (port) => {
    assert.equal((await postJson(port, '/v1/deliveries/del_1/processing', { state: 'processing' })).status, 204);
  });
});

test('processing sends a frame with the next state mapped', async () => {
  const frames = [];
  const repository = {
    async getDelivery(deliveryId, endpointId) { return { delivery_id: deliveryId, recipient_endpoint_id: endpointId, message_id: 'msg_1', state: 'acknowledged', attempts: 0 }; },
    async transitionDelivery(_id, _endpoint, _state, { next }) { return next; },
    async lookupMessageSender() { return { endpoint_id: 'ep_sender' }; },
  };
  const stream = { notifyReceipt: (endpointId, frame) => { frames.push(frame); return true; } };
  await withServer({ repository, stream, authenticate: async () => ({ endpoint_id: 'ep_recipient' }) }, async (port) => {
    assert.equal((await postJson(port, '/v1/deliveries/del_1/processing', { state: 'processing_failed', reason: 'x' })).status, 204);
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].state, 'processing_failed');
  assert.equal(frames[0].mapped_state, 'failed');
  assert.equal(frames[0].recipient_endpoint_id, 'ep_recipient');
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `timeout 60 node --test sigil/relay/v1/receipts.route.test.mjs`
Expected: FAIL. The existing ack code lacks `recipient_endpoint_id` and `mapped_state`, and a throwing `lookupMessageSender` yields `409` instead of `204`.

- [ ] **Step 7: Refactor the ack and processing branches to use the helper**

In `sigil/relay/v1/http-server.mjs`, add the import after the `receipt-state` import:

```js
import { sendReceiptFrame } from './receipt-notify.mjs';
```

Replace the whole `if (action === 'ack' && repository?.acknowledgeDelivery) { ... }` block with:

```js
      if (action === 'ack' && repository?.acknowledgeDelivery) {
        let acked;
        try {
          acked = await repository.acknowledgeDelivery({ deliveryId, endpointId: principal.endpoint_id, now });
        } catch (error) {
          response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
          return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'DELIVERY_UNAVAILABLE', message: error.message, details: {} }));
        }
        // The ack has committed. A failed frame must not turn it into a 409,
        // so the frame goes out after the try above and sendReceiptFrame never throws.
        await sendReceiptFrame({ stream, repository, logger }, {
          message_id: acked.delivery?.message_id ?? acked.message_id,
          delivery_id: deliveryId,
          recipient_endpoint_id: principal.endpoint_id,
          state: 'acknowledged',
          at: now.toISOString(),
        });
        response.writeHead(204, { 'x-sigil-request-id': requestId });
        return response.end();
      }
```

Replace the second `try { ... }` block (the `getDelivery`/`transitionDelivery` one) with:

```js
      let next; let current;
      try {
        current = await repository.getDelivery(deliveryId, principal.endpoint_id);
        next = transitionDelivery(current, target, { now, reason: body.reason ?? null });
        await repository.transitionDelivery(deliveryId, principal.endpoint_id, target, { next });
      } catch (error) {
        response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'DELIVERY_UNAVAILABLE', message: error.message, details: {} }));
      }
      await sendReceiptFrame({ stream, repository, logger }, {
        message_id: current.message_id,
        delivery_id: deliveryId,
        recipient_endpoint_id: principal.endpoint_id,
        state: next.state,
        at: next.updated_at,
      });
      response.writeHead(204, { 'x-sigil-request-id': requestId });
      return response.end();
```

Keep the line `if (!repository?.transitionDelivery || !repository?.getDelivery) return response.writeHead(503).end();` immediately above it unchanged.

- [ ] **Step 8: Run the new and existing HTTP tests**

Run: `timeout 60 node --test sigil/relay/v1/receipts.route.test.mjs sigil/relay/v1/receipt-notify.test.mjs sigil/relay/v1/http-server.test.mjs`
Expected: PASS. The existing test `authenticated delivery route transitions acknowledged delivery to processing_failed with reason and pushes receipt` must still pass (it asserts `streamSeq`, which the helper still sends).

- [ ] **Step 9: Commit**

```bash
git add sigil/relay/v1/receipt-notify.mjs sigil/relay/v1/receipt-notify.test.mjs sigil/relay/v1/receipts.route.test.mjs sigil/relay/v1/http-server.mjs
git commit -m "feat(sigil): receipt frames name the recipient and survive post-commit lookup failure"
```

---

### Task 5: Accept-time frames: one per fan-out target, with the row's real state

**Files:**
- Modify: `sigil/relay/v1/accept-envelope.mjs:438`
- Modify: `sigil/relay/v1/room-dispatch.mjs` (every `roomDelivery`/`roomDeliveries.push` entry: lines 54, 72, about 98, 119-120)
- Modify: `sigil/relay/v1/http-server.mjs` (`createOnPersisted`, about line 56; its call at about line 416)
- Modify: `sigil/cli/sigil.mjs:399`
- Test: `sigil/relay/v1/receipt-accept-frames.test.mjs`

**Interfaces:**
- Consumes: `mapReceiptState` (Task 1); `repository.initialDeliveryState` (Task 2).
- Produces: `createOnPersisted(stream, { repository, logger })`. `persisted.deliveryState` is added by `acceptEnvelopeAsync`. Every `roomDeliveries` entry becomes `{ endpoint_id, delivery_id, message_id }`, where `message_id` is the message the delivery belongs to (the trigger message for a promoted agent, not the reply that completed the previous run).

- [ ] **Step 1: Write the failing test**

Create `sigil/relay/v1/receipt-accept-frames.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnPersisted } from './http-server.mjs';

function setup(repository = null) {
  const frames = []; const notified = [];
  const stream = {
    notify: (endpointId, deliveryId) => { notified.push({ endpointId, deliveryId }); return true; },
    notifyReceipt: (endpointId, frame) => { frames.push({ endpointId, frame }); return true; },
  };
  return { frames, notified, onPersisted: createOnPersisted(stream, { repository, logger: { error() {} } }) };
}

const ENVELOPE = { sender: { endpoint_id: 'ep_sender' }, created_at: '2026-10-06T00:00:00.000Z' };

test('a direct message sends one frame naming the recipient, with the repository state', async () => {
  const { frames, onPersisted } = setup();
  await onPersisted({ envelope: { ...ENVELOPE, recipient: { endpoint_id: 'ep_r' } }, persisted: { message_id: 'msg_1', delivery_id: 'del_1', duplicate: false, streamSeq: 3n, deliveryState: 'queued' } });
  assert.deepEqual(frames, [{ endpointId: 'ep_sender', frame: { message_id: 'msg_1', delivery_id: 'del_1', recipient_endpoint_id: 'ep_r', state: 'queued', mapped_state: 'queued', at: ENVELOPE.created_at, streamSeq: 3n } }]);
});

test('without a deliveryState the frame keeps the old delivered default', async () => {
  const { frames, onPersisted } = setup();
  await onPersisted({ envelope: { ...ENVELOPE, recipient: { endpoint_id: 'ep_r' } }, persisted: { message_id: 'msg_1', duplicate: false, streamSeq: null } });
  assert.equal(frames[0].frame.state, 'delivered');
  assert.equal(frames[0].frame.delivery_id, 'del_msg_1');
});

test('a room message sends one frame per fan-out target with a real delivery id', async () => {
  const { frames, onPersisted } = setup();
  await onPersisted({
    envelope: ENVELOPE,
    persisted: {
      message_id: 'msg_room', duplicate: false, streamSeq: null, deliveryState: 'queued',
      fanout: [{ endpoint_id: 'ep_h2', delivery_id: 'del_h2' }],
      roomDeliveries: [{ endpoint_id: 'ep_agent', delivery_id: 'del_agent', message_id: 'msg_room' }],
    },
  });
  assert.deepEqual(frames.map((f) => [f.endpointId, f.frame.delivery_id, f.frame.recipient_endpoint_id]), [
    ['ep_sender', 'del_h2', 'ep_h2'],
    ['ep_sender', 'del_agent', 'ep_agent'],
  ]);
  assert.ok(frames.every((f) => f.frame.delivery_id !== 'del_msg_room'), 'no invented delivery id');
});

test('a promoted agent delivery goes to the trigger message sender, not the reply sender', async () => {
  const repository = { async lookupMessageSender(id) { return id === 'msg_trigger' ? { endpoint_id: 'ep_human' } : null; } };
  const { frames, onPersisted } = setup(repository);
  await onPersisted({
    envelope: { sender: { endpoint_id: 'ep_agent_a' }, created_at: ENVELOPE.created_at },
    persisted: { message_id: 'msg_reply', duplicate: false, streamSeq: 9n, deliveryState: 'queued', roomDeliveries: [{ endpoint_id: 'ep_agent_b', delivery_id: 'del_promoted', message_id: 'msg_trigger' }] },
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].endpointId, 'ep_human');
  assert.equal(frames[0].frame.message_id, 'msg_trigger');
  assert.equal(frames[0].frame.recipient_endpoint_id, 'ep_agent_b');
  assert.equal(frames[0].frame.streamSeq, null, "the reply's stream sequence does not belong to the trigger message");
});

test('a duplicate accept sends no frames', async () => {
  const { frames, notified, onPersisted } = setup();
  await onPersisted({ envelope: { ...ENVELOPE, recipient: { endpoint_id: 'ep_r' } }, persisted: { message_id: 'msg_1', duplicate: true } });
  assert.equal(frames.length, 0);
  assert.equal(notified.length, 0);
});

test('recipient and fan-out notify frames are unchanged', async () => {
  const { notified, onPersisted } = setup();
  await onPersisted({ envelope: { ...ENVELOPE, recipient: { endpoint_id: 'ep_r' } }, persisted: { message_id: 'msg_1', delivery_id: 'del_1', duplicate: false, fanout: [{ endpoint_id: 'ep_h2', delivery_id: 'del_h2' }] } });
  assert.deepEqual(notified, [{ endpointId: 'ep_r', deliveryId: 'msg_1' }, { endpointId: 'ep_h2', deliveryId: 'del_h2' }]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 60 node --test sigil/relay/v1/receipt-accept-frames.test.mjs`
Expected: FAIL. `createOnPersisted` ignores the second argument and sends a single invented-ID frame.

- [ ] **Step 3: Implement `createOnPersisted`**

In `sigil/relay/v1/http-server.mjs`, replace the whole `createOnPersisted` function (from `export function createOnPersisted(stream) {` to its closing brace, about lines 56-73) with:

```js
export function createOnPersisted(stream, { repository = null, logger = null } = {}) {
  return async ({ envelope: accepted, persisted }) => {
    if (!stream || persisted?.duplicate) return;
    if (accepted.recipient?.endpoint_id) stream.notify(accepted.recipient.endpoint_id, persisted.message_id, persisted.streamSeq);
    // Room recipients get no streamSeq: they see a subset of the sender's
    // stream, so its sequence would read as gaps. room_seq is the room order.
    for (const target of [...(persisted.fanout ?? []), ...(persisted.roomDeliveries ?? [])]) stream.notify(target.endpoint_id, target.delivery_id);
    if (typeof stream.notifyReceipt !== 'function') return;
    // One frame per delivery row that exists, each naming that row's real
    // delivery id and recipient. The state is the repository's insert state
    // (queued on Postgres), never a hard-coded value.
    const state = persisted.deliveryState ?? 'delivered';
    const frame = (messageId, deliveryId, recipientEndpointId, streamSeq) => ({
      message_id: messageId, delivery_id: deliveryId, recipient_endpoint_id: recipientEndpointId,
      state, mapped_state: mapReceiptState(state), at: accepted.created_at, streamSeq,
    });
    const senderId = accepted.sender?.endpoint_id;
    if (senderId && accepted.recipient?.endpoint_id) {
      stream.notifyReceipt(senderId, frame(persisted.message_id, persisted.delivery_id ?? `del_${persisted.message_id}`, accepted.recipient.endpoint_id, persisted.streamSeq));
    }
    if (senderId) {
      for (const target of persisted.fanout ?? []) stream.notifyReceipt(senderId, frame(persisted.message_id, target.delivery_id, target.endpoint_id, null));
    }
    for (const target of persisted.roomDeliveries ?? []) {
      const messageId = target.message_id ?? persisted.message_id;
      const own = messageId === persisted.message_id;
      let receiptTo = own ? senderId : null;
      if (!own) {
        // A promoted agent's delivery belongs to an earlier trigger message,
        // so its receipt goes to that message's sender.
        try { receiptTo = (await repository?.lookupMessageSender?.(messageId))?.endpoint_id ?? null; } catch (error) { logger?.error?.('promoted delivery sender lookup failed', error); }
      }
      if (receiptTo) stream.notifyReceipt(receiptTo, frame(messageId, target.delivery_id, target.endpoint_id, own ? persisted.streamSeq : null));
    }
  };
}
```

Add `import { mapReceiptState } from './receipt-state.mjs';` by extending the existing receipt-state import to `import { mapReceiptState, toReceiptRow } from './receipt-state.mjs';`.

Update the call inside the `POST /v1/envelopes` branch: replace `onPersisted: createOnPersisted(stream),` with `onPersisted: createOnPersisted(stream, { repository, logger }),`.

In `sigil/cli/sigil.mjs` replace `onPersisted: createOnPersisted(stream),` (line 399) with `onPersisted: createOnPersisted(stream, { repository, logger: relayLogger }),`. Both names are in scope there: the surrounding `wireDataProtocol` call already passes `repository` and `logger: relayLogger`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `timeout 60 node --test sigil/relay/v1/receipt-accept-frames.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add `deliveryState` and `message_id` at the source**

In `sigil/relay/v1/accept-envelope.mjs`, replace the line at 438:

```js
    const persistedWithStreamSeq = { ...persisted, streamSeq, ...(dispatch ? { roomDeliveries: dispatch.roomDeliveries } : {}) };
```

with:

```js
    const persistedWithStreamSeq = { ...persisted, streamSeq, deliveryState: repository.initialDeliveryState ?? 'delivered', ...(dispatch ? { roomDeliveries: dispatch.roomDeliveries } : {}) };
```

In `sigil/relay/v1/room-dispatch.mjs`, add `message_id` to every delivery entry:

- Line 54, in `promoteNextInvocation`: `return { endpoint_id: endpointId, delivery_id: deliveryId };` becomes `return { endpoint_id: endpointId, delivery_id: deliveryId, message_id: next.trigger_message_id };`
- In `dispatchToTarget`, the `roomDelivery: { endpoint_id: endpointId, delivery_id: deliveryId }` entry becomes `roomDelivery: { endpoint_id: endpointId, delivery_id: deliveryId, message_id: triggerMessageId }`.
- In `applyRoomDispatch`, the router entries `routerDeliveries.push({ endpoint_id: router.endpoint_id, delivery_id: deliveryId })` and `roomDeliveries.push({ endpoint_id: router.endpoint_id, delivery_id: deliveryId })` become `{ endpoint_id: router.endpoint_id, delivery_id: deliveryId, message_id: envelope.message_id }` in both.

- [ ] **Step 6: Run the dispatch, accept, receipt, and room tests**

Run: `timeout 120 node --test sigil/relay/v1/receipt-accept-frames.test.mjs sigil/relay/v1/room-dispatch.test.mjs sigil/relay/v1/http-server.test.mjs sigil/relay/v1/http-server.rooms-stream.test.mjs sigil/cli/send-with-receipt.test.mjs`
Expected: PASS. If a test asserts an exact `roomDeliveries` object with `deepEqual`, extend its expected value with `message_id`. That is the only acceptable change to an existing assertion. Its `-> <state>` printing handles `queued` without a change (it prints every new state, and `queued` is not in `TERMINAL_RECEIPT_STATES`); if a test fails, stop and report instead of editing the file.

- [ ] **Step 7: Commit**

```bash
git add sigil/relay/v1/accept-envelope.mjs sigil/relay/v1/room-dispatch.mjs sigil/relay/v1/http-server.mjs sigil/cli/sigil.mjs sigil/relay/v1/receipt-accept-frames.test.mjs
git commit -m "feat(sigil): one accept-time receipt frame per fan-out target with the row's real state"
```

---

### Task 6: Postgres `delivered` frame when `listInbox` flips the state

**Files:**
- Modify: `sigil/relay/v1/postgres-repository.mjs` (`listInbox`, about lines 389-430)
- Modify: `sigil/relay/v1/http-server.mjs` (the `GET /v1/inbox` branch)
- Test: extend `sigil/relay/v1/receipts.pg.test.mjs` and `sigil/relay/v1/receipts.route.test.mjs`

**Interfaces:**
- Consumes: `sendReceiptFrame` (Task 4).
- Produces: `repository.listInbox(...)` items gain `flipped: boolean`, true only for rows this call moved from `queued` to `delivered`. The inbox route strips `flipped` before responding and sends one `delivered` frame per flipped row. The in-memory `listInbox` returns no `flipped` field, so it sends no extra frames.

- [ ] **Step 1: Write the failing route test**

Append to `sigil/relay/v1/receipts.route.test.mjs`:

```js
test('inbox sends one delivered frame per flipped row and strips the flag from the response', async () => {
  const frames = [];
  const repository = {
    async listInbox() {
      return [
        { delivery_id: 'del_1', message_id: 'msg_1', queued_at: '2026-10-06T00:00:00.000Z', envelope: {}, flipped: true },
        { delivery_id: 'del_2', message_id: 'msg_2', queued_at: '2026-10-06T00:00:01.000Z', envelope: {}, flipped: false },
      ];
    },
    async lookupMessageSender() { return { endpoint_id: 'ep_sender' }; },
  };
  const stream = { notifyReceipt: (endpointId, frame) => { frames.push({ endpointId, frame }); return true; } };
  await withServer({ repository, stream, authenticate: async () => ({ endpoint_id: 'ep_recipient' }) }, async (port) => {
    const result = await getJson(port, '/v1/inbox');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.items.map((item) => item.delivery_id), ['del_1', 'del_2']);
    assert.ok(result.body.items.every((item) => !('flipped' in item)), 'flipped must not reach the client');
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].endpointId, 'ep_sender');
  assert.deepEqual([frames[0].frame.delivery_id, frames[0].frame.recipient_endpoint_id, frames[0].frame.state, frames[0].frame.mapped_state], ['del_1', 'ep_recipient', 'delivered', 'delivered']);
});

test('an inbox frame failure never fails the inbox response', async () => {
  const repository = {
    async listInbox() { return [{ delivery_id: 'del_1', message_id: 'msg_1', queued_at: '2026-10-06T00:00:00.000Z', envelope: {}, flipped: true }]; },
    async lookupMessageSender() { throw new Error('lookup failed'); },
  };
  await withServer({ repository, stream: { notifyReceipt: () => true }, authenticate: async () => ({ endpoint_id: 'ep_recipient' }) }, async (port) => {
    assert.equal((await getJson(port, '/v1/inbox')).status, 200);
  });
});

test('the in-memory shape (no flipped field) sends no inbox frames', async () => {
  const frames = [];
  const repository = {
    async listInbox() { return [{ delivery_id: 'del_1', message_id: 'msg_1', queued_at: '2026-10-06T00:00:00.000Z', envelope: {} }]; },
    async lookupMessageSender() { return { endpoint_id: 'ep_sender' }; },
  };
  await withServer({ repository, stream: { notifyReceipt: (e, f) => { frames.push(f); return true; } }, authenticate: async () => ({ endpoint_id: 'ep_recipient' }) }, async (port) => {
    await getJson(port, '/v1/inbox');
  });
  assert.equal(frames.length, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `timeout 60 node --test sigil/relay/v1/receipts.route.test.mjs`
Expected: FAIL: no frame is sent and `flipped` appears in the response items.

- [ ] **Step 3: Implement the route change**

In `sigil/relay/v1/http-server.mjs`, in the `GET /v1/inbox` branch, replace:

```js
      const nextSince = items.at(-1)?.queued_at ?? since;
      response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(JSON.stringify({ request_id: requestId, code: 'OK', items, next_since: nextSince }));
```

with:

```js
      const nextSince = items.at(-1)?.queued_at ?? since;
      // `flipped` is repository bookkeeping (this call moved the row from
      // queued to delivered). It never reaches the client; it only decides
      // which rows get a `delivered` receipt frame.
      const flippedItems = items.filter((item) => item.flipped === true);
      const publicItems = items.map(({ flipped, ...item }) => item);
      response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      response.end(JSON.stringify({ request_id: requestId, code: 'OK', items: publicItems, next_since: nextSince }));
      for (const item of flippedItems) {
        await sendReceiptFrame({ stream, repository, logger }, {
          message_id: item.message_id,
          delivery_id: item.delivery_id,
          recipient_endpoint_id: principal.endpoint_id,
          state: 'delivered',
          at: now.toISOString(),
        });
      }
      return;
```

(`now` is the request clock already in scope in this handler, as used by the ack branch. Sending after `response.end` keeps a slow lookup off the poll's latency.)

- [ ] **Step 4: Run it to verify it passes**

Run: `timeout 60 node --test sigil/relay/v1/receipts.route.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write the failing Postgres flip test**

Append to `sigil/relay/v1/receipts.pg.test.mjs`. It reuses the seeding from Task 2's test, so extract that seeding into a helper first: move the room, member, and `persistAcceptedEnvelope` setup of the Task 2 test into `async function seedRoomMessage(pool, repository, suffix)`, returning `{ ids, messageId }`, and call it from both tests. Then add:

```js
test('postgres listInbox flags rows it flipped from queued to delivered, once', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const repository = new PostgresRepository({ pool });
  const { ids, messageId } = await seedRoomMessage(pool, repository, suffix);

  const first = await repository.listInbox(ids.claude);
  assert.equal(first.length, 1);
  assert.equal(first[0].flipped, true, 'first poll moves queued to delivered');
  const [row] = await repository.listReceiptsForMessage(messageId).then((rows) => rows.filter((r) => r.recipient_endpoint_id === ids.claude));
  assert.equal(row.state, 'delivered');
  assert.ok(row.delivered_at, 'the flip stamps delivered_at');

  const second = await repository.listInbox(ids.claude);
  assert.equal(second.length, 1);
  assert.equal(second[0].flipped, false, 'a row that is already delivered is not flagged again');
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `SIGIL_TEST_DATABASE_URL=<disposable url> timeout 60 node --test sigil/relay/v1/receipts.pg.test.mjs`
Expected: FAIL: `first[0].flipped` is `undefined`.

- [ ] **Step 7: Implement the flag in `listInbox`**

In `sigil/relay/v1/postgres-repository.mjs`, in `listInbox`:

Change the `advanced` CTE so it returns the flipped IDs:

```sql
       advanced AS (
         UPDATE deliveries SET state = 'delivered', delivered_at = NOW(), updated_at = NOW()
         WHERE delivery_id IN (SELECT delivery_id FROM candidate) AND state = 'queued'
         RETURNING delivery_id
       )
```

Add one column to the final `SELECT`, directly after `(ea.acknowledged_endpoint_id IS NULL) AS sender_unverified`:

```sql
              (ea.acknowledged_endpoint_id IS NULL) AS sender_unverified,
              (c.delivery_id IN (SELECT delivery_id FROM advanced)) AS flipped
```

In the `result.rows.map((row) => ({ ... }))` below, add this line directly after `delivery_id: row.delivery_id,`:

```js
      flipped: row.flipped === true,
```

The existing comment in `listInbox` says the final SELECT never re-reads `deliveries`. This change keeps that rule: it reads only the CTE's `RETURNING` output, not the table.

- [ ] **Step 8: Run the flip test and the existing inbox tests**

Run: `SIGIL_TEST_DATABASE_URL=<disposable url> timeout 120 node --test sigil/relay/v1/receipts.pg.test.mjs sigil/relay/v1/rooms.pg.test.mjs sigil/relay/v1/http-server.test.mjs`
Expected: PASS. Any existing test that `deepEqual`s a Postgres `listInbox` item must add `flipped`. That is the only acceptable assertion change.

- [ ] **Step 9: Commit**

```bash
git add sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/http-server.mjs sigil/relay/v1/receipts.pg.test.mjs sigil/relay/v1/receipts.route.test.mjs
git commit -m "feat(sigil): send a delivered receipt frame when listInbox flips queued to delivered"
```

---

### Task 7: Contract, changelog, full verification

**Files:**
- Modify: `sigil/contracts/v1/relay-api.json`
- Modify: `CHANGELOG.md`
- Test: whole suite

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Add the route to the contract**

In `sigil/contracts/v1/relay-api.json`, add this entry to `routes` directly after the `GET /v1/inbox` entry:

```json
    {"method":"GET","path":"/v1/messages/{message_id}/receipts","success":200,"errors":["UNAUTHENTICATED","MESSAGE_NOT_FOUND","DATABASE_UNAVAILABLE"],"item_fields":["recipient_endpoint_id","state","raw_state","at"],"notes":"Sender-only. A caller that is not the original sender endpoint, an unknown message_id, and a forwarded federation message all get the same 404 MESSAGE_NOT_FOUND. Rows are ordered by queued_at then recipient_endpoint_id. state is one of queued, delivered, read, processed, failed; raw_state is the deliveries.state value. read means the recipient's client acked, not that a person or model read the message. failed can be current-state, because processing_failed may retry. A room message lists the delivery rows that exist when called; agents the router queued but has not promoted get a row when promoted. 503 when the repository cannot list receipts."},
```

Also extend the `GET /v1/inbox` entry by adding a `"notes"` field: `"notes":"The first poll that returns a queued delivery moves it to delivered and sends the message's sender a delivery.receipt frame with state delivered."`

The file has no section for WebSocket frames, so describe the frame in the receipts route's `notes` by appending: ` The delivery.receipt frame (WebSocket /v1/stream) carries message_id, delivery_id, recipient_endpoint_id, state, mapped_state, at, and stream_seq. It is a hint; a missed frame is repaired by this route.`

- [ ] **Step 2: Validate the JSON and add the changelog entry**

Run: `node -e "JSON.parse(require('fs').readFileSync('sigil/contracts/v1/relay-api.json','utf8')); console.log('ok')"`
Expected: `ok`.

In `CHANGELOG.md`, under the top unreleased heading (create `## Unreleased` above the newest version if none exists), add:

```markdown
- Added `GET /v1/messages/{message_id}/receipts`, a sender-only read of every recipient's receipt state, so a sender can find out after disconnecting.
- `delivery.receipt` frames now carry `recipient_endpoint_id` and `mapped_state`. A room message sends one frame per recipient with that recipient's real delivery ID.
- On Postgres the accept-time frame now says `queued` and a `delivered` frame follows when the recipient polls. The frame previously said `delivered` immediately.
```

- [ ] **Step 3: Run the complete suite with a hard timeout**

Run: `cd C:\dev\.worktrees\sigil-receipts-p1 && SIGIL_TEST_DATABASE_URL=<disposable url> timeout 300 npm test > /c/Users/soren/AppData/Local/Temp/claude/receipts-p1-full.log 2>&1; echo exit=$?; grep -E "^ℹ (tests|pass|fail|skipped)" /c/Users/soren/AppData/Local/Temp/claude/receipts-p1-full.log`
Expected: `exit=0`, `ℹ fail 0`. Read the exit code from `echo`, never from a piped command. If the suite exceeds 60 seconds without output, treat it as hung: stop, find the hanging test file, and report it.

- [ ] **Step 4: Search for callers that depend on the old behavior**

Run: `grep -rn "state: 'delivered'" sigil --include=*.mjs | grep -v test`
Expected: only `delivery-state.mjs`, the repositories, and the `'delivered'` literals in `listInbox`/`sendReceiptFrame` callers. Any other consumer that assumes the accept-time receipt is `delivered` on Postgres must be listed in the PR description for review, not silently changed.

- [ ] **Step 5: Commit and push**

```bash
git add sigil/contracts/v1/relay-api.json CHANGELOG.md
git commit -m "docs(sigil): receipts route and frame fields in the relay contract"
timeout 400 git push -u origin plan/sigil-receipts-part1 > /c/Users/soren/AppData/Local/Temp/claude/push-receipts-p1.log 2>&1; echo exit=$?
```

Expected: `exit=0` and the pre-push hook reports `Pre-push verification passed`. Open the PR only when asked.

---

## Self-review

**Spec coverage (Part 1):**
- Route, sender-only, uniform 404, federation 404, 503 without a method, empty list: Task 3. Row order and `at` fallback: Tasks 1 and 2. `listReceiptsForMessage` in both repositories: Task 2.
- Frame gains `recipient_endpoint_id` and `mapped_state`: Tasks 4 and 5. One frame per fan-out target with a real `delivery_id`, including promoted agents: Task 5. Postgres `queued` at accept and `delivered` on the `listInbox` flip: Tasks 5 and 6.
- Ack and processing frames isolated so a failed lookup after commit is not a `409`: Task 4. The 4a `room.updated` frame in the ack route is a 4a item, not built here.
- In-memory repository left as is, as the spec allows: Global Constraints and Task 2.
- Contract and docs: Task 7.
- Not in this plan by design: Part 2 (wait semantics, exit codes, multi-socket), Part 3 (`inbox --until`), and every 4a item.

**Deviation to flag in the PR:** the Postgres accept-time frame state changes from `delivered` to `queued`. A client that treats the first `delivered` frame as "recipient picked it up" sees different timing. `send-with-receipt.mjs` prints each new state, so `queued` then `delivered` appear as two lines. Task 5 Step 6 checks its tests.

**Type consistency:** `sendReceiptFrame({ stream, repository, logger }, { message_id, delivery_id, recipient_endpoint_id, state, at })` is defined in Task 4 and called with those exact keys in Tasks 4 and 6. `toReceiptRow` and `mapReceiptState` are defined in Task 1 and imported in Tasks 3 and 5. `deliveryState` is produced in Task 5 Step 5 and consumed in Step 3. `flipped` is produced in Task 6 Step 7 and consumed in Step 3.
