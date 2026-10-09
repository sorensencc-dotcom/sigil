# Sigil rooms phase 4b-2 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add room rename and agent response-mode editing to the relay, and threads, Stop, a roster panel, and inline rename to the web client.

**Architecture:** Tasks 1-3 add two relay routes (`rename`, `response-mode`), two repository methods in both repositories, and a third `room.updated` `changed` value, `room`. Tasks 4-9 build the client on the 4b-1 structure: pure thread helpers first, then pending-state threading, then the panel, header, roster, and rename components, then end-to-end coverage.

**Tech Stack:** Node `.mjs` with `node:test` (relay), TypeScript, React 19, TanStack Query 5, Vitest and Testing Library, Playwright (web package).

**Spec:** `docs/superpowers/specs/2026-10-08-sigil-rooms-phase-4b2-threads-stop-roster-rename-design.md`

## Global Constraints

- Branch off `origin/main`. Do not switch branches in `C:\dev\sigil-repo`; work in a worktree (the spec worktree is `C:\dev\.worktrees\sigil-4b2-spec`).
- Run every test command under `timeout` (60 seconds for one file, 300 for the full web suite). A suite silent for 60 seconds is hung: abort and report the file.
- Never run two long test runs at once. The pre-push hook runs the full core suite and takes several minutes; run `git push` in the background and wait for it.
- A fresh worktree needs `npm ci --ignore-scripts` at the root and again in `packages/sigil-rooms-web/` before any test runs.
- Root `npm run test:web` can fail with `EALLOWSCRIPTS` because of the user's `~/.npmrc`. Run the steps inside `packages/sigil-rooms-web/` instead.
- The web package stays outside the root workspace. Do not add `workspaces` to the root `package.json`.
- Web test files are `*.spec.ts` and `*.spec.tsx` under `src/`. No `test/` or `tests/` directory in the package.
- Message text renders as plain text only. No `dangerouslySetInnerHTML`, no markdown, no links.
- Relay error bodies are `{request_id, code, message, details?}`. Use the existing `fail()` helper in `room-routes.mjs`.
- Room names are 1 to `NAME_MAX` (80) characters after trimming.
- `response_mode` values: `joins`, `mentions_only`, `router`.
- Manager roles: `owner` and `room_manager`. Agent callers are refused on both new routes.
- `room.updated` `changed` values become `messages`, `members`, `room`. `room_seq` is absent for `members` and `room`.
- Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Use `test:` for commits that mainly add tests.
- Files are LF. Before using an edit tool on a file, run `file <path>`; if it reports CRLF, edit with a script that preserves line endings (open with `newline=''`).
- Docs and PR text follow the repo's technical-writing rules: sentence case headings, no first-person plural, active voice.

---

## File structure

Relay (repo root):

- Modify `sigil/relay/v1/postgres-repository.mjs`: `renameRoom`, `setRoomMemberResponseMode` after `removeRoomMember`.
- Modify `sigil/cli/memory-repository.mjs`: the same two methods after `removeRoomMember`.
- Modify `sigil/relay/v1/room-routes.mjs`: `ROOM_METHODS`, the path regex, two handlers.
- Modify `sigil/contracts/v1/relay-api.json`: two routes, the `room` frame value.
- Modify `sigil/contracts/v1/relay-api.test.mjs`: contract assertions.
- Create `sigil/cli/memory-repository.rooms-manage.test.mjs`, `sigil/relay/v1/rooms-manage.pg.test.mjs`, `sigil/relay/v1/room-routes.manage.test.mjs`.

Web (`packages/sigil-rooms-web/src/`):

- Modify `api/types.ts`, `api/client.ts`, `api/client.spec.ts`, `api/contract.spec.ts`, `live/useLive.ts`, `live/useLive.spec.tsx`, `errors/ErrorBanner.tsx`.
- Create `rooms/threads.ts` and `rooms/threads.spec.ts`: pure helpers (`rowsById`, `threadRootOf`, `isTopLevel`, `replyCounts`, `threadReplies`, `ackWatermark`).
- Modify `rooms/mergeRows.ts`, `rooms/useSend.ts`; create `rooms/useSend.spec.tsx`.
- Create `rooms/RowView.tsx` (extracted from `Timeline.tsx`), `rooms/ThreadPanel.tsx`, `rooms/ThreadPanel.spec.tsx`; modify `rooms/Timeline.tsx`, `rooms/Timeline.spec.tsx`, `rooms/Composer.tsx`, `App.tsx`, `styles.css`.
- Create `rooms/useMembers.ts`, `rooms/roles.ts`, `rooms/RoomHeader.tsx`, `rooms/RenameTitle.tsx`, `rooms/RosterPanel.tsx` and a `.spec.tsx` for each of the three components.
- Modify `../e2e/relayHarness.ts`, `../e2e/rooms.e2e.ts`, `../README.md`.

---

### Task 1: Repository methods

**Files:**
- Modify: `sigil/cli/memory-repository.mjs` (after `removeRoomMember`, near line 319)
- Modify: `sigil/relay/v1/postgres-repository.mjs` (after `removeRoomMember`, near line 1743)
- Create: `sigil/cli/memory-repository.rooms-manage.test.mjs`
- Create: `sigil/relay/v1/rooms-manage.pg.test.mjs`

**Interfaces:**
- Produces: `repository.renameRoom({conversationId, name}) -> Promise<room>`. Rejects with `{code: 'ROOM_NAME_TAKEN'}` when another room in the same workspace has the name, and `{code: 'ROOM_NOT_FOUND'}` for an unknown room. Returns the same room shape as `createRoom` (`conversation_id, workspace_id, name, description, created_at, max_agent_turns`).
- Produces: `repository.setRoomMemberResponseMode({conversationId, endpointId, responseMode}) -> Promise<member|null>`. Returns `{endpoint_id, role, response_mode, added_at}`, or `null` when the endpoint is not an active member.

- [ ] **Step 1: Install root dependencies if the worktree has no `node_modules`**

Run: `cd C:\dev\.worktrees\sigil-4b2-spec && timeout 300 npm ci --ignore-scripts`
Expected: `found 0 vulnerabilities`.

- [ ] **Step 2: Write the failing memory-repository test**

Create `sigil/cli/memory-repository.rooms-manage.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

const base = { workspaceId: 'ws_a', createdByHumanId: 'usr_a', ownerEndpointId: 'ep_owner' };

function setup() {
  return createMemoryRepository({ registry: new Map() });
}

test('renameRoom changes the name and returns the visible room shape', async () => {
  const repository = setup();
  await repository.createRoom({ conversationId: 'room_1', name: 'old', ...base });
  const room = await repository.renameRoom({ conversationId: 'room_1', name: 'new' });
  assert.equal(room.conversation_id, 'room_1');
  assert.equal(room.name, 'new');
  assert.equal('next_room_seq' in room, false);
  assert.equal((await repository.lookupRoom('room_1')).name, 'new');
});

test('renameRoom rejects a name another room in the workspace holds, and leaves the name unchanged', async () => {
  const repository = setup();
  await repository.createRoom({ conversationId: 'room_1', name: 'one', ...base });
  await repository.createRoom({ conversationId: 'room_2', name: 'taken', ...base });
  await assert.rejects(repository.renameRoom({ conversationId: 'room_1', name: 'taken' }), { code: 'ROOM_NAME_TAKEN' });
  assert.equal((await repository.lookupRoom('room_1')).name, 'one');
});

test('renameRoom allows the same name in a different workspace and the room\'s own name', async () => {
  const repository = setup();
  await repository.createRoom({ conversationId: 'room_1', name: 'one', ...base });
  await repository.createRoom({ conversationId: 'room_2', name: 'shared', ...base, workspaceId: 'ws_b' });
  assert.equal((await repository.renameRoom({ conversationId: 'room_1', name: 'shared' })).name, 'shared');
  assert.equal((await repository.renameRoom({ conversationId: 'room_1', name: 'shared' })).name, 'shared');
});

test('renameRoom rejects an unknown room', async () => {
  await assert.rejects(setup().renameRoom({ conversationId: 'room_missing', name: 'x' }), { code: 'ROOM_NOT_FOUND' });
});

test('setRoomMemberResponseMode updates an active member and returns null otherwise', async () => {
  const repository = setup();
  await repository.createRoom({ conversationId: 'room_1', name: 'one', ...base });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_a' });
  const member = await repository.setRoomMemberResponseMode({ conversationId: 'room_1', endpointId: 'ep_claude', responseMode: 'mentions_only' });
  assert.deepEqual({ ...member, added_at: undefined }, { endpoint_id: 'ep_claude', role: 'member', response_mode: 'mentions_only', added_at: undefined });
  assert.equal((await repository.lookupRoomMember('room_1', 'ep_claude')).response_mode, 'mentions_only');
  assert.equal(await repository.setRoomMemberResponseMode({ conversationId: 'room_1', endpointId: 'ep_missing', responseMode: 'joins' }), null);
  await repository.removeRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude' });
  assert.equal(await repository.setRoomMemberResponseMode({ conversationId: 'room_1', endpointId: 'ep_claude', responseMode: 'joins' }), null);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd C:\dev\.worktrees\sigil-4b2-spec && timeout 60 node --test sigil/cli/memory-repository.rooms-manage.test.mjs`
Expected: FAIL with `repository.renameRoom is not a function`.

- [ ] **Step 4: Implement the memory methods**

In `sigil/cli/memory-repository.mjs`, insert after the `removeRoomMember` method (which ends with `return true; },`):

```js
    async renameRoom({ conversationId, name }) {
      const room = rooms.get(conversationId);
      if (!room) throw Object.assign(new Error('Room not found'), { code: 'ROOM_NOT_FOUND' });
      if ([...rooms.values()].some((other) => other.conversation_id !== conversationId && other.workspace_id === room.workspace_id && other.name === name)) {
        throw Object.assign(new Error('A room with this name already exists in the workspace'), { code: 'ROOM_NAME_TAKEN' });
      }
      room.name = name;
      const { next_room_seq: _seq, archived_at: _archived, ...visible } = room;
      return visible;
    },
    async setRoomMemberResponseMode({ conversationId, endpointId, responseMode }) {
      const member = roomMembers.get(conversationId)?.get(endpointId);
      if (!member || member.removed_at !== null) return null;
      member.response_mode = responseMode;
      return { endpoint_id: member.endpoint_id, role: member.role, response_mode: member.response_mode, added_at: member.added_at };
    },
```

- [ ] **Step 5: Run the memory test to verify it passes**

Run: `timeout 60 node --test sigil/cli/memory-repository.rooms-manage.test.mjs`
Expected: 5 tests PASS.

- [ ] **Step 6: Implement the Postgres methods**

In `sigil/relay/v1/postgres-repository.mjs`, insert after `removeRoomMember` (which ends with `return result.rowCount > 0;\n  }`):

```js
  async renameRoom({ conversationId, name }, client = this.pool) {
    try {
      const result = await client.query(
        `UPDATE rooms SET name = $2 WHERE conversation_id = $1
         RETURNING conversation_id, workspace_id, name, description, created_at, max_agent_turns`,
        [conversationId, name],
      );
      if (!result.rows[0]) throw Object.assign(new Error('Room not found'), { code: 'ROOM_NOT_FOUND' });
      return roomRow(result.rows[0]);
    } catch (error) {
      if (error.code === '23505' && error.constraint === 'rooms_workspace_id_name_key') {
        throw Object.assign(new Error('A room with this name already exists in the workspace'), { code: 'ROOM_NAME_TAKEN' });
      }
      throw error;
    }
  }
  async setRoomMemberResponseMode({ conversationId, endpointId, responseMode }, client = this.pool) {
    const result = await client.query(
      `UPDATE conversation_members SET response_mode = $3
        WHERE conversation_id = $1 AND endpoint_id = $2 AND removed_at IS NULL
       RETURNING endpoint_id, role, response_mode, added_at`,
      [conversationId, endpointId, responseMode],
    );
    return result.rows[0] ? memberRow(result.rows[0]) : null;
  }
```

- [ ] **Step 7: Write the Postgres test**

Create `sigil/relay/v1/rooms-manage.pg.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function seed(pool, suffix) {
  const ids = { human: `usr_manage_${suffix}`, web: `ep_web_${suffix}`, claude: `ep_claude_${suffix}` };
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [ids.human]);
  for (const [endpointId, runtime] of [[ids.web, 'web'], [ids.claude, 'claude']]) {
    await pool.query(
      `INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
       VALUES ($1, $2, $3, $4, $3, 'active', NOW())`,
      [endpointId, ids.human, runtime, `install_${endpointId}`],
    );
  }
  return ids;
}

test('postgres rename and response-mode updates', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = await seed(pool, suffix);
  const repository = new PostgresRepository({ pool });
  const now = new Date();
  const workspaceId = `ws_${ids.human}`;
  const one = `room1_${suffix}`;
  const two = `room2_${suffix}`;
  await repository.createRoom({ conversationId: one, workspaceId, name: `one_${suffix}`, createdByHumanId: ids.human, ownerEndpointId: ids.web, now });
  await repository.createRoom({ conversationId: two, workspaceId, name: `two_${suffix}`, createdByHumanId: ids.human, ownerEndpointId: ids.web, now });

  const renamed = await repository.renameRoom({ conversationId: one, name: `renamed_${suffix}` });
  assert.equal(renamed.name, `renamed_${suffix}`);
  assert.equal((await repository.lookupRoom(one)).name, `renamed_${suffix}`);
  await assert.rejects(repository.renameRoom({ conversationId: one, name: `two_${suffix}` }), { code: 'ROOM_NAME_TAKEN' });
  assert.equal((await repository.lookupRoom(one)).name, `renamed_${suffix}`);
  assert.equal((await repository.renameRoom({ conversationId: one, name: `renamed_${suffix}` })).name, `renamed_${suffix}`);
  await assert.rejects(repository.renameRoom({ conversationId: `room_missing_${suffix}`, name: 'x' }), { code: 'ROOM_NOT_FOUND' });

  await repository.addRoomMember({ conversationId: one, endpointId: ids.claude, role: 'member', responseMode: 'joins', addedByHumanId: ids.human, now });
  const member = await repository.setRoomMemberResponseMode({ conversationId: one, endpointId: ids.claude, responseMode: 'router' });
  assert.equal(member.response_mode, 'router');
  assert.equal((await repository.lookupRoomMember(one, ids.claude)).response_mode, 'router');
  assert.equal(await repository.setRoomMemberResponseMode({ conversationId: one, endpointId: `ep_missing_${suffix}`, responseMode: 'joins' }), null);
  await repository.removeRoomMember({ conversationId: one, endpointId: ids.claude, now });
  assert.equal(await repository.setRoomMemberResponseMode({ conversationId: one, endpointId: ids.claude, responseMode: 'joins' }), null);
});
```

- [ ] **Step 8: Run the Postgres test**

Without a database the test is skipped: `timeout 60 node --test sigil/relay/v1/rooms-manage.pg.test.mjs` prints `skipped`. With the local disposable database (docker `sigil_postgres` on `localhost:55432`), run:
`SIGIL_TEST_DATABASE_URL=postgres://sigil:sigil_password@localhost:55432/sigil_test timeout 120 node --test sigil/relay/v1/rooms-manage.pg.test.mjs`
Expected: PASS. If the database is not available, report the test as unrun; do not mark it passed.

- [ ] **Step 9: Commit**

```bash
git add sigil/cli/memory-repository.mjs sigil/relay/v1/postgres-repository.mjs sigil/cli/memory-repository.rooms-manage.test.mjs sigil/relay/v1/rooms-manage.pg.test.mjs
git commit -m "feat(relay): add renameRoom and setRoomMemberResponseMode repository methods

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Rename route, `room` frame, and contract

**Files:**
- Modify: `sigil/relay/v1/room-routes.mjs` (lines 16, 94-98, and a new handler after the member-remove handler)
- Modify: `sigil/contracts/v1/relay-api.json` (new route line after the `/stop` route; the `room.updated` frame line)
- Modify: `sigil/contracts/v1/relay-api.test.mjs`
- Create: `sigil/relay/v1/room-routes.manage.test.mjs`

**Interfaces:**
- Consumes: `repository.renameRoom` from Task 1.
- Produces: `POST /v1/rooms/{room_id}/rename` with body `{name}`; `200 {code:'OK', room}`; errors `HUMAN_CONTEXT_REQUIRED` (403), `ROUTE_NOT_AUTHORIZED` (403), `INVALID_REQUEST` (400), `ROOM_NAME_TAKEN` (409), `ROOM_NOT_FOUND` (404). Sends `room.updated` `{room_id, changed: 'room'}` to human members after a successful change.

- [ ] **Step 1: Write the failing route tests**

Create `sigil/relay/v1/room-routes.manage.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

const principals = {
  'Bearer web': { endpoint_id: 'ep_web', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer alice': { endpoint_id: 'ep_alice', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer mgr': { endpoint_id: 'ep_mgr', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer claude': { endpoint_id: 'ep_claude', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer stranger': { endpoint_id: 'ep_stranger', owner_id: 'usr_other', human_id: 'usr_other' },
};
const registry = new Map([
  ['ep_web', { owner_id: 'usr_chris', status: 'active', kind: 'human' }],
  ['ep_alice', { owner_id: 'usr_chris', status: 'active', kind: 'human' }],
  ['ep_mgr', { owner_id: 'usr_chris', status: 'active', kind: 'human' }],
  ['ep_claude', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
  ['ep_codex', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
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

// A room named "build" owned by ep_web, with ep_alice (member), ep_mgr (room_manager), and ep_claude (agent, joins).
async function withRoom(fn) {
  const frames = [];
  const stream = { notifyRoom: (endpointId, frame) => { frames.push([endpointId, frame]); return true; } };
  const repository = createMemoryRepository({ registry });
  const server = createRelayServer({ registry, repository, stream, authenticate: async (request) => principals[request.headers.authorization] ?? null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer web', { name: 'build' })).body.room.conversation_id;
    await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer web', { endpoint_id: 'ep_alice', role: 'member' });
    await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer web', { endpoint_id: 'ep_mgr', role: 'room_manager' });
    await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer web', { endpoint_id: 'ep_claude', response_mode: 'joins' });
    frames.length = 0;
    await fn({ port, roomId, frames, repository });
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('rename: the owner renames, the list reflects it, and humans get one room frame', async () => {
  await withRoom(async ({ port, roomId, frames }) => {
    const renamed = await call(port, 'POST', `/v1/rooms/${roomId}/rename`, 'Bearer web', { name: '  shipping  ' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.room.name, 'shipping');
    assert.equal((await call(port, 'GET', '/v1/rooms', 'Bearer web')).body.items[0].name, 'shipping');
    assert.deepEqual(frames.map(([id]) => id).sort(), ['ep_alice', 'ep_mgr', 'ep_web']);
    assert.deepEqual(frames[0][1], { room_id: roomId, changed: 'room' });
  });
});

test('rename: a room_manager can rename; a plain member cannot', async () => {
  await withRoom(async ({ port, roomId }) => {
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/rename`, 'Bearer mgr', { name: 'by-manager' })).status, 200);
    const refused = await call(port, 'POST', `/v1/rooms/${roomId}/rename`, 'Bearer alice', { name: 'by-member' });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'ROUTE_NOT_AUTHORIZED');
    assert.equal((await call(port, 'GET', '/v1/rooms', 'Bearer web')).body.items[0].name, 'by-manager');
  });
});

test('rename: renaming to the current name answers 200 and sends no frame', async () => {
  await withRoom(async ({ port, roomId, frames }) => {
    const same = await call(port, 'POST', `/v1/rooms/${roomId}/rename`, 'Bearer web', { name: 'build' });
    assert.equal(same.status, 200);
    assert.equal(same.body.room.name, 'build');
    assert.deepEqual(frames, []);
  });
});

test('rename: a name another room holds answers 409 and sends no frame', async () => {
  await withRoom(async ({ port, roomId, frames }) => {
    await call(port, 'POST', '/v1/rooms', 'Bearer web', { name: 'ops' });
    const clash = await call(port, 'POST', `/v1/rooms/${roomId}/rename`, 'Bearer web', { name: 'ops' });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.code, 'ROOM_NAME_TAKEN');
    assert.deepEqual(frames, []);
  });
});

test('rename: non-members get 404, agent callers 403, and bad names 400', async () => {
  await withRoom(async ({ port, roomId }) => {
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/rename`, 'Bearer stranger', { name: 'x' })).status, 404);
    const agent = await call(port, 'POST', `/v1/rooms/${roomId}/rename`, 'Bearer claude', { name: 'x' });
    assert.equal(agent.status, 403);
    assert.equal(agent.body.code, 'HUMAN_CONTEXT_REQUIRED');
    for (const name of ['', '   ', 'x'.repeat(81), 7, undefined]) {
      const bad = await call(port, 'POST', `/v1/rooms/${roomId}/rename`, 'Bearer web', { name });
      assert.equal(bad.status, 400, `name ${JSON.stringify(name)}`);
      assert.equal(bad.body.code, 'INVALID_REQUEST');
    }
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/rename`, 'Bearer web', { name: 'x'.repeat(80) })).status, 200);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `timeout 60 node --test sigil/relay/v1/room-routes.manage.test.mjs`
Expected: FAIL. The rename path does not match the route regex, so the first assertion sees a non-200 status.

- [ ] **Step 3: Add the new methods to `ROOM_METHODS`**

In `sigil/relay/v1/room-routes.mjs` line 16, append `'renameRoom', 'setRoomMemberResponseMode'` before the closing bracket:

```js
const ROOM_METHODS = ['createRoom', 'lookupRoom', 'listRoomsForEndpoint', 'addRoomMember', 'removeRoomMember', 'lookupRoomMember', 'listRoomMembers', 'listRoomMessages', 'listRoomInvocations', 'lookupRunningInvocation', 'finishInvocation', 'cancelRoomInvocations', 'nextQueuedInvocation', 'startInvocation', 'createRoomDelivery', 'lookupRouterDecision', 'lookupRoomMessage', 'lookupRoomEventByKey', 'lockRoom', 'createRoomInvocation', 'reserveAgentTurn', 'withTransaction', 'acknowledgeRoomDeliveries', 'renameRoom', 'setRoomMemberResponseMode'];
```

- [ ] **Step 4: Widen the path regex**

Replace the `const match = path.match(...)` line (line 94) with:

```js
  const match = path.match(/^\/v1\/rooms\/([^/]+)\/(members|messages|invocations|stop|ack|rename)(?:\/([^/]+)(?:\/(remove|response-mode))?)?$/);
```

- [ ] **Step 5: Add the rename handler**

Insert directly after the member-remove handler (the block ending `return send(response, requestId, 200, { code: 'OK', removed: true });\n  }`):

```js
  if (request.method === 'POST' && resource === 'rename' && !segment) {
    if (isAgentCaller(registry, principal) || !principal?.human_id) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'An authenticated human context is required');
    if (!MANAGER_ROLES.has(access.member.role)) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'Only room managers can rename the room');
    const body = await readJson(request, readBody);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > NAME_MAX) return fail(response, requestId, 400, 'INVALID_REQUEST', `name must be 1-${NAME_MAX} characters`);
    if (name === access.room.name) return send(response, requestId, 200, { code: 'OK', room: access.room });
    try {
      const room = await repository.renameRoom({ conversationId: roomId, name });
      await notifyRoomHumans({ repository, stream, registered: registry, client: null, roomId, changed: 'room', logger: logger ?? console });
      return send(response, requestId, 200, { code: 'OK', room });
    } catch (error) {
      if (error.code === 'ROOM_NAME_TAKEN') return fail(response, requestId, 409, 'ROOM_NAME_TAKEN', error.message);
      if (error.code === 'ROOM_NOT_FOUND') return fail(response, requestId, 404, 'ROOM_NOT_FOUND', 'Room not found');
      throw error;
    }
  }
```

- [ ] **Step 6: Run to verify it passes**

Run: `timeout 60 node --test sigil/relay/v1/room-routes.manage.test.mjs`
Expected: 5 tests PASS.

- [ ] **Step 7: Add the contract entries and a failing contract test**

Append to `sigil/contracts/v1/relay-api.test.mjs`:

```js
test('relay API lists the rename route and the room frame value', () => {
  const route = api.routes.find((item) => item.path === '/v1/rooms/{room_id}/rename');
  assert.equal(route.method, 'POST');
  assert.equal(route.success, 200);
  assert.deepEqual(route.request_fields, ['name']);
  assert.deepEqual(route.response_fields, ['code', 'room']);
  for (const code of ['HUMAN_CONTEXT_REQUIRED', 'ROUTE_NOT_AUTHORIZED', 'INVALID_REQUEST', 'ROOM_NAME_TAKEN', 'ROOM_NOT_FOUND']) assert.ok(route.errors.includes(code), code);
  const frame = api.stream_frames.find((item) => item.type === 'room.updated');
  assert.deepEqual(frame.changed_values, ['messages', 'members', 'room']);
});
```

Run: `timeout 60 node --test sigil/contracts/v1/relay-api.test.mjs`
Expected: FAIL (`route` is undefined).

- [ ] **Step 8: Edit `relay-api.json`**

Insert this line after the `/v1/rooms/{room_id}/stop` route line (keep the trailing comma pattern of the neighbours):

```json
    {"method":"POST","path":"/v1/rooms/{room_id}/rename","success":200,"errors":["UNAUTHENTICATED","HUMAN_CONTEXT_REQUIRED","ROUTE_NOT_AUTHORIZED","INVALID_REQUEST","ROOM_NAME_TAKEN","ROOM_NOT_FOUND","DATABASE_UNAVAILABLE"],"request_fields":["name"],"response_fields":["code","room"],"notes":"Room owners and room managers only; agent callers get 403 HUMAN_CONTEXT_REQUIRED and plain members 403 ROUTE_NOT_AUTHORIZED. name is trimmed and must be 1-80 characters. 409 ROOM_NAME_TAKEN when another room in the workspace has the name. Renaming to the current name answers 200 and sends no frame. Sends room.updated with changed room to the human members."},
```

In the `room.updated` frame line, change `"changed_values":["messages","members"]` to `"changed_values":["messages","members","room"]` and change `room_seq is absent when changed is members.` to `room_seq is absent when changed is members or room.`

- [ ] **Step 9: Run the contract test and the neighbouring route tests**

Run: `timeout 120 node --test sigil/contracts/v1/relay-api.test.mjs sigil/relay/v1/room-routes.test.mjs sigil/relay/v1/room-routes.manage.test.mjs sigil/relay/v1/room-notify.test.mjs`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add sigil/relay/v1/room-routes.mjs sigil/contracts/v1/relay-api.json sigil/contracts/v1/relay-api.test.mjs sigil/relay/v1/room-routes.manage.test.mjs
git commit -m "feat(relay): add room rename route and room.updated room frame

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Response-mode route

**Files:**
- Modify: `sigil/relay/v1/room-routes.mjs` (new handler after the rename handler)
- Modify: `sigil/contracts/v1/relay-api.json`
- Modify: `sigil/contracts/v1/relay-api.test.mjs`
- Modify: `sigil/relay/v1/room-routes.manage.test.mjs`

**Interfaces:**
- Consumes: `repository.setRoomMemberResponseMode` (Task 1), `isAgentMember(member, repository, client, registry)` from `room-policy.mjs`, and the `withRoom` helper from Task 2.
- Produces: `POST /v1/rooms/{room_id}/members/{endpoint_id}/response-mode` with body `{response_mode}`; `200 {code:'OK', member}`; errors `HUMAN_CONTEXT_REQUIRED` (403), `ROUTE_NOT_AUTHORIZED` (403), `INVALID_REQUEST` (400), `ROOM_MEMBER_NOT_FOUND` (404), `ROOM_NOT_FOUND` (404). Sends `room.updated` `{room_id, changed: 'members'}` to humans.

- [ ] **Step 1: Write the failing tests**

Append to `sigil/relay/v1/room-routes.manage.test.mjs`:

```js
const modePath = (roomId, endpointId) => `/v1/rooms/${roomId}/members/${endpointId}/response-mode`;

test('response mode: the owner changes an agent mode and humans get a members frame', async () => {
  await withRoom(async ({ port, roomId, frames }) => {
    const changed = await call(port, 'POST', modePath(roomId, 'ep_claude'), 'Bearer web', { response_mode: 'mentions_only' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.member.endpoint_id, 'ep_claude');
    assert.equal(changed.body.member.response_mode, 'mentions_only');
    const members = (await call(port, 'GET', `/v1/rooms/${roomId}/members`, 'Bearer web')).body.items;
    assert.equal(members.find((m) => m.endpoint_id === 'ep_claude').response_mode, 'mentions_only');
    assert.deepEqual(frames.map(([id]) => id).sort(), ['ep_alice', 'ep_mgr', 'ep_web']);
    assert.deepEqual(frames[0][1], { room_id: roomId, changed: 'members' });
  });
});

test('response mode: managers only, humans only as callers, valid modes only', async () => {
  await withRoom(async ({ port, roomId }) => {
    assert.equal((await call(port, 'POST', modePath(roomId, 'ep_claude'), 'Bearer mgr', { response_mode: 'router' })).status, 200);
    const member = await call(port, 'POST', modePath(roomId, 'ep_claude'), 'Bearer alice', { response_mode: 'joins' });
    assert.equal(member.status, 403);
    assert.equal(member.body.code, 'ROUTE_NOT_AUTHORIZED');
    const agent = await call(port, 'POST', modePath(roomId, 'ep_claude'), 'Bearer claude', { response_mode: 'joins' });
    assert.equal(agent.status, 403);
    assert.equal(agent.body.code, 'HUMAN_CONTEXT_REQUIRED');
    assert.equal((await call(port, 'POST', modePath(roomId, 'ep_claude'), 'Bearer stranger', { response_mode: 'joins' })).status, 404);
    for (const response_mode of ['always', '', null, 7, undefined]) {
      const bad = await call(port, 'POST', modePath(roomId, 'ep_claude'), 'Bearer web', { response_mode });
      assert.equal(bad.status, 400, `mode ${JSON.stringify(response_mode)}`);
      assert.equal(bad.body.code, 'INVALID_REQUEST');
    }
  });
});

test('response mode: human targets answer 400 and non-members 404', async () => {
  await withRoom(async ({ port, roomId }) => {
    const human = await call(port, 'POST', modePath(roomId, 'ep_alice'), 'Bearer web', { response_mode: 'joins' });
    assert.equal(human.status, 400);
    assert.equal(human.body.code, 'INVALID_REQUEST');
    const owner = await call(port, 'POST', modePath(roomId, 'ep_web'), 'Bearer web', { response_mode: 'joins' });
    assert.equal(owner.status, 400);
    const missing = await call(port, 'POST', modePath(roomId, 'ep_codex'), 'Bearer web', { response_mode: 'joins' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'ROOM_MEMBER_NOT_FOUND');
  });
});

test('response mode: a phase 1 agent with a null mode can be given one, and a second router is allowed like on add', async () => {
  await withRoom(async ({ port, roomId, repository }) => {
    await repository.addRoomMember({ conversationId: roomId, endpointId: 'ep_codex', role: 'member', responseMode: null, addedByHumanId: 'usr_chris' });
    assert.equal((await call(port, 'POST', modePath(roomId, 'ep_codex'), 'Bearer web', { response_mode: 'router' })).status, 200);
    assert.equal((await call(port, 'POST', modePath(roomId, 'ep_claude'), 'Bearer web', { response_mode: 'router' })).status, 200);
    const routers = (await call(port, 'GET', `/v1/rooms/${roomId}/members`, 'Bearer web')).body.items.filter((m) => m.response_mode === 'router');
    assert.deepEqual(routers.map((m) => m.endpoint_id).sort(), ['ep_claude', 'ep_codex']);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `timeout 60 node --test sigil/relay/v1/room-routes.manage.test.mjs`
Expected: the four new tests FAIL (the path falls through and answers non-200).

- [ ] **Step 3: Add the handler**

In `sigil/relay/v1/room-routes.mjs`, insert after the rename handler:

```js
  if (request.method === 'POST' && resource === 'members' && segment && action === 'response-mode') {
    if (isAgentCaller(registry, principal)) return fail(response, requestId, 403, 'HUMAN_CONTEXT_REQUIRED', 'Agents cannot manage room members');
    if (!MANAGER_ROLES.has(access.member.role)) return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'Only room managers can change response modes');
    const body = await readJson(request, readBody);
    const responseMode = body?.response_mode;
    if (!RESPONSE_MODES.has(responseMode)) return fail(response, requestId, 400, 'INVALID_REQUEST', 'response_mode must be joins, mentions_only, or router');
    const target = await repository.lookupRoomMember(roomId, targetEndpointId);
    if (!target) return fail(response, requestId, 404, 'ROOM_MEMBER_NOT_FOUND', 'Member not found');
    // Same agent rule as room dispatch: a phase 1 agent can have a null mode, so response_mode alone is not enough.
    const targetIsAgent = await repository.withTransaction((client) => isAgentMember(target, repository, client, registry));
    if (!targetIsAgent) return fail(response, requestId, 400, 'INVALID_REQUEST', 'response_mode applies only to agent endpoints');
    const member = await repository.setRoomMemberResponseMode({ conversationId: roomId, endpointId: targetEndpointId, responseMode });
    if (!member) return fail(response, requestId, 404, 'ROOM_MEMBER_NOT_FOUND', 'Member not found');
    await notifyRoomHumans({ repository, stream, registered: registry, client: null, roomId, changed: 'members', logger: logger ?? console });
    return send(response, requestId, 200, { code: 'OK', member });
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `timeout 60 node --test sigil/relay/v1/room-routes.manage.test.mjs`
Expected: 9 tests PASS.

- [ ] **Step 5: Contract entry and test**

Append to `sigil/contracts/v1/relay-api.test.mjs`:

```js
test('relay API lists the response-mode route', () => {
  const route = api.routes.find((item) => item.path === '/v1/rooms/{room_id}/members/{endpoint_id}/response-mode');
  assert.equal(route.method, 'POST');
  assert.equal(route.success, 200);
  assert.deepEqual(route.request_fields, ['response_mode']);
  assert.deepEqual(route.response_fields, ['code', 'member']);
  for (const code of ['HUMAN_CONTEXT_REQUIRED', 'ROUTE_NOT_AUTHORIZED', 'INVALID_REQUEST', 'ROOM_MEMBER_NOT_FOUND', 'ROOM_NOT_FOUND']) assert.ok(route.errors.includes(code), code);
});
```

Run: `timeout 60 node --test sigil/contracts/v1/relay-api.test.mjs`
Expected: FAIL.

Insert in `relay-api.json` after the rename route line:

```json
    {"method":"POST","path":"/v1/rooms/{room_id}/members/{endpoint_id}/response-mode","success":200,"errors":["UNAUTHENTICATED","HUMAN_CONTEXT_REQUIRED","ROUTE_NOT_AUTHORIZED","INVALID_REQUEST","ROOM_MEMBER_NOT_FOUND","ROOM_NOT_FOUND","DATABASE_UNAVAILABLE"],"request_fields":["response_mode"],"response_fields":["code","member"],"notes":"Room owners and room managers only; agent callers get 403 HUMAN_CONTEXT_REQUIRED. response_mode is joins, mentions_only, or router. The target must be an active member and an agent (decided as room dispatch decides it); a human target answers 400 INVALID_REQUEST. A second router is not refused, matching member add. Sends room.updated with changed members to the human members."},
```

Run: `timeout 120 node --test sigil/contracts/v1/relay-api.test.mjs sigil/relay/v1/room-routes.test.mjs sigil/relay/v1/room-routes.manage.test.mjs`
Expected: all PASS.

- [ ] **Step 6: Run the full core suite once, in the background**

Run: `timeout 600 npm test > "$TMP/core.log" 2>&1` (use the session scratchpad for the log). One run only; wait for it.
Expected: no new failures against `origin/main`. Report any failure with the file name; do not re-run overlapping suites.

- [ ] **Step 7: Commit**

```bash
git add sigil/relay/v1/room-routes.mjs sigil/contracts/v1/relay-api.json sigil/contracts/v1/relay-api.test.mjs sigil/relay/v1/room-routes.manage.test.mjs
git commit -m "feat(relay): add agent response-mode route

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Web API client, types, live frames, and contract test

**Files:**
- Modify: `packages/sigil-rooms-web/src/api/types.ts`
- Modify: `packages/sigil-rooms-web/src/api/client.ts`
- Modify: `packages/sigil-rooms-web/src/api/client.spec.ts`
- Modify: `packages/sigil-rooms-web/src/api/contract.spec.ts`
- Modify: `packages/sigil-rooms-web/src/live/useLive.ts`
- Modify: `packages/sigil-rooms-web/src/live/useLive.spec.tsx`
- Modify: `packages/sigil-rooms-web/src/errors/ErrorBanner.tsx`

**Interfaces:**
- Produces (types): `ResponseMode = 'joins' | 'mentions_only' | 'router'`; `Member { endpoint_id: string; role: 'owner' | 'room_manager' | 'member'; response_mode: ResponseMode | null; added_at: string }`; `RoomUpdatedFrame.changed: 'messages' | 'members' | 'room'`; `RoomEnvelope.body.thread_root_id?: string`.
- Produces (client): `listMembers(roomId): Promise<Member[]>`, `renameRoom(roomId, name): Promise<Room>`, `setResponseMode(roomId, endpointId, mode): Promise<Member>`, `stopRoom(roomId): Promise<{ code: string; cancelled: number }>`, and `sendMessage(roomId, text, idempotencyKey, threadRootId?)`.

- [ ] **Step 1: Install web dependencies**

Run: `cd packages/sigil-rooms-web && timeout 300 npm ci --ignore-scripts`
Expected: install completes.

- [ ] **Step 2: Write the failing client test**

Append to `src/api/client.spec.ts`:

```ts
describe('api client: room management', () => {
  it('builds the members, rename, response-mode, stop, and threaded send requests', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse(200, { code: 'OK', items: [], room: { conversation_id: 'room_1' }, member: { endpoint_id: 'ep_claude' }, cancelled: 2, message_id: 'm', room_seq: '1' });
    });
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await client.listMembers('room_1');
    await client.renameRoom('room_1', 'new name');
    await client.setResponseMode('room_1', 'ep_claude', 'mentions_only');
    expect(await client.stopRoom('room_1')).toEqual({ code: 'OK', cancelled: 2 });
    await client.sendMessage('room_1', 'hi', 'key-1', 'msg_root');
    await client.sendMessage('room_1', 'top', 'key-2');
    expect(calls[0]![0]).toBe('http://relay.test/v1/rooms/room_1/members');
    expect(calls[0]![1].method).toBe('GET');
    expect(calls[1]![0]).toBe('http://relay.test/v1/rooms/room_1/rename');
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ name: 'new name' });
    expect(calls[2]![0]).toBe('http://relay.test/v1/rooms/room_1/members/ep_claude/response-mode');
    expect(JSON.parse(String(calls[2]![1].body))).toEqual({ response_mode: 'mentions_only' });
    expect(calls[3]![0]).toBe('http://relay.test/v1/rooms/room_1/stop');
    expect(JSON.parse(String(calls[4]![1].body))).toEqual({ text: 'hi', idempotency_key: 'key-1', thread_root_id: 'msg_root' });
    expect(JSON.parse(String(calls[5]![1].body))).toEqual({ text: 'top', idempotency_key: 'key-2' });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd packages/sigil-rooms-web && timeout 60 npx vitest run src/api/client.spec.ts`
Expected: FAIL (`client.listMembers is not a function`).

- [ ] **Step 4: Update `types.ts`**

Add `thread_root_id?: string;` to `RoomEnvelope.body`, widen the frame, and add the new types:

```ts
export interface RoomEnvelope {
  message_id: string;
  message_type: string;
  sender: { endpoint_id: string; owner_id: string };
  body: { text?: string; kind?: string; reason?: string; endpoint_ids?: string[]; thread_root_id?: string };
  created_at: string;
}
```

```ts
export type ResponseMode = 'joins' | 'mentions_only' | 'router';

export interface Member {
  endpoint_id: string;
  role: 'owner' | 'room_manager' | 'member';
  response_mode: ResponseMode | null;
  added_at: string;
}

export interface StopResult {
  code: string;
  cancelled: number;
}
```

and in `RoomUpdatedFrame` change the last field to `changed: 'messages' | 'members' | 'room';`.

- [ ] **Step 5: Update `client.ts`**

Change the import to `import type { AckResult, HistoryPage, Member, ResponseMode, Room, SendResult, StopResult, TicketResult } from './types';`, extend `ApiClient`:

```ts
  sendMessage(roomId: string, text: string, idempotencyKey: string, threadRootId?: string): Promise<SendResult>;
  listMembers(roomId: string): Promise<Member[]>;
  renameRoom(roomId: string, name: string): Promise<Room>;
  setResponseMode(roomId: string, endpointId: string, mode: ResponseMode): Promise<Member>;
  stopRoom(roomId: string): Promise<StopResult>;
```

(replacing the old `sendMessage` line), and in the returned object replace `sendMessage` and add the four methods:

```ts
    sendMessage(roomId, text, idempotencyKey, threadRootId) {
      return request<SendResult>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/messages`, {
        text,
        idempotency_key: idempotencyKey,
        ...(threadRootId ? { thread_root_id: threadRootId } : {}),
      });
    },
    async listMembers(roomId) {
      return (await request<{ items: Member[] }>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/members`)).items;
    },
    async renameRoom(roomId, name) {
      return (await request<{ room: Room }>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/rename`, { name })).room;
    },
    async setResponseMode(roomId, endpointId, mode) {
      return (await request<{ member: Member }>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(endpointId)}/response-mode`, { response_mode: mode })).member;
    },
    stopRoom(roomId) {
      return request<StopResult>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/stop`);
    },
```

- [ ] **Step 6: Run to verify it passes**

Run: `timeout 60 npx vitest run src/api/client.spec.ts`
Expected: PASS.

- [ ] **Step 7: Extend the contract test**

In `src/api/contract.spec.ts`, add inside the first `it` (routes the client calls):

```ts
    route('GET', '/v1/rooms/{room_id}/members');
    route('POST', '/v1/rooms/{room_id}/rename');
    route('POST', '/v1/rooms/{room_id}/members/{endpoint_id}/response-mode');
    route('POST', '/v1/rooms/{room_id}/stop');
```

add inside the request/response-fields test:

```ts
    expect(route('POST', '/v1/rooms/{room_id}/rename').request_fields).toContain('name');
    expect(route('POST', '/v1/rooms/{room_id}/rename').response_fields).toContain('room');
    expect(route('POST', '/v1/rooms/{room_id}/members/{endpoint_id}/response-mode').request_fields).toContain('response_mode');
    expect(route('POST', '/v1/rooms/{room_id}/members/{endpoint_id}/response-mode').response_fields).toContain('member');
    expect(route('POST', '/v1/rooms/{room_id}/messages').request_fields).toContain('thread_root_id');
```

add `'ROOM_NAME_TAKEN', 'ROUTE_NOT_AUTHORIZED', 'ROOM_MEMBER_NOT_FOUND'` to the error-code list, and change the frame assertion to `expect(frame?.changed_values).toEqual(expect.arrayContaining(['messages', 'members', 'room']));`.

Run: `timeout 60 npx vitest run src/api/contract.spec.ts`
Expected: PASS (the relay-api.json entries exist from Tasks 2 and 3).

- [ ] **Step 8: Write the failing `useLive` tests**

In `src/live/useLive.spec.tsx`, replace the test named `invalidates the room list on a members frame` with:

```tsx
  it('invalidates the room list and the roster on a members frame', async () => {
    const { spy } = setup();
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.onFrame({ type: 'room.updated', room_id: 'room_1', changed: 'members' });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['rooms'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['room', 'room_1', 'members'] });
  });

  it('invalidates only the room list on a room frame', async () => {
    const { spy } = setup();
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.onFrame({ type: 'room.updated', room_id: 'room_1', changed: 'room' });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['rooms'] });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['room', 'room_1', 'messages'] });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['room', 'room_1', 'members'] });
  });
```

Run: `timeout 60 npx vitest run src/live/useLive.spec.tsx`
Expected: the two new tests FAIL (the roster key is never invalidated; the room frame refetches history).

- [ ] **Step 9: Update `useLive.ts`**

Replace the `onFrame` body:

```ts
      onFrame: (frame) => {
        if (frame.changed === 'room') {
          void queryClient.invalidateQueries({ queryKey: ['rooms'] });
        } else if (frame.changed === 'members') {
          // A member added to a room the client has not opened still has to show up in the sidebar.
          void queryClient.invalidateQueries({ queryKey: ['rooms'] });
          void queryClient.invalidateQueries({ queryKey: ['room', frame.room_id, 'members'] });
        } else {
          const queryKey = ['room', frame.room_id, 'messages'];
          // Cancel first so an in-flight fetch that predates this frame cannot be reused.
          void queryClient
            .cancelQueries({ queryKey })
            .catch(() => {})
            .then(() => queryClient.invalidateQueries({ queryKey }));
        }
      },
```

- [ ] **Step 10: Add the `ROUTE_NOT_AUTHORIZED` message**

In `src/errors/ErrorBanner.tsx`, add inside the `switch`, after the `ROOM_NAME_TAKEN` case:

```ts
    case 'ROUTE_NOT_AUTHORIZED': return 'Only room managers can do this';
```

- [ ] **Step 11: Run the package checks**

Run: `timeout 120 npx vitest run && timeout 120 npm run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 12: Commit**

```bash
git add packages/sigil-rooms-web/src/api packages/sigil-rooms-web/src/live packages/sigil-rooms-web/src/errors
git commit -m "feat(web): add room management API calls and room and members frame handling

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Thread helpers

**Files:**
- Create: `packages/sigil-rooms-web/src/rooms/threads.ts`
- Create: `packages/sigil-rooms-web/src/rooms/threads.spec.ts`

**Interfaces:**
- Consumes: `HistoryItem` from `../api/types`, `toSeq` from `./seq`.
- Produces:
  - `rowsById(items: HistoryItem[]): Map<string, HistoryItem>`
  - `isTopLevel(item: HistoryItem): boolean`: false only for a `room.message` with a `thread_root_id`.
  - `threadRootOf(item: HistoryItem, byId: Map<string, HistoryItem>): string`: follows `thread_root_id` through `byId` to a row with none, a missing row, or a repeat.
  - `replyCounts(items: HistoryItem[], byId): Map<string, number>`: replies per canonical root.
  - `threadReplies(items: HistoryItem[], byId, rootId: string): HistoryItem[]`: replies of the thread in `room_seq` order, excluding the root.
  - `ackWatermark(items: HistoryItem[], openRootId: string | null, byId): string`: highest seq `S` such that every row at or below `S` is seen; `'0'` when none.

- [ ] **Step 1: Write the failing tests**

Create `src/rooms/threads.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { HistoryItem } from '../api/types';
import { ackWatermark, isTopLevel, replyCounts, rowsById, threadReplies, threadRootOf } from './threads';

function row(seq: number, id: string, opts: { root?: string; type?: string } = {}): HistoryItem {
  const type = opts.type ?? 'room.message';
  return {
    room_seq: String(seq),
    message_id: id,
    canonical_bytes: 'b',
    envelope: {
      message_id: id,
      message_type: type,
      sender: { endpoint_id: 'ep_a', owner_id: 'u' },
      body: type === 'room.event' ? { kind: 'invocation_stopped' } : { text: id, ...(opts.root ? { thread_root_id: opts.root } : {}) },
      created_at: 't',
    },
  };
}

describe('threadRootOf', () => {
  it('returns the message itself for a top-level row', () => {
    const items = [row(1, 'a')];
    expect(threadRootOf(items[0]!, rowsById(items))).toBe('a');
  });

  it('returns the root of a direct reply', () => {
    const items = [row(1, 'a'), row(2, 'b', { root: 'a' })];
    expect(threadRootOf(items[1]!, rowsById(items))).toBe('a');
  });

  it('follows a depth-2 chain to the top root', () => {
    const items = [row(1, 'a'), row(2, 'b', { root: 'a' }), row(3, 'c', { root: 'b' })];
    expect(threadRootOf(items[2]!, rowsById(items))).toBe('a');
  });

  it('returns the named root when that row is not loaded', () => {
    const items = [row(5, 'c', { root: 'missing' })];
    expect(threadRootOf(items[0]!, rowsById(items))).toBe('missing');
  });

  it('stops on a cycle instead of looping', () => {
    const items = [row(1, 'x', { root: 'y' }), row(2, 'y', { root: 'x' })];
    expect(['x', 'y']).toContain(threadRootOf(items[0]!, rowsById(items)));
  });
});

describe('isTopLevel', () => {
  it('is false only for a message that names a thread root', () => {
    expect(isTopLevel(row(1, 'a'))).toBe(true);
    expect(isTopLevel(row(2, 'b', { root: 'a' }))).toBe(false);
    expect(isTopLevel(row(3, 'e', { type: 'room.event' }))).toBe(true);
  });
});

describe('replyCounts and threadReplies', () => {
  const items = [row(1, 'a'), row(2, 'b', { root: 'a' }), row(3, 'c', { root: 'b' }), row(4, 'd'), row(5, 'e', { root: 'a' })];
  const byId = rowsById(items);

  it('counts replies per canonical root, nested replies included', () => {
    expect(replyCounts(items, byId).get('a')).toBe(3);
    expect(replyCounts(items, byId).has('d')).toBe(false);
  });

  it('lists a thread\'s replies in room_seq order without the root', () => {
    expect(threadReplies(items, byId, 'a').map((i) => i.message_id)).toEqual(['b', 'c', 'e']);
  });

  it('lists the replies of a root that is not loaded', () => {
    const orphan = [row(9, 'z', { root: 'gone' })];
    expect(threadReplies(orphan, rowsById(orphan), 'gone').map((i) => i.message_id)).toEqual(['z']);
  });

  it('puts out-of-order rows in room_seq order', () => {
    const shuffled = [row(5, 'e', { root: 'a' }), row(1, 'a'), row(2, 'b', { root: 'a' })];
    expect(threadReplies(shuffled, rowsById(shuffled), 'a').map((i) => i.message_id)).toEqual(['b', 'e']);
  });
});

describe('ackWatermark', () => {
  const items = [row(1, 'm1'), row(2, 'r2', { root: 'm1' }), row(3, 'm3')];
  const byId = rowsById(items);

  it('stops before an unseen reply in a closed thread', () => {
    expect(ackWatermark(items, null, byId)).toBe('1');
  });

  it('reaches the highest seq once the thread is open', () => {
    expect(ackWatermark(items, 'm1', byId)).toBe('3');
  });

  it('is the highest seq when every row is top-level, events included', () => {
    const flat = [row(1, 'a'), row(2, 'e', { type: 'room.event' }), row(3, 'b')];
    expect(ackWatermark(flat, null, rowsById(flat))).toBe('3');
  });

  it('is 0 when the first row is an unseen reply', () => {
    const hidden = [row(1, 'r', { root: 'gone' }), row(2, 'm')];
    expect(ackWatermark(hidden, null, rowsById(hidden))).toBe('0');
  });

  it('counts a depth-2 reply as seen when its canonical root is open', () => {
    const nested = [row(1, 'a'), row(2, 'b', { root: 'a' }), row(3, 'c', { root: 'b' })];
    expect(ackWatermark(nested, 'a', rowsById(nested))).toBe('3');
    expect(ackWatermark(nested, null, rowsById(nested))).toBe('1');
  });

  it('is 0 for no rows', () => {
    expect(ackWatermark([], null, new Map())).toBe('0');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `timeout 60 npx vitest run src/rooms/threads.spec.ts`
Expected: FAIL (`Failed to resolve import "./threads"`).

- [ ] **Step 3: Implement `threads.ts`**

Create `src/rooms/threads.ts`:

```ts
import type { HistoryItem } from '../api/types';
import { toSeq } from './seq';

export function rowsById(items: HistoryItem[]): Map<string, HistoryItem> {
  return new Map(items.map((item) => [item.message_id, item]));
}

// A reply names a thread root; an event or a message with no thread_root_id sits in the main timeline.
export function isTopLevel(item: HistoryItem): boolean {
  return !(item.envelope.message_type === 'room.message' && item.envelope.body.thread_root_id);
}

// body.thread_root_id ?? message_id, followed through the cache. The relay does not normalize
// thread_root_id, so a CLI or bridge message can point at a reply. Stops at a row with no
// thread_root_id, an unloaded row, or a repeat (cycle guard).
export function threadRootOf(item: HistoryItem, byId: Map<string, HistoryItem>): string {
  let id = item.envelope.body.thread_root_id ?? item.message_id;
  const seen = new Set<string>([item.message_id]);
  for (;;) {
    if (seen.has(id)) return id;
    seen.add(id);
    const next = byId.get(id)?.envelope.body.thread_root_id;
    if (!next) return id;
    id = next;
  }
}

function bySeq(a: HistoryItem, b: HistoryItem): number {
  const left = toSeq(a.room_seq);
  const right = toSeq(b.room_seq);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function replyCounts(items: HistoryItem[], byId: Map<string, HistoryItem>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (isTopLevel(item)) continue;
    const root = threadRootOf(item, byId);
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return counts;
}

export function threadReplies(items: HistoryItem[], byId: Map<string, HistoryItem>, rootId: string): HistoryItem[] {
  return items
    .filter((item) => !isTopLevel(item) && threadRootOf(item, byId) === rootId)
    .sort(bySeq);
}

// The ack route marks every delivery at or below the seq as read, so the client reports only a seq
// it has shown: the highest S such that every row at or below S is in the main timeline, an event,
// or in the open thread. useAck is forward-only, so closing a thread never lowers a reported seq.
export function ackWatermark(items: HistoryItem[], openRootId: string | null, byId: Map<string, HistoryItem>): string {
  let watermark = 0n;
  for (const item of [...items].sort(bySeq)) {
    const seen = isTopLevel(item) || (openRootId !== null && threadRootOf(item, byId) === openRootId);
    if (!seen) break;
    watermark = toSeq(item.room_seq);
  }
  return watermark.toString();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `timeout 60 npx vitest run src/rooms/threads.spec.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sigil-rooms-web/src/rooms/threads.ts packages/sigil-rooms-web/src/rooms/threads.spec.ts
git commit -m "feat(web): add thread grouping and ack watermark helpers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Pending thread replies

**Files:**
- Modify: `packages/sigil-rooms-web/src/rooms/mergeRows.ts`
- Modify: `packages/sigil-rooms-web/src/rooms/useSend.ts`
- Create: `packages/sigil-rooms-web/src/rooms/useSend.spec.tsx`

**Interfaces:**
- Consumes: `ApiClient.sendMessage(roomId, text, idempotencyKey, threadRootId?)` from Task 4.
- Produces: `PendingMessage.threadRootId?: string`; `useSend(roomId).send(text: string, threadRootId?: string)`. `retry(key)` re-dispatches the stored text, the stored `threadRootId`, and the same key.

- [ ] **Step 1: Write the failing test**

Create `src/rooms/useSend.spec.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient } from '../api/client';
import { TestAuthProvider } from '../auth/AuthContext';
import { useSend } from './useSend';

function setup(client: Partial<ApiClient>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestAuthProvider client={client as ApiClient}>{children}</TestAuthProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useSend('room_1'), { wrapper });
}

const history = async () => ({ code: 'OK', items: [], next_after_seq: '0' });

describe('useSend threads', () => {
  it('keeps the thread id on a failed reply and reuses it, the text, and the key on retry', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('HTTP_500', 500, 'boom'))
      .mockResolvedValueOnce({ code: 'OK', message_id: 'm2', room_seq: '5' });
    const { result } = setup({ sendMessage, history });
    act(() => result.current.send('hi', 'msg_root'));
    await waitFor(() => expect(result.current.pending[0]?.status).toBe('failed'));
    expect(result.current.pending[0]?.threadRootId).toBe('msg_root');
    const key = result.current.pending[0]!.idempotencyKey;
    act(() => result.current.retry(key));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls[1]).toEqual(['room_1', 'hi', key, 'msg_root']);
  });

  it('sends a top-level message with no thread id', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ code: 'OK', message_id: 'm1', room_seq: '1' });
    const { result } = setup({ sendMessage, history });
    act(() => result.current.send('top'));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]![3]).toBeUndefined();
    expect(result.current.pending[0]?.threadRootId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `timeout 60 npx vitest run src/rooms/useSend.spec.tsx`
Expected: FAIL (`threadRootId` is undefined, and the retry call has no fourth argument).

- [ ] **Step 3: Add the field to `PendingMessage`**

In `src/rooms/mergeRows.ts`, add `threadRootId?: string;` to `PendingMessage` after `retryable?: boolean;`.

- [ ] **Step 4: Thread the id through `useSend.ts`**

Change the `dispatch` signature and its send call:

```ts
  const dispatch = useCallback(
    async (room: string, idempotencyKey: string, text: string, threadRootId?: string) => {
```

and replace `const result = await client.sendMessage(room, text, idempotencyKey);` with:

```ts
        const result = await client.sendMessage(room, text, idempotencyKey, threadRootId);
```

Replace `send`:

```ts
  const send = useCallback(
    (text: string, threadRootId?: string) => {
      const idempotencyKey = crypto.randomUUID();
      setErrorByRoom((all) => ({ ...all, [roomId]: null }));
      setRowsByRoom((all) => ({
        ...all,
        [roomId]: [...(all[roomId] ?? []), { idempotencyKey, text, status: 'sending', ...(threadRootId ? { threadRootId } : {}) }],
      }));
      void dispatch(roomId, idempotencyKey, text, threadRootId);
    },
    [dispatch, roomId],
  );
```

and `retry`:

```ts
      if (row && row.status === 'failed') void dispatch(roomId, idempotencyKey, row.text, row.threadRootId);
```

- [ ] **Step 5: Run to verify it passes**

Run: `timeout 60 npx vitest run src/rooms/useSend.spec.tsx src/rooms/mergeRows.spec.ts && timeout 120 npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/sigil-rooms-web/src/rooms/mergeRows.ts packages/sigil-rooms-web/src/rooms/useSend.ts packages/sigil-rooms-web/src/rooms/useSend.spec.tsx
git commit -m "feat(web): keep the thread id on pending and retried sends

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Thread panel, timeline filtering, and ack watermark wiring

**Files:**
- Create: `packages/sigil-rooms-web/src/rooms/RowView.tsx` (extracted from `Timeline.tsx`)
- Create: `packages/sigil-rooms-web/src/rooms/ThreadPanel.tsx`, `packages/sigil-rooms-web/src/rooms/ThreadPanel.spec.tsx`
- Modify: `packages/sigil-rooms-web/src/rooms/Timeline.tsx`, `Timeline.spec.tsx`, `Composer.tsx`
- Modify: `packages/sigil-rooms-web/src/App.tsx`, `packages/sigil-rooms-web/src/styles.css`

**Interfaces:**
- Consumes: Task 5 helpers, Task 6 `send(text, threadRootId?)`.
- Produces:
  - `RowView({ row: Row; sender: string | null; replies?: number; onReply?: () => void })`, exported from `rooms/RowView.tsx`.
  - `Timeline` gains optional props `openThreadRoot?: string | null` (default `null`) and `onOpenThread?: (rootId: string) => void`.
  - `ThreadPanel({ roomId: string; rootId: string; pending: PendingMessage[]; onSend: (text: string) => void; onClose: () => void; disabledReason: string | null })`.
  - `Composer` gains optional `label?: string` (default `'Message'`).

- [ ] **Step 1: Extract `RowView` and `Stamp`**

Create `src/rooms/RowView.tsx` containing the existing `Stamp` and `RowView` from `Timeline.tsx`, plus the new props:

```tsx
import type { Row } from './mergeRows';

function Stamp({ at }: { at: string }) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return <time dateTime={at}>{date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>;
}

export function RowView({ row, sender, replies = 0, onReply }: { row: Row; sender: string | null; replies?: number; onReply?: () => void }) {
  if (row.pending) {
    return (
      <li data-mine="true" data-pending={row.pending.status}>
        <span className="text">{row.pending.text}</span>
        <em className="status">{row.pending.status === 'failed' ? `Failed: ${row.pending.error ?? 'send error'}` : 'Sending…'}</em>
      </li>
    );
  }
  const envelope = row.item!.envelope;
  if (envelope.message_type === 'room.event') {
    const { kind, reason } = envelope.body;
    return <li data-kind="event"><em>{kind}{reason ? `: ${reason}` : ''}</em></li>;
  }
  const mine = sender !== null && envelope.sender.endpoint_id === sender;
  return (
    <li data-mine={mine ? 'true' : undefined}>
      <div className="meta">
        <small className="sender">{envelope.sender.endpoint_id}</small>
        <Stamp at={envelope.created_at} />
      </div>
      <span className="text">{envelope.body.text}</span>
      {onReply ? (
        <div className="row-actions">
          <button type="button" className="ghost" onClick={onReply}>Reply</button>
          {replies > 0 ? (
            <button type="button" className="ghost" onClick={onReply}>{replies} {replies === 1 ? 'reply' : 'replies'}</button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
```

- [ ] **Step 2: Write the failing `Timeline` tests**

Append to `src/rooms/Timeline.spec.tsx` (the file's `msg` helper builds top-level rows; add a reply helper at the top of the new `describe`):

```tsx
function reply(seq: number, id: string, text: string, root: string): HistoryItem {
  const item = msg(seq, id, text);
  item.envelope.body = { text, thread_root_id: root };
  return item;
}

describe('Timeline threads', () => {
  const rows = [msg(1, 'm1', 'root text'), reply(2, 'r2', 'reply text', 'm1'), msg(3, 'm3', 'later top-level')];
  const history = vi.fn(async () => ({ code: 'OK', items: rows, next_after_seq: '3' }));

  it('hides replies from the main timeline and shows a reply count on the root', async () => {
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} />, { history });
    expect(await screen.findByText('root text')).toBeInTheDocument();
    expect(screen.queryByText('reply text')).toBeNull();
    expect(screen.getByRole('button', { name: '1 reply' })).toBeInTheDocument();
  });

  it('opens the thread for the canonical root when Reply is clicked', async () => {
    const onOpenThread = vi.fn();
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} onOpenThread={onOpenThread} />, { history });
    await screen.findByText('root text');
    await userEvent.click(screen.getAllByRole('button', { name: 'Reply' })[0]!);
    expect(onOpenThread).toHaveBeenCalledWith('m1');
  });

  it('keeps pending thread replies out of the main timeline', async () => {
    const pending = [{ idempotencyKey: 'k', text: 'draft reply', status: 'sending' as const, threadRootId: 'm1' }];
    renderWithClient(<Timeline roomId="room_1" pending={pending} onVisibleSeq={() => {}} onGone={() => {}} />, { history });
    await screen.findByText('root text');
    expect(screen.queryByText('draft reply')).toBeNull();
  });

  it('acks only up to the row before an unseen reply, and up to the highest row once its thread is open', async () => {
    const closed = vi.fn();
    const first = renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={closed} onGone={() => {}} />, { history });
    await screen.findByText('root text');
    await waitFor(() => expect(closed).toHaveBeenLastCalledWith('1'));
    first.unmount();
    const open = vi.fn();
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={open} onGone={() => {}} openThreadRoot="m1" />, { history });
    await waitFor(() => expect(open).toHaveBeenLastCalledWith('3'));
  });
});
```

Add `import userEvent from '@testing-library/user-event';` to the file's imports.

Run: `timeout 60 npx vitest run src/rooms/Timeline.spec.tsx`
Expected: the four new tests FAIL.

- [ ] **Step 3: Rewrite `Timeline.tsx`**

Replace the file with:

```tsx
import { useEffect, useMemo, useRef } from 'react';
import { ApiError } from '../api/client';
import { ErrorBanner } from '../errors/ErrorBanner';
import { getSender } from '../auth/tokenStore';
import { mergeRows, type PendingMessage } from './mergeRows';
import { RowView } from './RowView';
import { ackWatermark, isTopLevel, replyCounts, rowsById, threadRootOf } from './threads';
import { useHistory } from './useHistory';

export function Timeline({
  roomId,
  pending,
  onVisibleSeq,
  onGone,
  openThreadRoot = null,
  onOpenThread = () => {},
}: {
  roomId: string;
  pending: PendingMessage[];
  onVisibleSeq: (seq: string) => void;
  onGone: () => void;
  openThreadRoot?: string | null;
  onOpenThread?: (rootId: string) => void;
}) {
  const { items, isLoading, error } = useHistory(roomId);
  const byId = useMemo(() => rowsById(items), [items]);
  const counts = useMemo(() => replyCounts(items, byId), [items, byId]);
  const rows = useMemo(
    () => mergeRows(items.filter(isTopLevel), pending.filter((message) => !message.threadRootId)),
    [items, pending],
  );
  const watermark = useMemo(() => ackWatermark(items, openThreadRoot, byId), [items, openThreadRoot, byId]);

  const scroller = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  useEffect(() => {
    if (watermark !== '0') onVisibleSeq(watermark);
  }, [watermark, onVisibleSeq]);

  useEffect(() => {
    if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') onGone();
  }, [error, onGone]);

  if (error && items.length === 0) return <ErrorBanner error={error} />;
  if (isLoading) return <p>Loading messages…</p>;
  const sender = getSender();
  return (
    <section aria-label="Messages" className="timeline" ref={scroller}>
      {error ? <ErrorBanner error={error} /> : null}
      <ul>
        {rows.map((row) => (
          <RowView
            key={row.key}
            row={row}
            sender={sender}
            replies={row.item ? counts.get(row.item.message_id) ?? 0 : 0}
            onReply={row.item && row.item.envelope.message_type === 'room.message' ? () => onOpenThread(threadRootOf(row.item!, byId)) : undefined}
          />
        ))}
      </ul>
    </section>
  );
}
```

Run: `timeout 60 npx vitest run src/rooms/Timeline.spec.tsx`
Expected: all PASS, including the pre-existing tests.

- [ ] **Step 4: Give `Composer` a label**

In `src/rooms/Composer.tsx` change the signature to `export function Composer({ send, disabledReason, label = 'Message' }: { send: (text: string) => void; disabledReason: string | null; label?: string })` and the textarea to `aria-label={label}`.

- [ ] **Step 5: Write the failing `ThreadPanel` tests**

Create `src/rooms/ThreadPanel.spec.tsx`:

```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { HistoryItem } from '../api/types';
import { renderWithClient } from '../testUtils';
import { ThreadPanel } from './ThreadPanel';

function msg(seq: number, id: string, text: string, root?: string): HistoryItem {
  return {
    room_seq: String(seq), message_id: id, canonical_bytes: 'b',
    envelope: { message_id: id, message_type: 'room.message', sender: { endpoint_id: 'ep_a', owner_id: 'u' }, body: { text, ...(root ? { thread_root_id: root } : {}) }, created_at: 't' },
  };
}

function panel(items: HistoryItem[], extra: Partial<Parameters<typeof ThreadPanel>[0]> = {}) {
  const history = vi.fn(async () => ({ code: 'OK', items, next_after_seq: '9' }));
  const onSend = vi.fn();
  renderWithClient(<ThreadPanel roomId="room_1" rootId="m1" pending={[]} onSend={onSend} onClose={() => {}} disabledReason={null} {...extra} />, { history });
  return { onSend };
}

describe('ThreadPanel', () => {
  it('shows the root and its replies, a depth-2 reply included', async () => {
    panel([msg(1, 'm1', 'root text'), msg(2, 'm2', 'first reply', 'm1'), msg(3, 'm3', 'nested reply', 'm2'), msg(4, 'm4', 'other thread')]);
    expect(await screen.findByText('root text')).toBeInTheDocument();
    expect(screen.getByText('first reply')).toBeInTheDocument();
    expect(screen.getByText('nested reply')).toBeInTheDocument();
    expect(screen.queryByText('other thread')).toBeNull();
  });

  it('shows a placeholder when the root is not loaded and keeps the reply', async () => {
    panel([msg(5, 'm5', 'orphan reply', 'm1')]);
    expect(await screen.findByText('orphan reply')).toBeInTheDocument();
    expect(screen.getByText('Original message not loaded')).toBeInTheDocument();
  });

  it('sends a reply through onSend and shows a failed pending reply for this thread only', async () => {
    const pending = [
      { idempotencyKey: 'k1', text: 'in this thread', status: 'failed' as const, error: 'boom', threadRootId: 'm1' },
      { idempotencyKey: 'k2', text: 'in another thread', status: 'sending' as const, threadRootId: 'm9' },
    ];
    const { onSend } = panel([msg(1, 'm1', 'root text')], { pending });
    expect(await screen.findByText('in this thread')).toBeInTheDocument();
    expect(screen.queryByText('in another thread')).toBeNull();
    await userEvent.type(screen.getByLabelText('Reply in thread'), 'my reply');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('my reply');
  });
});
```

Run: `timeout 60 npx vitest run src/rooms/ThreadPanel.spec.tsx`
Expected: FAIL (`Failed to resolve import "./ThreadPanel"`).

- [ ] **Step 6: Implement `ThreadPanel.tsx`**

```tsx
import { useMemo } from 'react';
import { getSender } from '../auth/tokenStore';
import { Composer } from './Composer';
import { mergeRows, type PendingMessage } from './mergeRows';
import { RowView } from './RowView';
import { rowsById, threadReplies } from './threads';
import { useHistory } from './useHistory';

export function ThreadPanel({
  roomId,
  rootId,
  pending,
  onSend,
  onClose,
  disabledReason,
}: {
  roomId: string;
  rootId: string;
  pending: PendingMessage[];
  onSend: (text: string) => void;
  onClose: () => void;
  disabledReason: string | null;
}) {
  // The same query the timeline reads, so the panel adds no fetch.
  const { items } = useHistory(roomId);
  const byId = useMemo(() => rowsById(items), [items]);
  const root = byId.get(rootId) ?? null;
  const rows = useMemo(
    () => mergeRows(threadReplies(items, byId, rootId), pending.filter((message) => message.threadRootId === rootId)),
    [items, byId, rootId, pending],
  );
  const sender = getSender();
  return (
    <aside className="thread" aria-label="Thread">
      <header className="thread-head">
        <strong>Thread</strong>
        <button type="button" className="ghost" onClick={onClose}>Close</button>
      </header>
      <ul className="thread-rows">
        <li data-root="true">
          {root ? <span className="text">{root.envelope.body.text}</span> : <em>Original message not loaded</em>}
        </li>
        {rows.map((row) => (
          <RowView key={row.key} row={row} sender={sender} />
        ))}
      </ul>
      <Composer send={onSend} disabledReason={disabledReason} label="Reply in thread" />
    </aside>
  );
}
```

Run: `timeout 60 npx vitest run src/rooms/ThreadPanel.spec.tsx`
Expected: PASS.

- [ ] **Step 7: Wire `RoomView` in `App.tsx`**

In `src/App.tsx`, add `import { ThreadPanel } from './rooms/ThreadPanel';` and replace `RoomView` with:

```tsx
function RoomView({ roomId, onGone }: { roomId: string; onGone: () => void }) {
  const { pending, send, retry, sendError } = useSend(roomId);
  const reportSeq = useAck(roomId);
  // RoomView is keyed by room, so the open thread resets when the room changes.
  const [openThread, setOpenThread] = useState<string | null>(null);
  const disabledReason =
    sendError instanceof ApiError && (sendError.code === 'ROOM_SEND_UNAVAILABLE' || sendError.code === 'NO_SIGNING_KEY')
      ? describeError(sendError)
      : null;
  return (
    <div className="room">
      <div className="room-body">
        <div className="room-main">
          <Timeline roomId={roomId} pending={pending} onVisibleSeq={reportSeq} onGone={onGone} openThreadRoot={openThread} onOpenThread={setOpenThread} />
          <div className="notices">
            {pending
              .filter((row) => row.status === 'failed' && row.retryable !== false)
              .map((row) => (
                <button key={row.idempotencyKey} className="retry" onClick={() => retry(row.idempotencyKey)}>
                  Retry{row.threadRootId ? ' (thread)' : ''}: {row.text}
                </button>
              ))}
            <ErrorBanner error={sendError && !disabledReason ? sendError : null} />
          </div>
          <Composer send={(text) => send(text)} disabledReason={disabledReason} />
        </div>
        {openThread ? (
          <ThreadPanel
            roomId={roomId}
            rootId={openThread}
            pending={pending}
            onSend={(text) => send(text, openThread)}
            onClose={() => setOpenThread(null)}
            disabledReason={disabledReason}
          />
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Add styles**

Append to `src/styles.css`:

```css
/* THREADS */
.room-body { display: flex; flex: 1; min-height: 0; }
.room-main { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.thread { display: flex; flex-direction: column; width: 24rem; max-width: 40%; border-left: 1px solid var(--border); background: var(--surface-subtle); min-height: 0; }
.thread-head { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); }
.thread-rows { flex: 1; overflow-y: auto; list-style: none; margin: 0; padding: 1rem; display: grid; gap: 0.75rem; align-content: start; }
.thread-rows li { padding: 0.65rem 0.95rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.thread-rows li[data-root='true'] { border-color: var(--border-strong); }
.thread-rows li[data-mine='true'] { background: var(--mine); border-color: var(--mine-border); }
.thread-rows li[data-pending='failed'] { border-color: var(--danger); }
.row-actions { display: flex; gap: 0.5rem; margin-top: 0.4rem; }
```

- [ ] **Step 9: Run the package checks**

Run: `timeout 180 npx vitest run && timeout 120 npm run typecheck && timeout 180 npm run build`
Expected: PASS, typecheck clean, build succeeds.

- [ ] **Step 10: Commit**

```bash
git add packages/sigil-rooms-web/src
git commit -m "feat(web): add thread side panel with thread-aware ack watermark

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Room header with Stop, roster panel, and inline rename

**Files:**
- Create: `src/rooms/useMembers.ts`, `src/rooms/roles.ts`
- Create: `src/rooms/RenameTitle.tsx` and `RenameTitle.spec.tsx`
- Create: `src/rooms/RosterPanel.tsx` and `RosterPanel.spec.tsx`
- Create: `src/rooms/RoomHeader.tsx` and `RoomHeader.spec.tsx`
- Modify: `src/App.tsx`, `src/styles.css`

(All paths are under `packages/sigil-rooms-web/`.)

**Interfaces:**
- Consumes: `ApiClient.listMembers/renameRoom/setResponseMode/stopRoom` (Task 4).
- Produces:
  - `membersKey(roomId): readonly ['room', string, 'members']` and `useMembers(roomId)` in `rooms/useMembers.ts`.
  - `isManager(members: Member[], sender: string | null): boolean` in `rooms/roles.ts`.
  - `RenameTitle({ roomId, name, canRename, onGone })`, `RosterPanel({ roomId, members, manager })`, and `RoomHeader({ roomId, name, sender, onGone })`.

- [ ] **Step 1: Write the helpers**

`src/rooms/useMembers.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';

export const membersKey = (roomId: string) => ['room', roomId, 'members'] as const;

export function useMembers(roomId: string) {
  const { client } = useAuth();
  return useQuery({ queryKey: membersKey(roomId), queryFn: () => client.listMembers(roomId) });
}
```

`src/rooms/roles.ts`:

```ts
import type { Member } from '../api/types';

// The client learns its own endpoint ID from its first successful send (4b-1), so before that
// it cannot find its own row and treats the caller as a non-manager. The relay stays the authority.
export function isManager(members: Member[], sender: string | null): boolean {
  if (!sender) return false;
  const me = members.find((member) => member.endpoint_id === sender);
  return me?.role === 'owner' || me?.role === 'room_manager';
}
```

- [ ] **Step 2: Write the failing `RenameTitle` tests**

`src/rooms/RenameTitle.spec.tsx`:

```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { renderWithClient } from '../testUtils';
import { RenameTitle } from './RenameTitle';

const room = { conversation_id: 'room_1', workspace_id: 'ws', name: 'renamed', description: null, created_at: 't', max_agent_turns: 6 };

describe('RenameTitle', () => {
  it('hides the rename button from non-managers', () => {
    renderWithClient(<RenameTitle roomId="room_1" name="build" canRename={false} onGone={() => {}} />, {});
    expect(screen.getByText('build')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename room' })).toBeNull();
  });

  it('renames with a trimmed name and refreshes the room list', async () => {
    const renameRoom = vi.fn(async () => room);
    const { queryClient } = renderWithClient(<RenameTitle roomId="room_1" name="build" canRename onGone={() => {}} />, { renameRoom });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await userEvent.click(screen.getByRole('button', { name: 'Rename room' }));
    const input = screen.getByLabelText('Room name');
    await userEvent.clear(input);
    await userEvent.type(input, '  renamed  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(renameRoom).toHaveBeenCalledWith('room_1', 'renamed'));
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['rooms'] }));
    expect(screen.queryByLabelText('Room name')).toBeNull();
  });

  it('keeps the input open and shows the relay message on a name conflict', async () => {
    const renameRoom = vi.fn(async () => { throw new ApiError('ROOM_NAME_TAKEN', 409, 'x'); });
    renderWithClient(<RenameTitle roomId="room_1" name="build" canRename onGone={() => {}} />, { renameRoom });
    await userEvent.click(screen.getByRole('button', { name: 'Rename room' }));
    const input = screen.getByLabelText('Room name');
    await userEvent.clear(input);
    await userEvent.type(input, 'ops');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    expect(screen.getByLabelText('Room name')).toBeInTheDocument();
  });

  it('returns to the list on ROOM_NOT_FOUND and skips the call when the name is unchanged', async () => {
    const onGone = vi.fn();
    const renameRoom = vi.fn(async () => { throw new ApiError('ROOM_NOT_FOUND', 404, 'gone'); });
    renderWithClient(<RenameTitle roomId="room_1" name="build" canRename onGone={onGone} />, { renameRoom });
    await userEvent.click(screen.getByRole('button', { name: 'Rename room' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(renameRoom).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Rename room' }));
    const input = screen.getByLabelText('Room name');
    await userEvent.clear(input);
    await userEvent.type(input, 'other');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(onGone).toHaveBeenCalled());
  });
});
```

Run: `timeout 60 npx vitest run src/rooms/RenameTitle.spec.tsx`
Expected: FAIL (`Failed to resolve import "./RenameTitle"`).

- [ ] **Step 3: Implement `RenameTitle.tsx`**

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../errors/ErrorBanner';
import { membersKey } from './useMembers';

export function RenameTitle({ roomId, name, canRename, onGone }: { roomId: string; name: string; canRename: boolean; onGone: () => void }) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const rename = useMutation({
    mutationFn: (next: string) => client.renameRoom(roomId, next),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ['rooms'] });
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.code === 'ROOM_NOT_FOUND') onGone();
      // The caller's role changed under the client: refetch the roster so the control disappears.
      if (error.code === 'ROUTE_NOT_AUTHORIZED') void queryClient.invalidateQueries({ queryKey: membersKey(roomId) });
    },
  });

  if (!editing) {
    return (
      <h2 className="room-title">
        {name}
        {canRename ? (
          <button
            type="button"
            className="ghost"
            aria-label="Rename room"
            onClick={() => { setDraft(name); rename.reset(); setEditing(true); }}
          >
            ✎
          </button>
        ) : null}
      </h2>
    );
  }
  return (
    <form
      className="rename"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = draft.trim();
        if (!trimmed || rename.isPending) return;
        if (trimmed === name) { setEditing(false); return; }
        rename.mutate(trimmed);
      }}
    >
      <input aria-label="Room name" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <button type="submit" disabled={rename.isPending || !draft.trim()}>Save</button>
      <button type="button" className="ghost" onClick={() => setEditing(false)}>Cancel</button>
      <ErrorBanner error={rename.error} />
    </form>
  );
}
```

Run: `timeout 60 npx vitest run src/rooms/RenameTitle.spec.tsx`
Expected: PASS.

- [ ] **Step 4: Write the failing `RosterPanel` tests**

`src/rooms/RosterPanel.spec.tsx`:

```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { Member } from '../api/types';
import { renderWithClient } from '../testUtils';
import { RosterPanel } from './RosterPanel';

const members: Member[] = [
  { endpoint_id: 'ep_web', role: 'owner', response_mode: null, added_at: 't' },
  { endpoint_id: 'ep_claude', role: 'member', response_mode: 'joins', added_at: 't' },
  { endpoint_id: 'ep_old', role: 'member', response_mode: null, added_at: 't' },
];

describe('RosterPanel', () => {
  it('shows role and mode badges and no controls for a non-manager', () => {
    renderWithClient(<RosterPanel roomId="room_1" members={members} manager={false} />, {});
    expect(screen.getByText('ep_claude')).toBeInTheDocument();
    expect(screen.getByText('joins')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('gives a manager a mode select on agent rows only', () => {
    renderWithClient(<RosterPanel roomId="room_1" members={members} manager />, {});
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(screen.getByLabelText('Response mode for ep_claude')).toHaveValue('joins');
  });

  it('changes the mode and refetches the roster', async () => {
    const setResponseMode = vi.fn(async () => ({ ...members[1]!, response_mode: 'mentions_only' as const }));
    const { queryClient } = renderWithClient(<RosterPanel roomId="room_1" members={members} manager />, { setResponseMode });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await userEvent.selectOptions(screen.getByLabelText('Response mode for ep_claude'), 'mentions_only');
    await vi.waitFor(() => expect(setResponseMode).toHaveBeenCalledWith('room_1', 'ep_claude', 'mentions_only'));
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['room', 'room_1', 'members'] }));
  });

  it('shows the relay refusal and refetches when the caller is not a manager', async () => {
    const setResponseMode = vi.fn(async () => { throw new ApiError('ROUTE_NOT_AUTHORIZED', 403, 'no'); });
    const { queryClient } = renderWithClient(<RosterPanel roomId="room_1" members={members} manager />, { setResponseMode });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await userEvent.selectOptions(screen.getByLabelText('Response mode for ep_claude'), 'router');
    expect(await screen.findByRole('alert')).toHaveTextContent('Only room managers can do this');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['room', 'room_1', 'members'] });
  });
});
```

Run: `timeout 60 npx vitest run src/rooms/RosterPanel.spec.tsx`
Expected: FAIL (`Failed to resolve import "./RosterPanel"`).

- [ ] **Step 5: Implement `RosterPanel.tsx`**

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import type { Member, ResponseMode } from '../api/types';
import { ErrorBanner } from '../errors/ErrorBanner';
import { membersKey } from './useMembers';

const MODES: ResponseMode[] = ['joins', 'mentions_only', 'router'];

export function RosterPanel({ roomId, members, manager }: { roomId: string; members: Member[]; manager: boolean }) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const setMode = useMutation({
    mutationFn: ({ endpointId, mode }: { endpointId: string; mode: ResponseMode }) => client.setResponseMode(roomId, endpointId, mode),
    // Refetch on success and on failure: a refusal means the roster the user sees is stale.
    onSettled: () => queryClient.invalidateQueries({ queryKey: membersKey(roomId) }),
  });
  return (
    <section className="roster" aria-label="Roster">
      <ul>
        {members.map((member) => (
          <li key={member.endpoint_id}>
            <span className="member-id">{member.endpoint_id}</span>
            <span className="badge">{member.role}</span>
            {member.response_mode !== null ? (
              manager ? (
                <select
                  aria-label={`Response mode for ${member.endpoint_id}`}
                  value={member.response_mode}
                  disabled={setMode.isPending}
                  onChange={(event) => setMode.mutate({ endpointId: member.endpoint_id, mode: event.target.value as ResponseMode })}
                >
                  {MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                </select>
              ) : (
                <span className="badge">{member.response_mode}</span>
              )
            ) : null}
          </li>
        ))}
      </ul>
      <ErrorBanner error={setMode.error} />
    </section>
  );
}
```

Run: `timeout 60 npx vitest run src/rooms/RosterPanel.spec.tsx`
Expected: PASS. (A role badge reading `member` never collides with the `getByText('joins')` assertion.)

- [ ] **Step 6: Write the failing `RoomHeader` tests**

`src/rooms/RoomHeader.spec.tsx`:

```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { Member } from '../api/types';
import { renderWithClient } from '../testUtils';
import { RoomHeader } from './RoomHeader';

const members: Member[] = [
  { endpoint_id: 'ep_web', role: 'owner', response_mode: null, added_at: 't' },
  { endpoint_id: 'ep_claude', role: 'member', response_mode: 'joins', added_at: 't' },
];
const listMembers = vi.fn(async () => members);

describe('RoomHeader', () => {
  it('posts Stop and disables the button while the request runs', async () => {
    let finish!: (value: { code: string; cancelled: number }) => void;
    const stopRoom = vi.fn(() => new Promise<{ code: string; cancelled: number }>((resolve) => { finish = resolve; }));
    renderWithClient(<RoomHeader roomId="room_1" name="build" sender="ep_web" onGone={() => {}} />, { listMembers, stopRoom });
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(stopRoom).toHaveBeenCalledWith('room_1');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    finish({ code: 'OK', cancelled: 0 });
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled());
  });

  it('returns to the list when Stop answers ROOM_NOT_FOUND', async () => {
    const onGone = vi.fn();
    const stopRoom = vi.fn(async () => { throw new ApiError('ROOM_NOT_FOUND', 404, 'gone'); });
    renderWithClient(<RoomHeader roomId="room_1" name="build" sender="ep_web" onGone={onGone} />, { listMembers, stopRoom });
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await vi.waitFor(() => expect(onGone).toHaveBeenCalled());
  });

  it('shows rename and editable modes to a manager, and neither before the sender is known', async () => {
    const first = renderWithClient(<RoomHeader roomId="room_1" name="build" sender="ep_web" onGone={() => {}} />, { listMembers });
    expect(await screen.findByRole('button', { name: 'Rename room' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Roster' }));
    expect(await screen.findByLabelText('Response mode for ep_claude')).toBeInTheDocument();
    first.unmount();
    renderWithClient(<RoomHeader roomId="room_1" name="build" sender={null} onGone={() => {}} />, { listMembers });
    await userEvent.click(screen.getByRole('button', { name: 'Roster' }));
    expect(await screen.findByText('ep_claude')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename room' })).toBeNull();
    expect(screen.queryByLabelText('Response mode for ep_claude')).toBeNull();
  });
});
```

Run: `timeout 60 npx vitest run src/rooms/RoomHeader.spec.tsx`
Expected: FAIL (`Failed to resolve import "./RoomHeader"`).

- [ ] **Step 7: Implement `RoomHeader.tsx`**

```tsx
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../errors/ErrorBanner';
import { RenameTitle } from './RenameTitle';
import { RosterPanel } from './RosterPanel';
import { isManager } from './roles';
import { useMembers } from './useMembers';

export function RoomHeader({ roomId, name, sender, onGone }: { roomId: string; name: string; sender: string | null; onGone: () => void }) {
  const { client } = useAuth();
  const members = useMembers(roomId);
  const [showRoster, setShowRoster] = useState(false);
  const manager = isManager(members.data ?? [], sender);
  const stop = useMutation({
    mutationFn: () => client.stopRoom(roomId),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') onGone();
    },
  });
  return (
    <header className="room-header">
      <RenameTitle roomId={roomId} name={name} canRename={manager} onGone={onGone} />
      <div className="room-actions">
        <button type="button" className="ghost" aria-expanded={showRoster} onClick={() => setShowRoster((open) => !open)}>Roster</button>
        <button type="button" className="danger" disabled={stop.isPending} onClick={() => stop.mutate()}>Stop</button>
      </div>
      <ErrorBanner error={stop.error} />
      {showRoster ? <RosterPanel roomId={roomId} members={members.data ?? []} manager={manager} /> : null}
    </header>
  );
}
```

Run: `timeout 60 npx vitest run src/rooms/RoomHeader.spec.tsx`
Expected: PASS.

- [ ] **Step 8: Mount the header in `RoomView`**

In `src/App.tsx` add imports `import { useQuery } from '@tanstack/react-query';` (extend the existing `@tanstack/react-query` import), `import { getSender } from './auth/tokenStore';`, and `import { RoomHeader } from './rooms/RoomHeader';`. In `RoomView`, add at the top of the body:

```tsx
  const { client } = useAuth();
  const rooms = useQuery({ queryKey: ['rooms'], queryFn: () => client.listRooms() });
  const roomName = rooms.data?.find((room) => room.conversation_id === roomId)?.name ?? roomId;
```

and render the header as the first child of `<div className="room">`, before `room-body`:

```tsx
      <RoomHeader roomId={roomId} name={roomName} sender={getSender()} onGone={onGone} />
```

`getSender()` is read on every render, so the rename button and the roster controls appear after the first send re-renders `RoomView`.

- [ ] **Step 9: Add styles**

Append to `src/styles.css`:

```css
/* ROOM HEADER */
.room-header { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; padding: 0.75rem 1.25rem; border-bottom: 1px solid var(--border); }
.room-title { margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 0.4rem; }
.room-actions { display: flex; gap: 0.5rem; margin-left: auto; }
.room-header .danger { border-color: var(--danger); color: var(--danger); }
.rename { display: flex; align-items: center; gap: 0.5rem; }
.roster { flex-basis: 100%; }
.roster ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
.roster li { display: flex; align-items: center; gap: 0.6rem; }
.badge { padding: 0.05rem 0.5rem; border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--muted); font-size: 0.8rem; }
```

- [ ] **Step 10: Run the package checks**

Run: `timeout 240 npx vitest run && timeout 120 npm run typecheck && timeout 180 npm run build`
Expected: PASS, typecheck clean, build succeeds.

- [ ] **Step 11: Commit**

```bash
git add packages/sigil-rooms-web/src
git commit -m "feat(web): add room header with Stop, roster panel, and inline rename

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: End-to-end coverage, docs, and the web CI check

**Files:**
- Modify: `packages/sigil-rooms-web/e2e/relayHarness.ts`
- Modify: `packages/sigil-rooms-web/e2e/rooms.e2e.ts`
- Modify: `packages/sigil-rooms-web/README.md`

**Interfaces:**
- Consumes: everything above, through the built bundle.
- Produces: a `Harness.agentEndpointId` field (the `claude` agent endpoint the harness already creates) and an end-to-end test covering rename, a thread reply, Stop, and a response-mode change.

- [ ] **Step 1: Find the agent endpoint ID field**

The harness creates the agent with `sigil(dir, ['init', 'claude', '--owner', 'usr_web@local', '--kind', 'agent'])` but never reads its endpoint ID. Run in a scratch directory (not the repo):

```bash
mkdir -p "$TMP/sigil-id-probe" && cd "$TMP/sigil-id-probe" && node C:/dev/.worktrees/sigil-4b2-spec/bin/sigil.mjs init claude --owner usr_web@local --kind agent && node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('.sigil/claude.identity.json','utf8'))))"
```

Expected: a key list that includes `relay_token` and an endpoint ID key (named `endpoint_id` unless the output shows otherwise). Use the key the output shows in Step 2. Remove the probe directory afterwards.

- [ ] **Step 2: Expose the agent endpoint ID from the harness**

In `e2e/relayHarness.ts`, add `agentEndpointId: string;` to the `Harness` interface. After the `identity` constant add:

```ts
  const agentIdentity = JSON.parse(readFileSync(path.join(dir, '.sigil', 'claude.identity.json'), 'utf8')) as { endpoint_id: string };
```

(use the key name from Step 1 if it differs), and include `agentEndpointId: agentIdentity.endpoint_id,` in the returned object next to `roomId`.

- [ ] **Step 3: Write the end-to-end test**

Append to `e2e/rooms.e2e.ts`:

```ts
test('rename, thread reply, Stop, and a response-mode change', async ({ page }) => {
  await page.goto(harness.webOrigin);
  await page.getByLabel('Bearer token').fill(harness.humanToken);
  await page.getByRole('button', { name: 'Connect' }).click();

  // A fresh room keeps the shared e2e-room name intact for the other tests.
  await page.getByLabel('New room name').fill('manage-me');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'manage-me' })).toBeVisible();

  // The first send teaches the client its own endpoint ID, which unlocks rename and the mode controls.
  await page.getByLabel('Message', { exact: true }).fill('thread root');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('thread root')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rename room' })).toBeVisible();

  // Thread: the reply shows in the panel and not in the main timeline.
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  const thread = page.getByLabel('Thread');
  await thread.getByLabel('Reply in thread').fill('a threaded reply');
  await thread.getByRole('button', { name: 'Send' }).click();
  await expect(thread.getByText('a threaded reply')).toBeVisible();
  await expect(page.getByLabel('Messages').getByText('a threaded reply')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '1 reply' })).toBeVisible();
  await thread.getByRole('button', { name: 'Close' }).click();

  // Stop with nothing running answers 200 and leaves the button usable.
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);

  // Response mode: add the agent from Node, then change its mode in the roster.
  const roomsResponse = await fetch(`${harness.relayUrl}/v1/rooms`, { headers: { authorization: `Bearer ${harness.humanToken}` } });
  const { items } = (await roomsResponse.json()) as { items: Array<{ conversation_id: string; name: string }> };
  const roomId = items.find((room) => room.name === 'manage-me')!.conversation_id;
  const added = await fetch(`${harness.relayUrl}/v1/rooms/${roomId}/members`, {
    method: 'POST',
    headers: { authorization: `Bearer ${harness.humanToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint_id: harness.agentEndpointId, response_mode: 'joins' }),
  });
  expect(added.status).toBe(201);
  await page.getByRole('button', { name: 'Roster' }).click();
  const select = page.getByLabel(`Response mode for ${harness.agentEndpointId}`);
  await expect(select).toHaveValue('joins');
  await select.selectOption('mentions_only');
  await expect(select).toHaveValue('mentions_only');
  const members = (await (await fetch(`${harness.relayUrl}/v1/rooms/${roomId}/members`, { headers: { authorization: `Bearer ${harness.humanToken}` } })).json()) as { items: Array<{ endpoint_id: string; response_mode: string | null }> };
  expect(members.items.find((member) => member.endpoint_id === harness.agentEndpointId)?.response_mode).toBe('mentions_only');

  // Rename: the sidebar follows.
  await page.getByRole('button', { name: 'Rename room' }).click();
  await page.getByLabel('Room name').fill('renamed-room');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'renamed-room', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'renamed-room' })).toBeVisible();
});
```

- [ ] **Step 4: Build and run the end-to-end suite**

Run: `cd packages/sigil-rooms-web && timeout 180 npm run build && timeout 300 npm run test:e2e`
Expected: both end-to-end tests PASS. A first run may need `npx playwright install chromium`. If a selector fails, fix the test or the component, not the assertion's intent, and report which one changed. If the e2e cannot run in this environment, report it as unrun.

- [ ] **Step 5: Update the README**

In `README.md`, replace the two sentences under `## What it does` with:

```
Paste-token login, room list, timeline, send, ack, live updates through `room.updated`, create and pin rooms, threads in a side panel, Stop, a roster panel, and room rename.

Threads open from a message's Reply button. Replies stay out of the main timeline, and the client acknowledges only the rows it has shown, so an unread reply holds back read receipts for later messages until its thread is opened. Stop cancels the room's queued and running invocations. Room managers (owner and room manager) can rename the room and change an agent's response mode. The client learns its own endpoint ID from its first successful send, so rename and the mode controls appear after the first message.
```

- [ ] **Step 6: Run the whole web package once, then the relay suite once**

Run, one after the other: `cd packages/sigil-rooms-web && timeout 300 npx vitest run && timeout 120 npm run typecheck`, then from the repo root `timeout 600 npm test`. Confirm `npm pack --dry-run --ignore-scripts` still lists no `packages/` files:
`timeout 120 npm pack --dry-run --ignore-scripts 2>&1 | grep -c "packages/"`
Expected: unit suite PASS, typecheck clean, core suite no new failures, pack count `0`.

- [ ] **Step 7: Commit**

```bash
git add packages/sigil-rooms-web/e2e packages/sigil-rooms-web/README.md
git commit -m "test(web): cover rename, threads, Stop, and response modes end to end

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage**

- Rename route, `room` frame, contract: Task 2. Response-mode route, router-not-refused pin, phase 1 null-mode agents: Task 3. Repository methods in both repositories, Postgres test: Task 1.
- Client API methods, types, `useLive` per-value dispatch (`members` invalidates roster and `['rooms']`): Task 4.
- Canonical thread root with chain walk, reply counts, ack watermark with the interleaved example and the zero case: Task 5.
- Thread id on pending and retried sends: Task 6. Main timeline hides replies, panel with placeholder root, pending rows split by thread, Composer label: Task 7.
- Stop, roster panel, manager-only controls, inline rename and its errors: Task 8. End-to-end and README: Task 9.
- Spec out-of-scope items (member add and remove UI, `room.event` for rename, `GET /v1/me`, unread badges) have no task, by design.

**Spec corrections made while planning** (already applied to the spec in this branch): the room name lives in `rooms`, not `conversations`; `renameRoom` takes no `now`; the rename route runs no transaction, so the rollback test became a conflict test; the router open item is resolved as "not refused".

**Known limits to keep in mind**

- Agents with a null `response_mode` (phase 1 rooms) show no mode control, because the roster response carries no agent flag. The relay accepts a mode for them (Task 3), so a CLI can set one.
- Replies hold back read receipts for later top-level messages until their thread opens. The spec accepts this.
- `getSender()` stays null until the first send, so a manager sees no rename button and no mode selects before then. The relay still authorizes.
