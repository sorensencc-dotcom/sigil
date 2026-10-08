# Sigil rooms phase 4b-1 web client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@sorensencc/sigil-rooms-web`, a React client that logs in with a pasted bearer token, lists rooms, shows the timeline, sends messages, acks, and updates live through the 4a relay surface.

**Architecture:** A Vite/React/TypeScript package in `packages/sigil-rooms-web/`. TanStack Query owns server state. A WebSocket module turns `room.updated` frames into query invalidations. A tiny Node `http` server (`sigil-rooms-web` bin) serves the built bundle with a CSP header and a `/config.json` that tells the bundle the relay and stream URLs. The relay is untouched except one core audit exclusion.

**Tech Stack:** TypeScript, React 19, Vite, Vitest, Testing Library, jsdom, `@tanstack/react-query` 5, Playwright. Node 22+.

**Spec:** `docs/superpowers/specs/2026-10-07-sigil-rooms-phase-4b1-web-client-design.md`

## Global Constraints

- The relay stays plain Node `.mjs`. Core gets no UI assets and no `workspaces` field in the root `package.json`.
- Web test files are named `*.spec.ts` or `*.spec.tsx`, never `*.test.ts`. On Node 24 core's `node --test` also matches `*.test.ts` and would run them. No `test/` or `tests/` directory and no file named `test.ts` or `test-*.ts` in the package.
- Message text renders as plain text only: no `dangerouslySetInnerHTML`, no markdown, no link rendering.
- The bearer token lives in `sessionStorage` only. Never `localStorage`, never a URL.
- The client sends only the `authorization` and `content-type` request headers. The relay's CORS allows exactly those two (`sigil/relay/v1/browser-cors.mjs:22`). This corrects the spec line that says the client sends `X-Sigil-Request-Id`; Task 2 fixes the spec.
- History pages use `limit=100` and repeat until a page returns fewer than 100 rows.
- `room_seq` can arrive as a string (it is `int8`). The client compares and sorts it as `BigInt` and sends it back as a string.
- The ack call fires only while `document.visibilityState === 'visible'`.
- Send retries reuse the same `idempotency_key`.
- Every commit message ends with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Run `npm test` in the sigil repo root at most once at a time and never in the background alongside another run (the full suite takes about 40 seconds with Postgres tests skipped; overlapping runs deadlock the shared pg).

## Prerequisites

- PR #33 (4a) and PR #34 (this spec) are merged to `main`. Work in a fresh worktree off `main`: `git worktree add C:\dev\.worktrees\sigil-4b1 -b feat/sigil-rooms-phase-4b1 origin/main`, then `npm ci --ignore-scripts` in it.
- Task 1 step 1 verifies the 4a contract entries before any client code.

## File structure

```
packages/sigil-rooms-web/
  package.json            own deps and scripts; private
  tsconfig.json
  vite.config.ts          build + vitest config
  index.html
  playwright.config.ts
  bin/sigil-rooms-web.mjs CLI entry for the static server
  serve/server.mjs        createWebServer({distDir, relayUrl, streamUrl}) -> http.Server
  src/
    main.tsx              mounts <App/>
    App.tsx               providers + gate + shell
    config.ts             loadConfig() reads /config.json
    api/types.ts          wire types
    api/client.ts         createClient(), ApiError
    api/client.spec.ts
    api/contract.spec.ts  checks types' routes/fields against relay-api.json
    auth/tokenStore.ts    sessionStorage token + sender
    auth/tokenStore.spec.ts
    auth/AuthContext.tsx  token state, signOut, client instance
    auth/TokenGate.tsx
    auth/TokenGate.spec.tsx
    rooms/seq.ts          BigInt helpers for room_seq
    rooms/seq.spec.ts
    rooms/mergeRows.ts    Map-by-room_seq merge, pending rows
    rooms/mergeRows.spec.ts
    rooms/RoomList.tsx
    rooms/RoomList.spec.tsx
    rooms/historyQuery.ts historyKey() and fetchHistory(): the paged read shared by useHistory and useSend
    rooms/useHistory.ts   useQuery over fetchHistory
    rooms/Timeline.tsx
    rooms/Timeline.spec.tsx
    rooms/useAck.ts
    rooms/useAck.spec.tsx
    rooms/Composer.tsx
    rooms/Composer.spec.tsx
    live/socket.ts        LiveSocket class
    live/socket.spec.ts
    live/useLive.ts       hook wiring LiveSocket to the query client
    errors/ErrorBanner.tsx
  e2e/rooms.e2e.ts        Playwright
  README.md
```

Core files touched: `dep-audit-lib.mjs` (+ its test), root `package.json` (`test:web` script), `.github/workflows/ci.yml` (web job), `.gitignore`, and the spec (header correction).

---

### Task 1: Scaffold the package and keep core gates green

**Files:**
- Create: `packages/sigil-rooms-web/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/smoke.spec.ts`
- Modify: `dep-audit-lib.mjs:14`, `dep-audit-lib.test.mjs`, `package.json` (root), `.github/workflows/ci.yml`, `.gitignore`

**Interfaces:**
- Produces: the `packages/sigil-rooms-web` package with `npm test`, `npm run typecheck`, `npm run build`; root script `test:web`; a CI job `web`.

- [ ] **Step 1: Verify the 4a contract entries and the envelope sender name**

Run from the worktree root:

```bash
node -e "
const j=JSON.parse(require('fs').readFileSync('sigil/contracts/v1/relay-api.json','utf8'));
const need=['/v1/rooms/ws-ticket','/v1/rooms/{room_id}/ack','/v1/rooms/{room_id}/messages'];
for(const p of need) if(!j.routes.some(r=>r.path.startsWith(p))) throw new Error('missing '+p);
if(!j.stream_frames.some(f=>f.type==='room.updated')) throw new Error('missing room.updated');
console.log('contract ok');
"
grep -n "sender: {" sigil/relay/v1/room-ack-route.test.mjs | head -2
```

Expected: `contract ok`, and a line showing `sender: { endpoint_id: 'ep_web', owner_id: 'usr_chris' }`, which confirms the envelope field is `sender.endpoint_id`. If either fails, stop: #33 is not merged.

- [ ] **Step 2: Write the failing core-audit test**

Core's `sigil-dep-audit.mjs` scans every `.ts` and `.tsx` file under the repo and would flag the web package's imports as undeclared. Add a test to `dep-audit-lib.test.mjs` first. Read the file's existing helper style, then append:

```js
test('runDepAudit ignores the packages/ directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-audit-packages-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }));
  fs.mkdirSync(path.join(dir, 'packages', 'web', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'packages', 'web', 'src', 'a.tsx'), "import React from 'react';\n");
  const result = runDepAudit(dir);
  assert.equal(result.pass, true);
  assert.deepEqual(result.issues.filter((issue) => issue.code === 'HOISTED_DEPENDENCY_GAP'), []);
});
```

If the file does not already import `fs`, `path`, `os`, `runDepAudit`, `test`, and `assert`, add the missing imports at the top, matching its existing import style.

- [ ] **Step 3: Run it and watch it fail**

Run: `node --test --test-timeout=30000 dep-audit-lib.test.mjs`
Expected: the new test FAILS with a `HOISTED_DEPENDENCY_GAP` for `react`.

- [ ] **Step 4: Exclude `packages` from the core audit**

In `dep-audit-lib.mjs:14`, add `'packages'` to `EXCLUDED_DIRS`:

```js
const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.github', '.nlm_pack', '_kb-sync-staging', '_quarantine', 'dist', 'build', 'coverage', 'CIC-GOVERNANCE', 'packages']);
```

- [ ] **Step 5: Run it and watch it pass**

Run: `node --test --test-timeout=30000 dep-audit-lib.test.mjs`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Create the package files**

`packages/sigil-rooms-web/package.json`:

```json
{
  "name": "@sorensencc/sigil-rooms-web",
  "version": "0.1.0",
  "private": true,
  "description": "Browser client for Sigil rooms",
  "type": "module",
  "bin": { "sigil-rooms-web": "bin/sigil-rooms-web.mjs" },
  "files": ["bin/", "serve/", "dist/"],
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@tanstack/react-query": "5.104.1",
    "react": "19.3.0",
    "react-dom": "19.3.0"
  },
  "devDependencies": {
    "@playwright/test": "1.64.0",
    "@testing-library/jest-dom": "6.6.3",
    "@testing-library/react": "16.3.3",
    "@testing-library/user-event": "14.6.1",
    "@types/node": "22.15.0",
    "@types/react": "19.1.0",
    "@types/react-dom": "19.1.0",
    "@vitejs/plugin-react": "6.1.2",
    "jsdom": "30.1.2",
    "typescript": "7.0.2",
    "vite": "8.3.3",
    "vitest": "5.0.3"
  }
}
```

Versions are the latest published at planning time (2026-10-07) for the packages checked with `npm view`; the three `@testing-library/jest-dom`, `user-event`, and `@types/*` pins are best guesses. Step 7 installs them; if `npm install` reports an unknown version, replace it with the version `npm view <name> version` prints and note the change in the commit message.

`packages/sigil-rooms-web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["vite/client", "vitest/globals", "node"]
  },
  "include": ["src", "e2e", "vite.config.ts", "playwright.config.ts"]
}
```

`packages/sigil-rooms-web/vite.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.spec.{ts,tsx}'],
    setupFiles: ['./src/setupTests.ts'],
  },
});
```

`packages/sigil-rooms-web/src/setupTests.ts`:

```ts
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
```

`packages/sigil-rooms-web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sigil rooms</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`packages/sigil-rooms-web/src/smoke.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('test environment', () => {
  it('runs in jsdom with sessionStorage', () => {
    sessionStorage.setItem('k', 'v');
    expect(sessionStorage.getItem('k')).toBe('v');
  });
});
```

Add to the root `.gitignore`:

```
packages/*/dist/
packages/*/test-results/
packages/*/playwright-report/
```

(`node_modules/` is already ignored.)

- [ ] **Step 7: Install and run the smoke test**

Run:

```bash
cd packages/sigil-rooms-web && npm install && npm test
```

Expected: `1 passed`. Commit the generated `packages/sigil-rooms-web/package-lock.json`.

- [ ] **Step 8: Prove core's `node --test` does not pick up web tests**

Create two temporary files and run the core suite:

```bash
printf "throw new Error('PROBE_SPEC');\n" > packages/sigil-rooms-web/src/probe.spec.ts
printf "throw new Error('PROBE_TEST');\n" > packages/sigil-rooms-web/src/probe.test.ts
LOG="$(mktemp)"
timeout 300 node --test --test-timeout=30000 > "$LOG" 2>&1
grep -o -E "PROBE_SPEC|PROBE_TEST" "$LOG" | sort | uniq -c
rm packages/sigil-rooms-web/src/probe.spec.ts packages/sigil-rooms-web/src/probe.test.ts "$LOG"
```

Expected: `PROBE_TEST` appears (positive control: Node 24 picks up `*.test.ts`) and `PROBE_SPEC` does not appear. If `PROBE_TEST` does not appear, the probe is not working (Node 22 does not match `.ts`); the `.spec` convention stays either way. If `PROBE_SPEC` appears, stop and escalate: core would run web tests. Both probe files must be deleted before continuing.

- [ ] **Step 9: Prove `npm pack` excludes `packages/`**

Run from the repo root: `npm pack --dry-run 2>&1 | grep -c "packages/"`
Expected: `0`.

- [ ] **Step 10: Run the core audits**

Run from the repo root: `node sigil-dep-audit.mjs && node sigil-jcs-audit.mjs`
Expected: both exit 0.

- [ ] **Step 11: Add the root script and the CI job**

In the root `package.json` scripts, after `test:live`, add:

```json
"test:web": "npm --prefix packages/sigil-rooms-web ci && npm --prefix packages/sigil-rooms-web run typecheck && npm --prefix packages/sigil-rooms-web test && npm --prefix packages/sigil-rooms-web run build",
```

In `.github/workflows/ci.yml`, append a job after `test-windows` (same indentation as the other jobs):

```yaml
  web:
    name: Web client
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: packages/sigil-rooms-web
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Node.js 24.x
        uses: actions/setup-node@v4
        with:
          node-version: 24.x
          cache: 'npm'
          cache-dependency-path: packages/sigil-rooms-web/package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Unit tests
        run: npm test

      - name: Build
        run: npm run build
```

The end-to-end job joins this one in Task 10.

- [ ] **Step 12: Run the web gate locally**

Run from the repo root: `npm run test:web`
Expected: typecheck passes with no output errors, `1 passed`, and a `dist/` build. (The build needs `src/main.tsx`; if it fails for that reason, create `src/main.tsx` containing `export {};` for now. Task 3 replaces it.)

- [ ] **Step 13: Commit**

```bash
git add dep-audit-lib.mjs dep-audit-lib.test.mjs package.json .github/workflows/ci.yml .gitignore packages/sigil-rooms-web
git commit -m "feat(web): scaffold sigil-rooms-web package and keep core gates green

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Wire types, API client, and contract test

**Files:**
- Create: `packages/sigil-rooms-web/src/api/types.ts`, `src/api/client.ts`, `src/api/client.spec.ts`, `src/api/contract.spec.ts`
- Modify: `docs/superpowers/specs/2026-10-07-sigil-rooms-phase-4b1-web-client-design.md` (header correction)

**Interfaces:**
- Produces (`types.ts`): `Room`, `RoomEnvelope`, `HistoryItem`, `HistoryPage`, `SendResult`, `AckResult`, `TicketResult`, `RoomUpdatedFrame`.
- Produces (`client.ts`):
  - `class ApiError extends Error { code: string; status: number; requestId?: string }`
  - `createClient(options: { baseUrl: string; getToken: () => string | null; onUnauthorized?: () => void; fetchImpl?: typeof fetch }): ApiClient`
  - `ApiClient = { listRooms(): Promise<Room[]>; history(roomId: string, afterSeq: string, limit?: number): Promise<HistoryPage>; sendMessage(roomId: string, text: string, idempotencyKey: string): Promise<SendResult>; ack(roomId: string, upToRoomSeq: string): Promise<AckResult>; wsTicket(): Promise<TicketResult> }`

- [ ] **Step 1: Write the failing client tests**

`src/api/client.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createClient } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function make(fetchImpl: typeof fetch, token: string | null = 'tok', onUnauthorized = vi.fn()) {
  return { client: createClient({ baseUrl: 'http://relay.test', getToken: () => token, onUnauthorized, fetchImpl }), onUnauthorized };
}

describe('api client', () => {
  it('sends only authorization and content-type headers', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { code: 'OK', items: [] }));
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await client.listRooms();
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual(['authorization', 'content-type']);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('maps an error body to ApiError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { request_id: 'r1', code: 'ROOM_NOT_FOUND', message: 'Room not found' }));
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await expect(client.history('room_x', '0')).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND', status: 404, requestId: 'r1' });
  });

  it('calls onUnauthorized on any 401', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { request_id: 'r2', code: 'ANYTHING', message: 'no' }));
    const { client, onUnauthorized } = make(fetchImpl as unknown as typeof fetch);
    await expect(client.listRooms()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('maps a fetch failure to NETWORK', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await expect(client.listRooms()).rejects.toMatchObject({ code: 'NETWORK', status: 0 });
  });

  it('rejects without a token and does not call fetch', async () => {
    const fetchImpl = vi.fn();
    const { client } = make(fetchImpl as unknown as typeof fetch, null);
    await expect(client.listRooms()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('builds the history, send, ack, and ticket requests', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse(200, { code: 'OK', items: [], next_after_seq: '0', message_id: 'm', room_seq: '1', acknowledged: 0, ticket: 't', expires_at: 'e' });
    });
    const { client } = make(fetchImpl as unknown as typeof fetch);
    await client.history('room_1', '7', 100);
    await client.sendMessage('room_1', 'hi', 'key-1');
    await client.ack('room_1', '9');
    await client.wsTicket();
    expect(calls[0]![0]).toBe('http://relay.test/v1/rooms/room_1/messages?after_seq=7&limit=100');
    expect(calls[1]![0]).toBe('http://relay.test/v1/rooms/room_1/messages');
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ text: 'hi', idempotency_key: 'key-1' });
    expect(JSON.parse(calls[2]![1].body as string)).toEqual({ up_to_room_seq: '9' });
    expect(calls[3]![0]).toBe('http://relay.test/v1/rooms/ws-ticket');
    expect(calls[3]![1].method).toBe('POST');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/sigil-rooms-web && npx vitest run src/api/client.spec.ts`
Expected: FAIL, `Cannot find module './client'`.

- [ ] **Step 3: Write the types**

`src/api/types.ts`:

```ts
export interface Room {
  conversation_id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  created_at: string;
  max_agent_turns: number;
}

export interface RoomEnvelope {
  message_id: string;
  message_type: string;
  sender: { endpoint_id: string; owner_id: string };
  body: { text?: string; kind?: string; reason?: string; endpoint_ids?: string[] };
  created_at: string;
}

export interface HistoryItem {
  room_seq: string | number;
  message_id: string;
  canonical_bytes: string;
  envelope: RoomEnvelope;
}

export interface HistoryPage {
  code: string;
  items: HistoryItem[];
  next_after_seq: string | number;
}

export interface SendResult {
  code: string;
  message_id: string;
  room_seq: string | number | null;
}

export interface AckResult {
  code: string;
  acknowledged: number;
}

export interface TicketResult {
  code: string;
  ticket: string;
  expires_at: string;
}

export interface RoomUpdatedFrame {
  type: 'room.updated';
  room_id: string;
  room_seq?: string | number;
  changed: 'messages' | 'members';
}
```

- [ ] **Step 4: Write the client**

`src/api/client.ts`:

```ts
import type { AckResult, HistoryPage, Room, SendResult, TicketResult } from './types';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;
  constructor(code: string, status: number, message: string, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

export interface ClientOptions {
  baseUrl: string;
  getToken: () => string | null;
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
}

export interface ApiClient {
  listRooms(): Promise<Room[]>;
  history(roomId: string, afterSeq: string, limit?: number): Promise<HistoryPage>;
  sendMessage(roomId: string, text: string, idempotencyKey: string): Promise<SendResult>;
  ack(roomId: string, upToRoomSeq: string): Promise<AckResult>;
  wsTicket(): Promise<TicketResult>;
}

export function createClient({ baseUrl, getToken, onUnauthorized, fetchImpl = (...args) => fetch(...args) }: ClientOptions): ApiClient {
  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const token = getToken();
    if (!token) throw new ApiError('UNAUTHENTICATED', 401, 'No token');
    let response: Response;
    try {
      // Only authorization and content-type: the relay's CORS allows exactly those.
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError('NETWORK', 0, `Can't reach relay at ${baseUrl}. Check --browser-origin.`);
    }
    const text = await response.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!response.ok) {
      if (response.status === 401) onUnauthorized?.();
      throw new ApiError(parsed?.code ?? `HTTP_${response.status}`, response.status, parsed?.message ?? response.statusText, parsed?.request_id);
    }
    return parsed as T;
  }

  return {
    async listRooms() {
      return (await request<{ items: Room[] }>('GET', '/v1/rooms')).items;
    },
    history(roomId, afterSeq, limit = 100) {
      return request<HistoryPage>('GET', `/v1/rooms/${encodeURIComponent(roomId)}/messages?after_seq=${encodeURIComponent(afterSeq)}&limit=${limit}`);
    },
    sendMessage(roomId, text, idempotencyKey) {
      return request<SendResult>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/messages`, { text, idempotency_key: idempotencyKey });
    },
    ack(roomId, upToRoomSeq) {
      return request<AckResult>('POST', `/v1/rooms/${encodeURIComponent(roomId)}/ack`, { up_to_room_seq: upToRoomSeq });
    },
    wsTicket() {
      return request<TicketResult>('POST', '/v1/rooms/ws-ticket');
    },
  };
}
```

- [ ] **Step 5: Run the client tests and watch them pass**

Run: `npx vitest run src/api/client.spec.ts`
Expected: 6 passed.

- [ ] **Step 6: Write the contract test**

`src/api/contract.spec.ts`. It asserts only what the contract JSON holds: route paths, field names, and error codes.

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(path.resolve(here, '../../../../sigil/contracts/v1/relay-api.json'), 'utf8')) as {
  routes: Array<{ method: string; path: string; errors?: string[]; item_fields?: string[]; request_fields?: string[]; response_fields?: string[] }>;
  stream_frames: Array<{ type: string; fields: string[]; changed_values?: string[] }>;
};

function route(method: string, pathPrefix: string) {
  const found = contract.routes.find((r) => r.method === method && r.path.startsWith(pathPrefix));
  if (!found) throw new Error(`contract has no ${method} ${pathPrefix}`);
  return found;
}

describe('relay-api.json still lists what the client calls', () => {
  it('lists every route the client calls', () => {
    route('GET', '/v1/rooms');
    route('GET', '/v1/rooms/{room_id}/messages');
    route('POST', '/v1/rooms/{room_id}/messages');
    route('POST', '/v1/rooms/{room_id}/ack');
    route('POST', '/v1/rooms/ws-ticket');
  });

  it('lists the history item fields the client reads', () => {
    const history = route('GET', '/v1/rooms/{room_id}/messages');
    for (const field of ['room_seq', 'message_id', 'canonical_bytes', 'envelope']) expect(history.item_fields).toContain(field);
  });

  it('lists the request and response fields the client uses', () => {
    expect(route('POST', '/v1/rooms/{room_id}/messages').request_fields).toEqual(expect.arrayContaining(['text', 'idempotency_key']));
    expect(route('POST', '/v1/rooms/{room_id}/ack').request_fields).toContain('up_to_room_seq');
    expect(route('POST', '/v1/rooms/{room_id}/ack').response_fields).toContain('acknowledged');
    expect(route('POST', '/v1/rooms/ws-ticket').response_fields).toEqual(expect.arrayContaining(['ticket', 'expires_at']));
  });

  it('lists each error code the client branches on', () => {
    const codes = new Set(contract.routes.flatMap((r) => r.errors ?? []));
    for (const code of ['UNAUTHENTICATED', 'HUMAN_CONTEXT_REQUIRED', 'DATABASE_UNAVAILABLE', 'ROOM_SEND_UNAVAILABLE', 'NO_SIGNING_KEY', 'ROOM_NOT_FOUND', 'TICKET_CAP', 'INVALID_ENVELOPE', 'INVALID_REQUEST']) {
      expect(codes.has(code), code).toBe(true);
    }
  });

  it('lists the room.updated frame fields', () => {
    const frame = contract.stream_frames.find((f) => f.type === 'room.updated');
    expect(frame?.fields).toEqual(expect.arrayContaining(['type', 'room_id', 'room_seq', 'changed']));
    expect(frame?.changed_values).toEqual(expect.arrayContaining(['messages', 'members']));
  });
});
```

- [ ] **Step 7: Run it**

Run: `npx vitest run src/api/contract.spec.ts`
Expected: 5 passed. If a field name check fails, the contract differs from this plan: read the failing route's entry in `sigil/contracts/v1/relay-api.json`, fix the plan's type or client to match the contract, and note the change in the commit.

- [ ] **Step 8: Correct the spec**

The spec file has CRLF line endings, so edit it with `sed -i`, not the Edit tool:

```bash
SPEC=docs/superpowers/specs/2026-10-07-sigil-rooms-phase-4b1-web-client-design.md
sed -i 's/Bearer header, X-Sigil-Request-Id; maps/Bearer header (only authorization and content-type are sent, because the relay CORS allows exactly those); maps/' "$SPEC"
sed -i 's/Web test files are `\*.test.ts` and `\*.test.tsx` under `src\/`/Web test files are `*.spec.ts` and `*.spec.tsx` under `src\/` (Node 24 `node --test` also matches `*.test.ts`)/' "$SPEC"
grep -c "X-Sigil-Request-Id" "$SPEC"; grep -c "spec.ts" "$SPEC"
```

Expected: the first count is `0`, the second is `1` or more. If the second `sed` did not match, find the sentence that names `*.test.ts` in the Testing section and fix it with a simpler `sed -i` pattern.

- [ ] **Step 9: Typecheck and commit**

Run: `npm run typecheck` (in the package). Expected: no errors.

```bash
git add packages/sigil-rooms-web docs/superpowers/specs
git commit -m "feat(web): add typed API client and contract test

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Token store, auth context, token gate, and app shell

**Files:**
- Create: `src/auth/tokenStore.ts`, `src/auth/tokenStore.spec.ts`, `src/auth/AuthContext.tsx`, `src/auth/TokenGate.tsx`, `src/auth/TokenGate.spec.tsx`, `src/config.ts`, `src/App.tsx`, `src/main.tsx` (replace), `src/errors/ErrorBanner.tsx`

**Interfaces:**
- Consumes: `createClient`, `ApiClient`, `ApiError` from `api/client`.
- Produces (`tokenStore.ts`): `getToken(): string | null`, `setToken(token: string): void`, `clearToken(): void`, `getSender(): string | null`, `setSender(endpointId: string): void`.
- Produces (`AuthContext.tsx`): `AuthProvider({ baseUrl, streamUrl, children })`, `useAuth(): { token: string | null; login(token: string): void; signOut(): void; client: ApiClient; streamUrl: string; rejected: boolean }`.
- Produces (`config.ts`): `loadConfig(fetchImpl?): Promise<{ relayUrl: string; streamUrl: string }>`.
- Produces (`ErrorBanner.tsx`): `ErrorBanner({ error }: { error: unknown })` rendering a message for an `ApiError`.

- [ ] **Step 1: Write the failing token-store tests**

`src/auth/tokenStore.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { clearToken, getSender, getToken, setSender, setToken } from './tokenStore';

describe('tokenStore', () => {
  it('keeps the token in sessionStorage and never in localStorage', () => {
    setToken('abc');
    expect(getToken()).toBe('abc');
    expect(sessionStorage.getItem('sigil.token')).toBe('abc');
    expect(localStorage.length).toBe(0);
  });

  it('clearToken removes the token and the sender', () => {
    setToken('abc');
    setSender('ep_web');
    clearToken();
    expect(getToken()).toBeNull();
    expect(getSender()).toBeNull();
  });

  it('trims the pasted token', () => {
    setToken('  abc \n');
    expect(getToken()).toBe('abc');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/auth/tokenStore.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the token store**

`src/auth/tokenStore.ts`:

```ts
const TOKEN_KEY = 'sigil.token';
const SENDER_KEY = 'sigil.sender';

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(SENDER_KEY);
}

export function getSender(): string | null {
  return sessionStorage.getItem(SENDER_KEY);
}

export function setSender(endpointId: string): void {
  sessionStorage.setItem(SENDER_KEY, endpointId);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/auth/tokenStore.spec.ts`
Expected: 3 passed.

- [ ] **Step 5: Write the failing TokenGate tests**

`src/auth/TokenGate.spec.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TokenGate } from './TokenGate';

describe('TokenGate', () => {
  it('submits the pasted token', async () => {
    const onSubmit = vi.fn();
    render(<TokenGate onSubmit={onSubmit} rejected={false} />);
    await userEvent.type(screen.getByLabelText(/bearer token/i), 'secret-token');
    await userEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(onSubmit).toHaveBeenCalledWith('secret-token');
  });

  it('does not submit an empty token', async () => {
    const onSubmit = vi.fn();
    render(<TokenGate onSubmit={onSubmit} rejected={false} />);
    await userEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows "Token rejected" after a 401', () => {
    render(<TokenGate onSubmit={() => {}} rejected />);
    expect(screen.getByRole('alert')).toHaveTextContent('Token rejected');
  });

  it('masks the token field', () => {
    render(<TokenGate onSubmit={() => {}} rejected={false} />);
    expect(screen.getByLabelText(/bearer token/i)).toHaveAttribute('type', 'password');
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run src/auth/TokenGate.spec.tsx`
Expected: FAIL, module not found.

- [ ] **Step 7: Write the gate, auth context, config, banner, and app shell**

`src/auth/TokenGate.tsx`:

```tsx
import { useState } from 'react';

export function TokenGate({ onSubmit, rejected }: { onSubmit: (token: string) => void; rejected: boolean }) {
  const [value, setValue] = useState('');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) onSubmit(value.trim());
      }}
    >
      <h1>Sigil rooms</h1>
      {rejected ? <p role="alert">Token rejected</p> : null}
      <label>
        Bearer token
        <input type="password" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
      <button type="submit">Connect</button>
    </form>
  );
}
```

`src/config.ts`:

```ts
export interface WebConfig {
  relayUrl: string;
  streamUrl: string;
}

export async function loadConfig(fetchImpl: typeof fetch = (...args) => fetch(...args)): Promise<WebConfig> {
  const response = await fetchImpl('/config.json');
  if (!response.ok) throw new Error(`config.json returned ${response.status}`);
  const parsed = (await response.json()) as Partial<WebConfig>;
  if (!parsed.relayUrl || !parsed.streamUrl) throw new Error('config.json needs relayUrl and streamUrl');
  return { relayUrl: parsed.relayUrl.replace(/\/$/, ''), streamUrl: parsed.streamUrl.replace(/\/$/, '') };
}
```

`src/auth/AuthContext.tsx`:

```tsx
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { createClient, type ApiClient } from '../api/client';
import { clearToken, getToken, setToken } from './tokenStore';

interface AuthValue {
  token: string | null;
  login(token: string): void;
  signOut(): void;
  client: ApiClient;
  streamUrl: string;
  rejected: boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ baseUrl, streamUrl, children }: { baseUrl: string; streamUrl: string; children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [rejected, setRejected] = useState(false);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const signOut = useCallback(() => {
    clearToken();
    setTokenState(null);
  }, []);

  const client = useMemo(
    () =>
      createClient({
        baseUrl,
        getToken: () => tokenRef.current,
        onUnauthorized: () => {
          setRejected(true);
          signOut();
        },
      }),
    [baseUrl, signOut],
  );

  const login = useCallback((next: string) => {
    setToken(next);
    setRejected(false);
    setTokenState(getToken());
  }, []);

  const value = useMemo(() => ({ token, login, signOut, client, streamUrl, rejected }), [token, login, signOut, client, streamUrl, rejected]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth outside AuthProvider');
  return value;
}
```

`src/errors/ErrorBanner.tsx`:

```tsx
import { ApiError } from '../api/client';

export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : 'Something went wrong';
  switch (error.code) {
    case 'HUMAN_CONTEXT_REQUIRED': return 'This token is not a human token';
    case 'ROOM_SEND_UNAVAILABLE': return 'Sending is not configured. Start the relay with --room-human-identity.';
    case 'NO_SIGNING_KEY': return 'This token\'s endpoint is not the identity loaded with --room-human-identity.';
    case 'DATABASE_UNAVAILABLE': return 'Rooms are unavailable (DATABASE_UNAVAILABLE)';
    case 'NETWORK': return error.message;
    default: return error.message || error.code;
  }
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  return <p role="alert">{describeError(error)}</p>;
}
```

`src/App.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from './api/client';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { TokenGate } from './auth/TokenGate';
import { loadConfig, type WebConfig } from './config';
import { ErrorBanner } from './errors/ErrorBanner';

function Shell() {
  const { token, login, signOut, rejected } = useAuth();
  if (!token) return <TokenGate onSubmit={login} rejected={rejected} />;
  return (
    <main>
      <header>
        <strong>Sigil rooms</strong> <button onClick={signOut}>Sign out</button>
      </header>
      <p>Connected.</p>
    </main>
  );
}

export function App() {
  const [config, setConfig] = useState<WebConfig | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    loadConfig().then(setConfig, setError);
  }, []);
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
          },
          mutations: { retry: false },
        },
      }),
    [],
  );
  if (error) return <ErrorBanner error={error} />;
  if (!config) return <p>Loading…</p>;
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider baseUrl={config.relayUrl} streamUrl={config.streamUrl}>
        <Shell />
      </AuthProvider>
    </QueryClientProvider>
  );
}
```

`src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 8: Run all web tests, typecheck, and commit**

Run: `npm test && npm run typecheck`
Expected: all tests pass (smoke 1, api 11, tokenStore 3, TokenGate 4), no type errors.

```bash
git add packages/sigil-rooms-web
git commit -m "feat(web): add token store, token gate, and app shell

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `room_seq` helpers and the row merge

**Files:**
- Create: `src/rooms/seq.ts`, `src/rooms/seq.spec.ts`, `src/rooms/mergeRows.ts`, `src/rooms/mergeRows.spec.ts`

**Interfaces:**
- Produces (`seq.ts`): `toSeq(value: string | number): bigint`, `maxSeq(values: Array<string | number>): string` (returns `'0'` for an empty list).
- Produces (`mergeRows.ts`):
  - `type Row = { key: string; seq: bigint | null; item: HistoryItem | null; pending?: PendingMessage }`
  - `mergeRows(history: HistoryItem[], pending: PendingMessage[]): Row[]`
  - `type PendingMessage = { idempotencyKey: string; text: string; status: 'sending' | 'failed'; error?: string; messageId?: string; retryable?: boolean }`

Merge rules: history items are keyed by `room_seq`; a duplicate `room_seq` keeps one row; rows sort by `room_seq` ascending; a pending message is dropped when a history item has the same `message_id` as the pending message's `messageId` (set from the POST result); the remaining pending rows sort after all history rows in the order they were created.

- [ ] **Step 1: Write the failing tests**

`src/rooms/seq.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { maxSeq, toSeq } from './seq';

describe('seq', () => {
  it('compares string and number room_seq as bigint', () => {
    expect(toSeq('9007199254740993')).toBeGreaterThan(toSeq(9007199254740992));
  });
  it('maxSeq returns the largest as a string and "0" for none', () => {
    expect(maxSeq(['2', 10, '9'])).toBe('10');
    expect(maxSeq([])).toBe('0');
  });
});
```

`src/rooms/mergeRows.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { HistoryItem } from '../api/types';
import { mergeRows, type PendingMessage } from './mergeRows';

function item(seq: string | number, id: string, text = 'x'): HistoryItem {
  return {
    room_seq: seq,
    message_id: id,
    canonical_bytes: 'b',
    envelope: { message_id: id, message_type: 'room.message', sender: { endpoint_id: 'ep_web', owner_id: 'u' }, body: { text }, created_at: '2026-10-07T00:00:00Z' },
  };
}

describe('mergeRows', () => {
  it('sorts by room_seq and dedupes duplicate sequences', () => {
    const rows = mergeRows([item('3', 'm3'), item(1, 'm1'), item('3', 'm3'), item('2', 'm2')], []);
    expect(rows.map((r) => r.key)).toEqual(['seq:1', 'seq:2', 'seq:3']);
  });

  it('tolerates out-of-order pages', () => {
    const rows = mergeRows([item('5', 'm5'), item('4', 'm4')], []);
    expect(rows.map((r) => r.seq)).toEqual([4n, 5n]);
  });

  it('appends pending rows after history', () => {
    const pending: PendingMessage[] = [{ idempotencyKey: 'k1', text: 'hello', status: 'sending' }];
    const rows = mergeRows([item(1, 'm1')], pending);
    expect(rows.map((r) => r.key)).toEqual(['seq:1', 'pending:k1']);
    expect(rows[1]!.pending?.status).toBe('sending');
  });

  it('drops a pending row once history holds its message_id', () => {
    const pending: PendingMessage[] = [{ idempotencyKey: 'k1', text: 'hello', status: 'sending', messageId: 'm2' }];
    const rows = mergeRows([item(1, 'm1'), item(2, 'm2')], pending);
    expect(rows.map((r) => r.key)).toEqual(['seq:1', 'seq:2']);
  });

  it('keeps a failed pending row', () => {
    const pending: PendingMessage[] = [{ idempotencyKey: 'k1', text: 'hello', status: 'failed', error: 'boom' }];
    expect(mergeRows([], pending)[0]!.pending).toMatchObject({ status: 'failed', error: 'boom' });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/rooms/seq.spec.ts src/rooms/mergeRows.spec.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/rooms/seq.ts`:

```ts
export function toSeq(value: string | number): bigint {
  return BigInt(value);
}

export function maxSeq(values: Array<string | number>): string {
  let max = 0n;
  for (const value of values) {
    const seq = toSeq(value);
    if (seq > max) max = seq;
  }
  return max.toString();
}
```

`src/rooms/mergeRows.ts`:

```ts
import type { HistoryItem } from '../api/types';
import { toSeq } from './seq';

export interface PendingMessage {
  idempotencyKey: string;
  text: string;
  status: 'sending' | 'failed';
  error?: string;
  messageId?: string;
  retryable?: boolean;
}

export interface Row {
  key: string;
  seq: bigint | null;
  item: HistoryItem | null;
  pending?: PendingMessage;
}

export function mergeRows(history: HistoryItem[], pending: PendingMessage[]): Row[] {
  const bySeq = new Map<string, Row>();
  for (const item of history) {
    const seq = toSeq(item.room_seq);
    bySeq.set(seq.toString(), { key: `seq:${seq}`, seq, item });
  }
  const rows = [...bySeq.values()].sort((a, b) => (a.seq! < b.seq! ? -1 : a.seq! > b.seq! ? 1 : 0));
  const knownIds = new Set(rows.map((row) => row.item!.message_id));
  for (const message of pending) {
    if (message.messageId && knownIds.has(message.messageId)) continue;
    rows.push({ key: `pending:${message.idempotencyKey}`, seq: null, item: null, pending: message });
  }
  return rows;
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/rooms/seq.spec.ts src/rooms/mergeRows.spec.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/sigil-rooms-web
git commit -m "feat(web): add room_seq helpers and the timeline row merge

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Room list and timeline

**Files:**
- Create: `src/rooms/RoomList.tsx`, `src/rooms/RoomList.spec.tsx`, `src/rooms/useHistory.ts`, `src/rooms/Timeline.tsx`, `src/rooms/Timeline.spec.tsx`, `src/testUtils.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `useAuth`, `ApiClient`, `mergeRows`, `maxSeq`, `ErrorBanner`.
- Produces (`historyQuery.ts`): `historyKey(roomId: string): readonly ['room', string, 'messages']`, and `fetchHistory(client: ApiClient, queryClient: QueryClient, roomId: string): Promise<HistoryItem[]>`. It loads from `after_seq=0`, keeps fetching pages until a page returns fewer than 100 rows, and on later calls asks only for rows after the highest `room_seq` already cached under `historyKey(roomId)`.
- Produces (`useHistory.ts`): `useHistory(roomId: string): { items: HistoryItem[]; isLoading: boolean; error: unknown; refetch(): Promise<unknown> }`, a `useQuery` over `fetchHistory`.
- Produces (`RoomList.tsx`): `RoomList({ selectedId, onSelect })`. Query key `['rooms']`.
- Produces (`Timeline.tsx`): `Timeline({ roomId, pending, onVisibleSeq, onGone })` where `pending: PendingMessage[]`, `onVisibleSeq(seq: string): void` reports the highest rendered `room_seq` (Task 7 uses it), and `onGone(): void` is called when history answers `404 ROOM_NOT_FOUND`.
- Produces (`testUtils.tsx`): `renderWithClient(ui, { client }: { client: Partial<ApiClient> })` that wraps `ui` in a `QueryClientProvider` (retry off) and an `AuthContext` test double. Because `AuthContext` is not exported, export a `TestAuthProvider({ client, children })` from `AuthContext.tsx` for this purpose.

- [ ] **Step 1: Export a test provider from AuthContext**

In `src/auth/AuthContext.tsx`, export the context and add a provider for tests:

```tsx
export function TestAuthProvider({ client, children, streamUrl = 'ws://stream.test' }: { client: ApiClient; children: ReactNode; streamUrl?: string }) {
  const value: AuthValue = { token: 'tok', login() {}, signOut() {}, client, streamUrl, rejected: false };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
```

`src/testUtils.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { ApiClient } from './api/client';
import { TestAuthProvider } from './auth/AuthContext';

export function renderWithClient(ui: ReactElement, client: Partial<ApiClient>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapped = (
    <QueryClientProvider client={queryClient}>
      <TestAuthProvider client={client as ApiClient}>{ui}</TestAuthProvider>
    </QueryClientProvider>
  );
  return { queryClient, ...render(wrapped) };
}
```

- [ ] **Step 2: Write the failing RoomList tests**

`src/rooms/RoomList.spec.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { renderWithClient } from '../testUtils';
import { RoomList } from './RoomList';

const rooms = [
  { conversation_id: 'room_1', workspace_id: 'ws', name: 'build', description: 'the build room', created_at: 't', max_agent_turns: 6 },
  { conversation_id: 'room_2', workspace_id: 'ws', name: 'ops', description: null, created_at: 't', max_agent_turns: 6 },
];

describe('RoomList', () => {
  it('lists rooms and reports a selection', async () => {
    const onSelect = vi.fn();
    renderWithClient(<RoomList selectedId={null} onSelect={onSelect} />, { listRooms: async () => rooms });
    await userEvent.click(await screen.findByRole('button', { name: /build/ }));
    expect(onSelect).toHaveBeenCalledWith('room_1');
  });

  it('shows an empty state', async () => {
    renderWithClient(<RoomList selectedId={null} onSelect={() => {}} />, { listRooms: async () => [] });
    expect(await screen.findByText(/no rooms/i)).toBeInTheDocument();
  });

  it('shows the error banner when the list fails', async () => {
    renderWithClient(<RoomList selectedId={null} onSelect={() => {}} />, {
      listRooms: async () => { throw new ApiError('HUMAN_CONTEXT_REQUIRED', 403, 'x'); },
    });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This token is not a human token'));
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run src/rooms/RoomList.spec.tsx`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement RoomList**

`src/rooms/RoomList.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { ErrorBanner } from '../errors/ErrorBanner';

export function RoomList({ selectedId, onSelect }: { selectedId: string | null; onSelect: (roomId: string) => void }) {
  const { client } = useAuth();
  const query = useQuery({ queryKey: ['rooms'], queryFn: () => client.listRooms() });
  if (query.error) return <ErrorBanner error={query.error} />;
  if (query.isLoading) return <p>Loading rooms…</p>;
  const rooms = query.data ?? [];
  if (rooms.length === 0) return <p>No rooms yet.</p>;
  return (
    <nav aria-label="Rooms">
      <ul>
        {rooms.map((room) => (
          <li key={room.conversation_id}>
            <button aria-current={room.conversation_id === selectedId} onClick={() => onSelect(room.conversation_id)}>
              {room.name}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run src/rooms/RoomList.spec.tsx`
Expected: 3 passed.

- [ ] **Step 6: Write the failing Timeline tests**

`src/rooms/Timeline.spec.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { HistoryItem } from '../api/types';
import { renderWithClient } from '../testUtils';
import { Timeline } from './Timeline';

function msg(seq: number, id: string, text: string, type = 'room.message'): HistoryItem {
  return {
    room_seq: String(seq), message_id: id, canonical_bytes: 'b',
    envelope: { message_id: id, message_type: type, sender: { endpoint_id: 'ep_a', owner_id: 'u' }, body: type === 'room.event' ? { kind: 'invocation_stopped', reason: text } : { text }, created_at: 't' },
  };
}

describe('Timeline', () => {
  it('renders messages as plain text, never as HTML', async () => {
    const history = vi.fn(async () => ({ code: 'OK', items: [msg(1, 'm1', '<img src=x onerror=alert(1)> **bold**')], next_after_seq: '1' }));
    const { container } = renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} />, { history });
    expect(await screen.findByText('<img src=x onerror=alert(1)> **bold**')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });

  it('pages until a page is shorter than the limit', async () => {
    const full = Array.from({ length: 100 }, (_, i) => msg(i + 1, `m${i + 1}`, `t${i + 1}`));
    const history = vi.fn(async (_room: string, after: string) =>
      after === '0'
        ? { code: 'OK', items: full, next_after_seq: '100' }
        : { code: 'OK', items: [msg(101, 'm101', 't101')], next_after_seq: '101' });
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} />, { history });
    expect(await screen.findByText('t101')).toBeInTheDocument();
    expect(history.mock.calls.map((c) => c[1])).toEqual(['0', '100']);
  });

  it('renders a room.event row as a system line', async () => {
    const history = vi.fn(async () => ({ code: 'OK', items: [msg(1, 'e1', 'stopped by user', 'room.event')], next_after_seq: '1' }));
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={() => {}} />, { history });
    expect(await screen.findByText(/invocation_stopped/)).toBeInTheDocument();
  });

  it('reports the highest rendered room_seq', async () => {
    const onVisibleSeq = vi.fn();
    const history = vi.fn(async () => ({ code: 'OK', items: [msg(1, 'm1', 'a'), msg(2, 'm2', 'b')], next_after_seq: '2' }));
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={onVisibleSeq} onGone={() => {}} />, { history });
    await waitFor(() => expect(onVisibleSeq).toHaveBeenLastCalledWith('2'));
  });

  it('shows pending and failed rows', async () => {
    const history = vi.fn(async () => ({ code: 'OK', items: [], next_after_seq: '0' }));
    renderWithClient(
      <Timeline roomId="room_1" pending={[{ idempotencyKey: 'k', text: 'draft', status: 'failed', error: 'boom' }]} onVisibleSeq={() => {}} onGone={() => {}} />,
      { history },
    );
    expect(await screen.findByText('draft')).toBeInTheDocument();
    expect(screen.getByText(/failed/i)).toBeInTheDocument();
  });

  it('shows the error banner and does not drop the room on a non-404 failure', async () => {
    const onGone = vi.fn();
    const history = vi.fn(async () => { throw new ApiError('DATABASE_UNAVAILABLE', 503, 'x'); });
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={onGone} />, { history });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('DATABASE_UNAVAILABLE'));
    expect(onGone).not.toHaveBeenCalled();
  });

  it('calls onGone when the room is not found', async () => {
    const onGone = vi.fn();
    const history = vi.fn(async () => { throw new ApiError('ROOM_NOT_FOUND', 404, 'Room not found'); });
    renderWithClient(<Timeline roomId="room_1" pending={[]} onVisibleSeq={() => {}} onGone={onGone} />, { history });
    await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1));
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `npx vitest run src/rooms/Timeline.spec.tsx`
Expected: FAIL, modules not found.

- [ ] **Step 8: Implement `useHistory` and `Timeline`**

`src/rooms/historyQuery.ts`:

```ts
import type { QueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../api/client';
import type { HistoryItem } from '../api/types';
import { maxSeq } from './seq';

const PAGE = 100;

export function historyKey(roomId: string) {
  return ['room', roomId, 'messages'] as const;
}

export async function fetchHistory(client: ApiClient, queryClient: QueryClient, roomId: string): Promise<HistoryItem[]> {
  // Read after the highest row already cached, so only new rows cross the wire.
  const held = queryClient.getQueryData<HistoryItem[]>(historyKey(roomId)) ?? [];
  const collected = [...held];
  let after = maxSeq(held.map((item) => item.room_seq));
  for (;;) {
    const page = await client.history(roomId, after, PAGE);
    collected.push(...page.items);
    if (page.items.length < PAGE) break;
    after = maxSeq(page.items.map((item) => item.room_seq));
  }
  return collected;
}
```

`src/rooms/useHistory.ts`:

```ts
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { fetchHistory, historyKey } from './historyQuery';

export function useHistory(roomId: string) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: historyKey(roomId), queryFn: () => fetchHistory(client, queryClient, roomId) });
  return { items: query.data ?? [], isLoading: query.isLoading, error: query.error, refetch: query.refetch };
}
```

`src/rooms/Timeline.tsx`:

```tsx
import { useEffect, useMemo } from 'react';
import { ApiError } from '../api/client';
import { ErrorBanner } from '../errors/ErrorBanner';
import { getSender } from '../auth/tokenStore';
import { mergeRows, type PendingMessage, type Row } from './mergeRows';
import { maxSeq } from './seq';
import { useHistory } from './useHistory';

function RowView({ row, sender }: { row: Row; sender: string | null }) {
  if (row.pending) {
    return (
      <li data-pending={row.pending.status}>
        <span>{row.pending.text}</span> <em>{row.pending.status === 'failed' ? `Failed: ${row.pending.error ?? 'send error'}` : 'Sending…'}</em>
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
      <small>{envelope.sender.endpoint_id}</small>
      <span>{envelope.body.text}</span>
    </li>
  );
}

export function Timeline({ roomId, pending, onVisibleSeq, onGone }: { roomId: string; pending: PendingMessage[]; onVisibleSeq: (seq: string) => void; onGone: () => void }) {
  const { items, isLoading, error } = useHistory(roomId);
  const rows = useMemo(() => mergeRows(items, pending), [items, pending]);
  const highest = useMemo(() => maxSeq(items.map((item) => item.room_seq)), [items]);

  useEffect(() => {
    if (highest !== '0') onVisibleSeq(highest);
  }, [highest, onVisibleSeq]);

  useEffect(() => {
    if (error instanceof ApiError && error.code === 'ROOM_NOT_FOUND') onGone();
  }, [error, onGone]);

  if (error && items.length === 0) return <ErrorBanner error={error} />;
  if (isLoading) return <p>Loading messages…</p>;
  const sender = getSender();
  return (
    <section aria-label="Messages">
      {error ? <ErrorBanner error={error} /> : null}
      <ul>
        {rows.map((row) => (
          <RowView key={row.key} row={row} sender={sender} />
        ))}
      </ul>
    </section>
  );
}
```

React renders `{envelope.body.text}` as text, which is what the XSS test asserts. Do not introduce any other rendering path.

- [ ] **Step 9: Run Timeline tests and watch them pass**

Run: `npx vitest run src/rooms/Timeline.spec.tsx`
Expected: 7 passed.

- [ ] **Step 10: Mount both in the shell**

In `src/App.tsx` replace the `Shell` body so a signed-in user sees the list and the selected room's timeline. A `404 ROOM_NOT_FOUND` from history drops the selection:

```tsx
function Shell() {
  const { token, login, signOut, rejected } = useAuth();
  const [roomId, setRoomId] = useState<string | null>(null);
  const [pending] = useState<PendingMessage[]>([]); // Task 6 replaces this with the composer's state
  const noop = useCallback(() => {}, []);
  const queryClient = useQueryClient();
  const onGone = useCallback(() => {
    setRoomId(null);
    void queryClient.invalidateQueries({ queryKey: ['rooms'] });
  }, [queryClient]);
  if (!token) return <TokenGate onSubmit={login} rejected={rejected} />;
  return (
    <main>
      <header>
        <strong>Sigil rooms</strong> <button onClick={signOut}>Sign out</button>
      </header>
      <RoomList selectedId={roomId} onSelect={setRoomId} />
      {roomId ? <Timeline roomId={roomId} pending={pending} onVisibleSeq={noop} onGone={onGone} /> : <p>Pick a room.</p>}
    </main>
  );
}
```

Add the imports (`useCallback` from react; `useQueryClient` from `@tanstack/react-query`; `RoomList`, `Timeline`, `PendingMessage`).

- [ ] **Step 11: Run everything, typecheck, commit**

Run: `npm test && npm run typecheck`
Expected: all pass.

```bash
git add packages/sigil-rooms-web
git commit -m "feat(web): add room list and timeline with paged history

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Composer with optimistic send

**Files:**
- Create: `src/rooms/Composer.tsx`, `src/rooms/Composer.spec.tsx`, `src/rooms/useSend.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `useAuth`, `setSender`, `PendingMessage`.
- Produces (`useSend.ts`): `useSend(roomId: string): { pending: PendingMessage[]; send(text: string): void; retry(idempotencyKey: string): void; sendError: unknown }`. State is per room and lives in the hook. On a 200 or 201 it sets `messageId` on the pending row, then calls `queryClient.fetchQuery` with `historyKey(roomId)`, `fetchHistory`, and `staleTime: 0` (this refreshes the cache even when no timeline is mounted), and calls `setSender` with the sender of the returned row whose `message_id` matches. On failure it sets `retryable: false` for an HTTP 400 and `true` otherwise. On failure it marks the row `failed` with the relay's `message`. Retry reuses the row's `idempotencyKey`.
- Produces (`Composer.tsx`): `Composer({ send, disabledReason })`. `disabledReason` is a string or null; when set the textarea and button are disabled and the reason shows.

- [ ] **Step 1: Write the failing tests**

`src/rooms/Composer.spec.tsx`:

```tsx
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient } from '../api/client';
import { TestAuthProvider } from '../auth/AuthContext';
import { getSender } from '../auth/tokenStore';
import { renderWithClient } from '../testUtils';
import { Composer } from './Composer';
import { useSend } from './useSend';

function wrapper(client: Partial<ApiClient>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestAuthProvider client={client as ApiClient}>{children}</TestAuthProvider>
    </QueryClientProvider>
  );
}

describe('Composer', () => {
  it('sends the typed text and clears the box', async () => {
    const send = vi.fn();
    renderWithClient(<Composer send={send} disabledReason={null} />, {});
    await userEvent.type(screen.getByRole('textbox'), 'hello');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(send).toHaveBeenCalledWith('hello');
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('ignores blank text', async () => {
    const send = vi.fn();
    renderWithClient(<Composer send={send} disabledReason={null} />, {});
    await userEvent.type(screen.getByRole('textbox'), '   ');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(send).not.toHaveBeenCalled();
  });

  it('is disabled with a reason', () => {
    renderWithClient(<Composer send={() => {}} disabledReason="Sending is not configured." />, {});
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByText('Sending is not configured.')).toBeInTheDocument();
  });
});

describe('useSend', () => {
  it('adds a sending row, then records message_id and the sender on success', async () => {
    const sendMessage = vi.fn(async () => ({ code: 'OK', message_id: 'm9', room_seq: '9' }));
    const history = vi.fn(async () => ({
      code: 'OK', next_after_seq: '9',
      items: [{ room_seq: '9', message_id: 'm9', canonical_bytes: 'b', envelope: { message_id: 'm9', message_type: 'room.message', sender: { endpoint_id: 'ep_web', owner_id: 'u' }, body: { text: 'hi' }, created_at: 't' } }],
    }));
    const { result } = renderHook(() => useSend('room_1'), { wrapper: wrapper({ sendMessage, history }) });
    act(() => result.current.send('hi'));
    expect(result.current.pending[0]).toMatchObject({ text: 'hi', status: 'sending' });
    await waitFor(() => expect(result.current.pending[0]?.messageId).toBe('m9'));
    await waitFor(() => expect(getSender()).toBe('ep_web'));
  });

  it('marks the row failed and retries with the same idempotency key', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new ApiError('NETWORK', 0, 'offline'))
      .mockResolvedValueOnce({ code: 'OK', message_id: 'm1', room_seq: '1' });
    const history = vi.fn(async () => ({ code: 'OK', items: [], next_after_seq: '0' }));
    const { result } = renderHook(() => useSend('room_1'), { wrapper: wrapper({ sendMessage, history }) });
    act(() => result.current.send('hi'));
    await waitFor(() => expect(result.current.pending[0]?.status).toBe('failed'));
    const key = result.current.pending[0]!.idempotencyKey;
    act(() => result.current.retry(key));
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls[0]![2]).toBe(sendMessage.mock.calls[1]![2]);
    expect(sendMessage.mock.calls[1]![2]).toBe(key);
  });

  it('treats a 200 replay like a 201', async () => {
    const sendMessage = vi.fn(async () => ({ code: 'OK', message_id: 'm2', room_seq: '2' }));
    const history = vi.fn(async () => ({ code: 'OK', items: [], next_after_seq: '0' }));
    const { result } = renderHook(() => useSend('room_1'), { wrapper: wrapper({ sendMessage, history }) });
    act(() => result.current.send('again'));
    await waitFor(() => expect(result.current.pending[0]?.messageId).toBe('m2'));
  });

  it('keeps the relay message on a 400', async () => {
    const sendMessage = vi.fn(async () => { throw new ApiError('INVALID_ENVELOPE', 400, 'text too long'); });
    const { result } = renderHook(() => useSend('room_1'), { wrapper: wrapper({ sendMessage }) });
    act(() => result.current.send('x'));
    await waitFor(() => expect(result.current.pending[0]).toMatchObject({ status: 'failed', error: 'text too long', retryable: false }));
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/rooms/Composer.spec.tsx`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the composer**

`src/rooms/Composer.tsx`:

```tsx
import { useState } from 'react';

export function Composer({ send, disabledReason }: { send: (text: string) => void; disabledReason: string | null }) {
  const [text, setText] = useState('');
  const disabled = disabledReason !== null;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = text.trim();
        if (!trimmed || disabled) return;
        send(trimmed);
        setText('');
      }}
    >
      {disabledReason ? <p>{disabledReason}</p> : null}
      <textarea aria-label="Message" value={text} disabled={disabled} onChange={(event) => setText(event.target.value)} />
      <button type="submit" disabled={disabled}>Send</button>
    </form>
  );
}
```

- [ ] **Step 4: Implement `useSend`**

`src/rooms/useSend.ts`:

```ts
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { getSender, setSender } from '../auth/tokenStore';
import { fetchHistory, historyKey } from './historyQuery';
import type { PendingMessage } from './mergeRows';

export function useSend(roomId: string) {
  const { client } = useAuth();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [sendError, setSendError] = useState<unknown>(null);

  const patch = useCallback((idempotencyKey: string, change: Partial<PendingMessage>) => {
    setPending((rows) => rows.map((row) => (row.idempotencyKey === idempotencyKey ? { ...row, ...change } : row)));
  }, []);

  const dispatch = useCallback(
    async (idempotencyKey: string, text: string) => {
      patch(idempotencyKey, { status: 'sending', error: undefined });
      try {
        const result = await client.sendMessage(roomId, text, idempotencyKey);
        patch(idempotencyKey, { messageId: result.message_id });
        // fetchQuery refreshes the cache even when no timeline is mounted.
        const rows = await queryClient.fetchQuery({
          queryKey: historyKey(roomId),
          queryFn: () => fetchHistory(client, queryClient, roomId),
          staleTime: 0,
        });
        if (!getSender()) {
          const mine = rows.find((row) => row.message_id === result.message_id);
          if (mine) setSender(mine.envelope.sender.endpoint_id);
        }
      } catch (error) {
        setSendError(error);
        patch(idempotencyKey, {
          status: 'failed',
          error: error instanceof ApiError ? error.message : 'send failed',
          retryable: !(error instanceof ApiError && error.status === 400),
        });
      }
    },
    [client, patch, queryClient, roomId],
  );

  const send = useCallback(
    (text: string) => {
      const idempotencyKey = crypto.randomUUID();
      setSendError(null);
      setPending((rows) => [...rows, { idempotencyKey, text, status: 'sending' }]);
      void dispatch(idempotencyKey, text);
    },
    [dispatch],
  );

  const retry = useCallback(
    (idempotencyKey: string) => {
      const row = pending.find((candidate) => candidate.idempotencyKey === idempotencyKey);
      if (row) void dispatch(idempotencyKey, row.text);
    },
    [dispatch, pending],
  );

  return { pending, send, retry, sendError };
}
```

- [ ] **Step 5: Run the composer tests and watch them pass**

Run: `npx vitest run src/rooms/Composer.spec.tsx`
Expected: 7 passed. A failed row keeps its text, so no draft is lost; a 400 row is marked `retryable: false` and shows no Retry button.

- [ ] **Step 6: Mount in the shell**

Replace the `pending` placeholder in `Shell` with the hook, and render the composer under the timeline. `useSend(roomId)` needs a room, so move the room view into a `RoomView({ roomId })` component:

```tsx
function RoomView({ roomId, onGone }: { roomId: string; onGone: () => void }) {
  const { pending, send, retry, sendError } = useSend(roomId);
  const noop = useCallback(() => {}, []);
  const disabledReason =
    sendError instanceof ApiError && (sendError.code === 'ROOM_SEND_UNAVAILABLE' || sendError.code === 'NO_SIGNING_KEY')
      ? describeError(sendError)
      : null;
  return (
    <>
      <Timeline roomId={roomId} pending={pending} onVisibleSeq={noop} onGone={onGone} />
      {pending.filter((row) => row.status === 'failed' && row.retryable !== false).map((row) => (
        <button key={row.idempotencyKey} onClick={() => retry(row.idempotencyKey)}>Retry: {row.text}</button>
      ))}
      <ErrorBanner error={sendError && !disabledReason ? sendError : null} />
      <Composer send={send} disabledReason={disabledReason} />
    </>
  );
}
```

In `Shell`, render `{roomId ? <RoomView roomId={roomId} onGone={onGone} /> : <p>Pick a room.</p>}` and delete the `pending` and `noop` placeholders from `Shell` (keep `onGone`). Task 7 replaces `noop` in `RoomView` with the ack hook. Add the imports `ApiError`, `describeError`, `Composer`, and `useSend`.

- [ ] **Step 7: Run everything, typecheck, commit**

Run: `npm test && npm run typecheck`
Expected: all pass.

```bash
git add packages/sigil-rooms-web
git commit -m "feat(web): add composer with optimistic send and same-key retry

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Ack after history renders

**Files:**
- Create: `src/rooms/useAck.ts`, `src/rooms/useAck.spec.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Produces (`useAck.ts`): `useAck(roomId: string, debounceMs?: number): (seq: string) => void`. The returned function records the highest seq seen. A debounce timer posts `client.ack(roomId, seq)` once the timer fires, only when `document.visibilityState === 'visible'` and only when the seq is higher than the last acked seq for that room. A hidden tab holds the seq and acks on the next `visibilitychange` to visible. A failed ack logs with `console.warn` and does not throw or surface.

- [ ] **Step 1: Write the failing tests**

`src/rooms/useAck.spec.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import { TestAuthProvider } from '../auth/AuthContext';
import { useAck } from './useAck';

function setup(ack: ApiClient['ack']) {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestAuthProvider client={{ ack } as ApiClient}>{children}</TestAuthProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useAck('room_1', 50), { wrapper });
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useAck', () => {
  beforeEach(() => { vi.useFakeTimers(); setVisibility('visible'); });
  afterEach(() => { vi.useRealTimers(); });

  it('debounces and acks only the highest seq', async () => {
    const ack = vi.fn(async () => ({ code: 'OK', acknowledged: 1 }));
    const { result } = setup(ack);
    act(() => { result.current('2'); result.current('5'); result.current('9'); });
    expect(ack).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith('room_1', '9');
  });

  it('is forward-only: a lower or equal seq does not ack again', async () => {
    const ack = vi.fn(async () => ({ code: 'OK', acknowledged: 1 }));
    const { result } = setup(ack);
    act(() => result.current('9'));
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    act(() => { result.current('9'); result.current('4'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('holds the ack while the tab is hidden and sends it on the next visibility change', async () => {
    const ack = vi.fn(async () => ({ code: 'OK', acknowledged: 1 }));
    const { result } = setup(ack);
    setVisibility('hidden');
    act(() => result.current('7'));
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(ack).not.toHaveBeenCalled();
    setVisibility('visible');
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(ack).toHaveBeenCalledWith('room_1', '7');
  });

  it('swallows an ack failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ack = vi.fn(async () => { throw new Error('boom'); });
    const { result } = setup(ack);
    act(() => result.current('3'));
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/rooms/useAck.spec.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/rooms/useAck.ts`:

```ts
import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '../auth/AuthContext';
import { toSeq } from './seq';

export function useAck(roomId: string, debounceMs = 500): (seq: string) => void {
  const { client } = useAuth();
  const wanted = useRef<bigint>(0n);
  const acked = useRef<bigint>(0n);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    if (document.visibilityState !== 'visible') return;
    if (wanted.current <= acked.current) return;
    const upTo = wanted.current;
    acked.current = upTo;
    client.ack(roomId, upTo.toString()).catch((error: unknown) => {
      console.warn('ack failed; the next fetch repeats it', error);
      if (acked.current === upTo) acked.current = 0n;
    });
  }, [client, roomId]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, debounceMs);
  }, [debounceMs, flush]);

  useEffect(() => {
    wanted.current = 0n;
    acked.current = 0n;
    const onVisible = () => {
      if (document.visibilityState === 'visible' && wanted.current > acked.current) schedule();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [roomId, schedule]);

  return useCallback(
    (seq: string) => {
      const next = toSeq(seq);
      if (next > wanted.current) wanted.current = next;
      if (wanted.current > acked.current) schedule();
    },
    [schedule],
  );
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/rooms/useAck.spec.tsx`
Expected: 4 passed.

- [ ] **Step 5: Wire it into `RoomView`**

In `src/App.tsx` replace `const noop = useCallback(() => {}, []);` and `onVisibleSeq={noop}` with:

```tsx
const reportSeq = useAck(roomId);
...
<Timeline roomId={roomId} pending={pending} onVisibleSeq={reportSeq} />
```

- [ ] **Step 6: Run everything, typecheck, commit**

Run: `npm test && npm run typecheck`
Expected: all pass.

```bash
git add packages/sigil-rooms-web
git commit -m "feat(web): ack after history renders, debounced, forward-only, visible tab only

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Live socket and invalidation

**Files:**
- Create: `src/live/socket.ts`, `src/live/socket.spec.ts`, `src/live/useLive.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Produces (`socket.ts`): `class LiveSocket` constructed with `{ streamUrl: string; getTicket: () => Promise<string>; onFrame: (frame: RoomUpdatedFrame) => void; onStatus: (status: 'live' | 'off') => void; onReconnect: () => void; WebSocketImpl?: typeof WebSocket; backoffMs?: (attempt: number) => number }`. Methods: `start()`, `stop()`. Behavior: `start()` asks for a ticket, opens `${streamUrl}/v1/stream?ticket=<ticket>`, reports `live` on open, parses each message as JSON and forwards frames with `type === 'room.updated'` (ignore every other frame type and any unparseable message), and on close or ticket failure reports `off`, waits `backoffMs(attempt)` (default `min(30000, 1000 * 2 ** attempt)`), then starts again with a new ticket. A successful open resets `attempt` to 0 and, when it follows a drop, calls `onReconnect()`. `stop()` closes the socket and cancels the retry.
- Produces (`useLive.ts`): `useLive(): 'live' | 'off'`. It builds a `LiveSocket` from `useAuth()`, invalidates `['room', frame.room_id, 'messages']` for `changed === 'messages'` and `['rooms']` for `changed === 'members'`, invalidates everything on reconnect, and while status is `off` refetches active queries every 30 seconds and on window focus (React Query `refetchOnWindowFocus` is already on by default).

- [ ] **Step 1: Write the failing socket tests**

`src/live/socket.spec.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveSocket } from './socket';

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  message(data: unknown) { this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) }); }
  drop() { this.onclose?.(); }
}

function make(overrides: Partial<ConstructorParameters<typeof LiveSocket>[0]> = {}) {
  const onFrame = vi.fn();
  const onStatus = vi.fn();
  const onReconnect = vi.fn();
  const getTicket = vi.fn(async () => `t${FakeSocket.instances.length + 1}`);
  const socket = new LiveSocket({
    streamUrl: 'ws://stream.test', getTicket, onFrame, onStatus, onReconnect,
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket, backoffMs: () => 100, ...overrides,
  });
  return { socket, onFrame, onStatus, onReconnect, getTicket };
}

describe('LiveSocket', () => {
  beforeEach(() => { FakeSocket.instances = []; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('opens the stream with the ticket and reports live', async () => {
    const { socket, onStatus } = make();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances[0]!.url).toBe('ws://stream.test/v1/stream?ticket=t1');
    FakeSocket.instances[0]!.open();
    expect(onStatus).toHaveBeenLastCalledWith('live');
  });

  it('forwards room.updated frames and ignores everything else', async () => {
    const { socket, onFrame } = make();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeSocket.instances[0]!;
    ws.open();
    ws.message({ type: 'delivery.receipt', message_id: 'm' });
    ws.message('not json');
    ws.message({ type: 'room.updated', room_id: 'room_1', room_seq: '4', changed: 'messages' });
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledWith({ type: 'room.updated', room_id: 'room_1', room_seq: '4', changed: 'messages' });
  });

  it('reconnects with a new ticket after a drop and signals onReconnect', async () => {
    const { socket, onStatus, onReconnect, getTicket } = make();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.drop();
    expect(onStatus).toHaveBeenLastCalledWith('off');
    await vi.advanceTimersByTimeAsync(150);
    expect(getTicket).toHaveBeenCalledTimes(2);
    expect(FakeSocket.instances[1]!.url).toBe('ws://stream.test/v1/stream?ticket=t2');
    FakeSocket.instances[1]!.open();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('backs off and retries when the ticket request fails', async () => {
    const getTicket = vi.fn().mockRejectedValueOnce(new Error('429')).mockResolvedValue('t-ok');
    const { socket, onStatus } = make({ getTicket });
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith('off');
    await vi.advanceTimersByTimeAsync(150);
    expect(FakeSocket.instances[0]!.url).toBe('ws://stream.test/v1/stream?ticket=t-ok');
  });

  it('stop closes the socket and cancels the retry', async () => {
    const { socket, getTicket } = make();
    socket.start();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.instances[0]!.open();
    socket.stop();
    expect(FakeSocket.instances[0]!.closed).toBe(true);
    FakeSocket.instances[0]!.drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(getTicket).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/live/socket.spec.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `LiveSocket`**

`src/live/socket.ts`:

```ts
import type { RoomUpdatedFrame } from '../api/types';

export interface LiveSocketOptions {
  streamUrl: string;
  getTicket: () => Promise<string>;
  onFrame: (frame: RoomUpdatedFrame) => void;
  onStatus: (status: 'live' | 'off') => void;
  onReconnect: () => void;
  WebSocketImpl?: typeof WebSocket;
  backoffMs?: (attempt: number) => number;
}

export class LiveSocket {
  private readonly options: LiveSocketOptions;
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;
  private dropped = false;

  constructor(options: LiveSocketOptions) {
    this.options = options;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.socket?.close();
    this.socket = null;
  }

  private backoff(): number {
    return (this.options.backoffMs ?? ((n) => Math.min(30_000, 1000 * 2 ** n)))(this.attempt);
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.options.onStatus('off');
    this.dropped = true;
    const delay = this.backoff();
    this.attempt += 1;
    this.retry = setTimeout(() => void this.connect(), delay);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let ticket: string;
    try {
      ticket = await this.options.getTicket();
    } catch {
      this.scheduleRetry();
      return;
    }
    if (this.stopped) return;
    const Impl = this.options.WebSocketImpl ?? WebSocket;
    const socket = new Impl(`${this.options.streamUrl}/v1/stream?ticket=${encodeURIComponent(ticket)}`);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.options.onStatus('live');
      if (this.dropped) {
        this.dropped = false;
        this.options.onReconnect();
      }
    };
    socket.onmessage = (event: MessageEvent) => {
      let frame: unknown;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      if ((frame as { type?: string } | null)?.type === 'room.updated') this.options.onFrame(frame as RoomUpdatedFrame);
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.scheduleRetry();
    };
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/live/socket.spec.ts`
Expected: 5 passed. If the "stop cancels the retry" test fails because `onclose` still fires `scheduleRetry` after `stop()`, the `if (this.stopped) return;` guard at the top of `scheduleRetry` is what prevents it; check it is present.

- [ ] **Step 5: Write `useLive` and mount it**

`src/live/useLive.ts`:

```ts
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { LiveSocket } from './socket';

export function useLive(): 'live' | 'off' {
  const { client, streamUrl, token } = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<'live' | 'off'>('off');

  useEffect(() => {
    if (!token) return;
    const socket = new LiveSocket({
      streamUrl,
      getTicket: async () => (await client.wsTicket()).ticket,
      onFrame: (frame) => {
        if (frame.changed === 'members') void queryClient.invalidateQueries({ queryKey: ['rooms'] });
        else void queryClient.invalidateQueries({ queryKey: ['room', frame.room_id, 'messages'] });
      },
      onStatus: setStatus,
      onReconnect: () => void queryClient.invalidateQueries(),
    });
    socket.start();
    return () => socket.stop();
  }, [client, streamUrl, token, queryClient]);

  useEffect(() => {
    if (status === 'live') return;
    const interval = setInterval(() => void queryClient.invalidateQueries({ refetchType: 'active' }), 30_000);
    return () => clearInterval(interval);
  }, [status, queryClient]);

  return status;
}
```

In `Shell` (`src/App.tsx`), call `const live = useLive();` after the early `if (!token)` return is NOT allowed (hooks must run unconditionally), so place the call above the early return and let `useLive` do nothing when there is no token (it already does). Render the chip in the header: `<span>{live === 'live' ? 'Live' : 'Live: off'}</span>`.

- [ ] **Step 6: Add a `useLive` invalidation test**

Append to `src/live/socket.spec.ts` is wrong (it tests `LiveSocket` only). Create `src/live/useLive.spec.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import { TestAuthProvider } from '../auth/AuthContext';

const sockets = vi.hoisted(
  () => [] as Array<{ onFrame: (f: unknown) => void; onStatus: (s: 'live' | 'off') => void; onReconnect: () => void }>,
);
vi.mock('./socket', () => ({
  LiveSocket: class {
    constructor(options: (typeof sockets)[number]) { sockets.push(options); }
    start() {}
    stop() {}
  },
}));

const fakeClient = { wsTicket: async () => ({ code: 'OK', ticket: 't', expires_at: 'e' }) } as unknown as ApiClient;

import { useLive } from './useLive';

describe('useLive', () => {
  beforeEach(() => { sockets.length = 0; });

  function setup() {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TestAuthProvider client={fakeClient}>{children}</TestAuthProvider>
      </QueryClientProvider>
    );
    return { spy, ...renderHook(() => useLive(), { wrapper }) };
  }

  it('invalidates the room history on a messages frame', async () => {
    const { spy } = setup();
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.onFrame({ type: 'room.updated', room_id: 'room_1', room_seq: '3', changed: 'messages' });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['room', 'room_1', 'messages'] });
  });

  it('invalidates the room list on a members frame', async () => {
    const { spy } = setup();
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.onFrame({ type: 'room.updated', room_id: 'room_1', changed: 'members' });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['rooms'] });
  });

  it('invalidates everything after a reconnect and reports status', async () => {
    const { spy, result } = setup();
    await waitFor(() => expect(sockets.length).toBe(1));
    sockets[0]!.onStatus('live');
    await waitFor(() => expect(result.current).toBe('live'));
    sockets[0]!.onReconnect();
    expect(spy).toHaveBeenCalledWith();
  });
});
```

Run: `npx vitest run src/live`
Expected: 8 passed (5 socket, 3 useLive).

- [ ] **Step 7: Run everything, typecheck, commit**

Run: `npm test && npm run typecheck`
Expected: all pass.

```bash
git add packages/sigil-rooms-web
git commit -m "feat(web): add live socket with ticket auth, backoff, and query invalidation

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Static server and CLI

**Files:**
- Create: `packages/sigil-rooms-web/serve/server.mjs`, `bin/sigil-rooms-web.mjs`, `src/serve.spec.ts`

**Interfaces:**
- Produces (`serve/server.mjs`): `createWebServer({ distDir, relayUrl, streamUrl }): http.Server`. Routes: `GET /config.json` returns `{relayUrl, streamUrl}` as JSON with `cache-control: no-store`; any other `GET` serves a file from `distDir`, falling back to `index.html` for unknown paths without an extension; every response carries `content-security-policy: default-src 'self'; connect-src 'self' <relayUrl> <streamUrl>; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'` and `x-content-type-options: nosniff`. A path that escapes `distDir` answers 403. Methods other than GET and HEAD answer 405.
- Produces (`bin/sigil-rooms-web.mjs`): `sigil-rooms-web [--port 5173] [--relay-url http://127.0.0.1:7777] [--stream-url <url>] [--dist <dir>]`. `--stream-url` defaults to `--relay-url` with its port plus one. The CLI listens on `127.0.0.1`, then prints: the URL to open, and the exact flag line `relay up ... --browser-origin http://127.0.0.1:<port>`. If `dist/` has no `index.html` it exits 1 with "Run npm run build first".

The default relay URL has no stable port because `relay up` uses port 0 when `--port` is omitted; the README (Task 11) tells the user to start the relay with `--port 7777`.

- [ ] **Step 1: Write the failing server tests**

The tests live in `src/serve.spec.ts` so Vitest runs them (core's `node --test` never sees it). Vitest can import the `.mjs` server directly.

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs without types
import { createWebServer, defaultStreamUrl } from '../serve/server.mjs';

let server: import('node:http').Server;
let base: string;

beforeEach(async () => {
  const dist = mkdtempSync(path.join(tmpdir(), 'web-dist-'));
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>x</title>');
  mkdirSync(path.join(dist, 'assets'));
  writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
  server = createWebServer({ distDir: dist, relayUrl: 'http://127.0.0.1:7777', streamUrl: 'ws://127.0.0.1:7778' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => { await new Promise((resolve) => server.close(resolve)); });

describe('web server', () => {
  it('serves config.json with the relay and stream URLs, uncached', async () => {
    const res = await fetch(`${base}/config.json`);
    expect(await res.json()).toEqual({ relayUrl: 'http://127.0.0.1:7777', streamUrl: 'ws://127.0.0.1:7778' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('sets a CSP that allows only self, the relay, and the stream', async () => {
    const res = await fetch(`${base}/`);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' http://127.0.0.1:7777 ws://127.0.0.1:7778");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves assets with a content type and falls back to index.html for app routes', async () => {
    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.headers.get('content-type')).toContain('javascript');
    const route = await fetch(`${base}/rooms/room_1`);
    expect(await route.text()).toContain('<title>x</title>');
  });

  it('answers 400 to a malformed escape instead of crashing', async () => {
    const res = await fetch(`${base}/%E0%A4%A`);
    expect([400, 404]).toContain(res.status);
    const after = await fetch(`${base}/config.json`);
    expect(after.status).toBe(200);
  });

  it('refuses path traversal and non-GET methods', async () => {
    const traversal = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
    expect([403, 404]).toContain(traversal.status);
    const post = await fetch(`${base}/`, { method: 'POST' });
    expect(post.status).toBe(405);
  });

  it('defaultStreamUrl adds one to the relay port', () => {
    expect(defaultStreamUrl('http://127.0.0.1:7777')).toBe('ws://127.0.0.1:7778');
    expect(defaultStreamUrl('https://relay.example:8443')).toBe('wss://relay.example:8444');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/serve.spec.ts`
Expected: FAIL, cannot resolve `../serve/server.mjs`.

- [ ] **Step 3: Implement the server**

`serve/server.mjs`:

```js
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

export function defaultStreamUrl(relayUrl) {
  const url = new URL(relayUrl);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80)) + 1;
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${url.hostname}:${port}`;
}

export function createWebServer({ distDir, relayUrl, streamUrl }) {
  const root = path.resolve(distDir);
  const csp = [
    "default-src 'self'",
    `connect-src 'self' ${relayUrl} ${streamUrl}`,
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "frame-ancestors 'none'",
  ].join('; ');

  function headers(extra = {}) {
    return { 'content-security-policy': csp, 'x-content-type-options': 'nosniff', ...extra };
  }

  return http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, headers({ allow: 'GET, HEAD' }));
      return response.end();
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400, headers());
      return response.end();
    }
    if (pathname === '/config.json') {
      response.writeHead(200, headers({ 'content-type': TYPES['.json'], 'cache-control': 'no-store' }));
      return response.end(JSON.stringify({ relayUrl, streamUrl }));
    }
    let target = path.resolve(root, `.${pathname}`);
    if (target !== root && !target.startsWith(root + path.sep)) {
      response.writeHead(403, headers());
      return response.end();
    }
    if (!path.extname(target) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      if (path.extname(target)) {
        response.writeHead(404, headers());
        return response.end();
      }
      target = path.join(root, 'index.html');
    }
    const type = TYPES[path.extname(target)] ?? 'application/octet-stream';
    response.writeHead(200, headers({ 'content-type': type }));
    if (request.method === 'HEAD') return response.end();
    fs.createReadStream(target).pipe(response);
  });
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/serve.spec.ts`
Expected: 6 passed.

- [ ] **Step 5: Write the CLI**

`bin/sigil-rooms-web.mjs`:

```js
#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createWebServer, defaultStreamUrl } from '../serve/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '5173' },
    'relay-url': { type: 'string', default: 'http://127.0.0.1:7777' },
    'stream-url': { type: 'string' },
    dist: { type: 'string', default: path.resolve(here, '../dist') },
  },
});

const port = Number(values.port);
const relayUrl = values['relay-url'].replace(/\/$/, '');
const streamUrl = (values['stream-url'] ?? defaultStreamUrl(relayUrl)).replace(/\/$/, '');
const distDir = path.resolve(values.dist);

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error(`sigil-rooms-web: no build at ${distDir}. Run npm run build first.`);
  process.exit(1);
}

const server = createWebServer({ distDir, relayUrl, streamUrl });
server.on('error', (error) => {
  console.error(`sigil-rooms-web: ${error.message}`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`Open ${origin}`);
  console.log(`Start the relay with: sigil relay up --port ${new URL(relayUrl).port} --browser-origin ${origin} --room-human-identity <identity.json>`);
  console.log('Open exactly that origin: localhost and 127.0.0.1 are different origins to the relay.');
});
```

- [ ] **Step 6: Smoke-test the CLI**

Run, from the package directory:

```bash
npm run build
node bin/sigil-rooms-web.mjs --port 5199 &
sleep 1
curl -s -i http://127.0.0.1:5199/config.json | head -12
kill %1
```

Expected: `Open http://127.0.0.1:5199` printed, a 200 with the JSON `{"relayUrl":"http://127.0.0.1:7777","streamUrl":"ws://127.0.0.1:7778"}`, and a `content-security-policy` header. Then run `node bin/sigil-rooms-web.mjs --dist /nonexistent` and expect exit code 1 with the "Run npm run build first" message.

- [ ] **Step 7: Run everything, typecheck, commit**

Run: `npm test && npm run typecheck`
Expected: all pass.

```bash
git add packages/sigil-rooms-web
git commit -m "feat(web): add static server with CSP and the sigil-rooms-web CLI

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: End-to-end test against a real relay

**Files:**
- Create: `packages/sigil-rooms-web/playwright.config.ts`, `e2e/rooms.e2e.ts`, `e2e/relayHarness.ts`
- Modify: `.github/workflows/ci.yml` (add e2e step to the `web` job)

**Interfaces:**
- Produces (`relayHarness.ts`): `startRelay(): Promise<{ relayUrl: string; streamUrl: string; webOrigin: string; humanToken: string; stop(): Promise<void> }>`. It creates a temp dir, runs `sigil init` twice: `web` with `--kind human` (endpoint `ep_web@local`) and `claude` with `--kind agent` (endpoint `ep_claude@local`), runs the real `sigil relay up --port <p> --browser-origin <webOrigin> --room-human-identity <ep_web identity>` as a child process with the in-memory repository, creates a room as the human over HTTP, and returns the human's `relay_token`.

This is the only test that exercises 4a's CORS, ticket, and stream path in a real browser.

- [ ] **Step 1: Find the CLI entry and verify the room-creation call**

Run from the repo root: `ls bin/sigil.mjs && node bin/sigil.mjs help 2>&1 | head -5`. Expected: the usage text. Then confirm a human token can create a room, using a throwaway relay:

```bash
cd "$(mktemp -d)" && node /c/dev/.worktrees/sigil-4b1/bin/sigil.mjs init alice --owner usr_alice@local && cat .sigil/alice.identity.json | head -3
```

Expected: an identity file with `relay_token`. (Substitute the real worktree path.) If `sigil init`'s default `--domain local` yields endpoint id `ep_alice@local`, the harness uses that form.

- [ ] **Step 2: Write the harness**

`e2e/relayHarness.ts`:

```ts
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const sigilBin = path.join(repoRoot, 'bin/sigil.mjs');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

function sigil(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [sigilBin, ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`sigil ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
}

export interface Harness {
  relayUrl: string;
  streamUrl: string;
  webOrigin: string;
  humanToken: string;
  roomId: string;
  stop(): Promise<void>;
}

export async function startRelay(webPort: number): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'sigil-e2e-'));
  const relayPort = await freePort();
  const streamPort = relayPort + 1;
  const webOrigin = `http://127.0.0.1:${webPort}`;
  sigil(dir, ['init', 'web', '--owner', 'usr_web@local', '--kind', 'human']);
  sigil(dir, ['init', 'claude', '--owner', 'usr_web@local', '--kind', 'agent']);
  const identityPath = path.join(dir, '.sigil', 'web.identity.json');
  const identity = JSON.parse(readFileSync(identityPath, 'utf8')) as { relay_token: string };

  const child: ChildProcess = spawn(
    process.execPath,
    [sigilBin, 'relay', 'up', '--port', String(relayPort), '--stream-port', String(streamPort), '--browser-origin', webOrigin, '--room-human-identity', identityPath],
    { cwd: dir, stdio: process.env.E2E_DEBUG ? 'inherit' : 'ignore' },
  );
  const relayUrl = `http://127.0.0.1:${relayPort}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await fetch(`${relayUrl}/v1/rooms`, { headers: { authorization: `Bearer ${identity.relay_token}` } });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('relay did not start');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const created = await fetch(`${relayUrl}/v1/rooms`, {
    method: 'POST',
    headers: { authorization: `Bearer ${identity.relay_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'e2e-room' }),
  });
  if (created.status !== 201) throw new Error(`room create failed: ${created.status} ${await created.text()}`);
  const { room } = (await created.json()) as { room: { conversation_id: string } };

  return {
    relayUrl,
    streamUrl: `ws://127.0.0.1:${streamPort}`,
    webOrigin,
    humanToken: identity.relay_token,
    roomId: room.conversation_id,
    async stop() {
      child.kill();
    },
  };
}
```

The relay needs the web origin before it starts, so the web port is chosen first (Step 3) and passed in.

- [ ] **Step 3: Write the Playwright config and test**

`playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  workers: 1,
  use: { headless: true },
});
```

`e2e/rooms.e2e.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startRelay, type Harness } from './relayHarness';

const WEB_PORT = 5188;
let harness: Harness;
let web: ChildProcess;

test.beforeAll(async () => {
  harness = await startRelay(WEB_PORT);
  web = spawn(
    process.execPath,
    [path.resolve(import.meta.dirname, '../bin/sigil-rooms-web.mjs'), '--port', String(WEB_PORT), '--relay-url', harness.relayUrl, '--stream-url', harness.streamUrl],
    { stdio: 'ignore' },
  );
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await fetch(`http://127.0.0.1:${WEB_PORT}/config.json`); break; } catch {
      if (Date.now() > deadline) throw new Error('web server did not start');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
});

test.afterAll(async () => {
  web?.kill();
  await harness?.stop();
});

test('paste a token, list rooms, send, see it come back live, and ack', async ({ page }) => {
  await page.goto(harness.webOrigin);
  await page.getByLabel('Bearer token').fill('not-a-real-token');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('alert')).toContainText('Token rejected');

  await page.getByLabel('Bearer token').fill(harness.humanToken);
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.getByRole('button', { name: 'e2e-room' }).click();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();

  const ackRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(`/v1/rooms/${harness.roomId}/ack`)) ackRequests.push(request.postData() ?? '');
  });

  await page.getByLabel('Message').fill('hello from the browser');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('hello from the browser')).toBeVisible();
  await expect(page.getByText('Sending…')).toHaveCount(0);

  await expect.poll(() => ackRequests.length, { timeout: 5000 }).toBeGreaterThan(0);
  expect(JSON.parse(ackRequests.at(-1)!)).toHaveProperty('up_to_room_seq');

  // The token is in sessionStorage, not localStorage.
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem('sigil.token'))).toBe(harness.humanToken);
});

test('a reload keeps the session', async ({ page }) => {
  await page.goto(harness.webOrigin);
  await page.getByLabel('Bearer token').fill(harness.humanToken);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('button', { name: 'e2e-room' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'e2e-room' })).toBeVisible();
});

test('the relay answers a preflight from an unlisted origin without CORS headers', async () => {
  const preflight = (origin: string) =>
    new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const request = http.request(`${harness.relayUrl}/v1/rooms`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } }, (response) => {
        response.resume();
        resolve(response.headers);
      });
      request.on('error', reject);
      request.end();
    });
  expect((await preflight(harness.webOrigin))['access-control-allow-origin']).toBe(harness.webOrigin);
  expect((await preflight('http://localhost:5188'))['access-control-allow-origin']).toBeUndefined();
});
```

- [ ] **Step 4: Install the browser and run the test**

Run, from the package directory:

```bash
npx playwright install chromium
npm run build
npm run test:e2e
```

Expected: 3 passed. Likely failures and what they mean:
- `Token rejected` never appears: the relay's 401 body differs; read the response and adjust `describeError` only if the status is not 401.
- `Live` never shows: the stream URL, ticket, or origin check failed. Read the relay's stderr (run the harness with `stdio: 'inherit'` temporarily) and fix the cause, not the test.
- The send returns `ROOM_SEND_UNAVAILABLE` or `NO_SIGNING_KEY`: the `--room-human-identity` path or the endpoint id does not match the registry; the 4a startup check should have refused to start, so read its message.

- [ ] **Step 5: Add the e2e step to the web CI job**

In the `web` job of `.github/workflows/ci.yml`, after the Build step add:

```yaml
      - name: Install Playwright browser
        run: npx playwright install --with-deps chromium

      - name: End-to-end test
        run: npm run test:e2e
```

The e2e harness spawns `bin/sigil.mjs` from the repo root, so the `web` job must also install core dependencies. Add before the web install step:

```yaml
      - name: Install core dependencies
        run: npm ci --ignore-scripts
        working-directory: .
```

- [ ] **Step 6: Confirm core gates still pass, then commit**

Run from the repo root, once and alone: `timeout 900 npm test`
Expected: pass, with no new failures and nothing picked up from `packages/`.

```bash
git add packages/sigil-rooms-web .github/workflows/ci.yml
git commit -m "test(web): add Playwright end-to-end test against a real relay

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: README, root docs, and final gate

**Files:**
- Create: `packages/sigil-rooms-web/README.md`
- Modify: `README.md` (root, one short section), `CHANGELOG.md`, `docs/superpowers/specs/2026-10-02-sigil-rooms-design.md` (phase 4 status line, only if it still says 4b is unbuilt)

- [ ] **Step 1: Write the package README**

`packages/sigil-rooms-web/README.md` (under 100 lines):

````markdown
# @sorensencc/sigil-rooms-web

Browser client for Sigil rooms. It runs on your own machine against your own relay.

## Run it

1. Build the client: `npm install && npm run build` in this directory.
2. Start the relay with a fixed port, the web origin, and the human identity:

   ```bash
   sigil relay up --port 7777 --browser-origin http://127.0.0.1:5173 --room-human-identity .sigil/<you>.identity.json
   ```

3. Start the web server: `node bin/sigil-rooms-web.mjs --relay-url http://127.0.0.1:7777`.
4. Open `http://127.0.0.1:5173` (exactly that origin; `localhost` is a different origin to the relay).
5. Paste your human endpoint's `relay_token` from `.sigil/<you>.identity.json`.

`--stream-url` defaults to the relay URL with its port plus one, matching `relay up --port`. Pass it when you set `--stream-port`.

## What it does

Paste-token login, room list, timeline, send, ack, and live updates through `room.updated`. Threads, Stop, and roster modes are phase 4b-2.

## Security notes

- The token lives in `sessionStorage`: it survives a reload and clears when the tab closes. Never in `localStorage` or a URL.
- Message text renders as plain text only. The server sends a Content-Security-Policy header that limits connections to the relay and stream URLs.
- The client does not verify message signatures. It trusts the relay on your machine.

## Develop

- `npm test` runs the Vitest suite. `npm run test:e2e` runs Playwright against a real relay.
- Test files are `*.spec.ts(x)`. Do not name them `*.test.ts`: Node 24's `node --test` in the sigil root would pick them up.
- Spec: `docs/superpowers/specs/2026-10-07-sigil-rooms-phase-4b1-web-client-design.md`.
````

- [ ] **Step 2: Add a root README pointer and a CHANGELOG entry**

In the root `README.md`, add under the rooms or relay section (find it with `grep -n -i "room" README.md | head`) one line: `The browser client lives in packages/sigil-rooms-web; see its README.` In `CHANGELOG.md`, add an entry for the web client under the unreleased heading, following the file's existing format.

- [ ] **Step 3: Final gate**

Run from the repo root, one at a time:

```bash
npm run test:web
node sigil-dep-audit.mjs && node sigil-jcs-audit.mjs
npm pack --dry-run 2>&1 | grep -c "packages/"
timeout 900 npm test
```

Expected: web typecheck, tests, and build pass; both audits exit 0; the pack grep prints `0`; the core suite passes with the same pass count as before this work (the new `dep-audit-lib` test adds one).

- [ ] **Step 4: Commit and push**

```bash
git add packages/sigil-rooms-web/README.md README.md CHANGELOG.md
git commit -m "docs(web): add the web client README and changelog entry

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Ask Chris before pushing, then open the PR with a description that lists the four plan-time corrections: no `X-Sigil-Request-Id` header, `.spec.ts` test naming, the `packages` exclusion in `dep-audit-lib.mjs`, and the CI web job.
