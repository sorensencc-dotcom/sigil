# Sigil rooms phase 4b-1: web client design

Status: draft for review, 2026-10-07.
Parent spec: `docs/superpowers/specs/2026-10-02-sigil-rooms-design.md` (Clients section and delivery phase 4).
Builds on: phase 4a (`docs/superpowers/specs/2026-10-05-sigil-rooms-phase-4a-relay-browser-surface-design.md`, PR #33), which adds `ws-ticket`, the `room.updated` frame, the human send route, the bulk ack route, and the `--browser-origin` allowlist.

## Goal

A human opens a browser tab on their own machine, pastes a bearer token, sees their rooms and the messages in each, sends messages, and sees new messages appear live. The client exercises the 4a relay surface in a real browser for the first time.

## Phase 4b split

The parent spec's web client is more than one plan. It splits as follows:

- **4b-1 (this spec).** Paste-token login, room list, timeline, send, ack, live updates, and the command that serves the bundle.
- **4b-2.** Threads, the Stop button, and roster response modes.
- **Later.** Approval cards, signature verification in the browser, a login that works off localhost.

## Scope

In scope:

- The package `@sorensencc/sigil-rooms-web` in `packages/sigil-rooms-web/`.
- Paste-token login, with the token held in `sessionStorage`.
- Room list from `GET /v1/rooms`.
- Timeline of `room.message` and `room.event` rows from `GET /v1/rooms/{room_id}/messages`.
- Composer that posts through `POST /v1/rooms/{room_id}/messages`.
- Ack through `POST /v1/rooms/{room_id}/ack` after each history fetch.
- Live updates through `POST /v1/rooms/ws-ticket` and the `room.updated` frame.
- The `sigil-rooms-web` command that serves the built bundle and prints the `--browser-origin` value for `relay up`.

Out of scope, with the reason:

- Threads, Stop, and roster modes. They are 4b-2.
- Signature verification. The relay is on localhost, authenticated, and the user's own, the same trust boundary the parent spec accepts for human signing. The 4a ack section says the 4b client verifies against `canonical_bytes`; this spec supersedes that line. Verification needs a browser Ed25519 and JCS dependency plus a route that serves sender public keys, and none is confirmed to exist.
- A mine/theirs split in the timeline. No route tells the client its own endpoint ID. The client records the `sender` of its first successful send in `sessionStorage` beside the token, so the split survives a reload, and styles rows by it. Before the first send, rows carry no split. Plan step 0 confirms the envelope's `sender` field name. A `GET /v1/me` route is a new auth-adjacent route with its own review, so this spec does not add one.
- Cookie or session-exchange login. Deferred in the 4a spec until the client has to work off localhost.
- Approval cards, offline outbox, mobile PWA, and any non-localhost deployment.
- History windowing. The history route reads forward from `after_seq` only, so the first open of a room loads every row in pages of 100. 4b-1 accepts that cost; a windowed view needs a relay change.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Split | 4b-1 now, 4b-2 later | A usable client early, and the login, ticket, and `room.updated` path proven in a real browser before more UI builds on it. |
| Serving | The web package serves itself on its own port; the relay serves no static files | Keeps core plain Node `.mjs` with no UI assets, and exercises the 4a CORS and origin checks for real. |
| Signature verification | None in 4b-1 | See Scope. |
| Package location | `packages/sigil-rooms-web/` in the sigil repo | One repo and one PR flow, and contract changes land next to the client types that check them. Core's `files` whitelist keeps the package out of the core npm tarball. |
| Language and stack | TypeScript, React, Vite, Vitest, TanStack Query | TypeScript checks the client against `relay-api.json` shapes. TanStack Query gives dedupe, retry, and invalidate. |
| Data layer | TanStack Query with socket-driven invalidation | `room.updated` carries no content, so every frame means "refetch". Query's cache handles in-flight dedupe, retry, and optimistic rollback. A hand-rolled store would rewrite those. A reducer fed by frames is rejected because it contradicts the contentless-frame decision in the 4a spec. |
| Mine/theirs | Deferred | See Scope. |

## Relay contract the client uses

All shapes are in `sigil/contracts/v1/relay-api.json`, as amended by PR #33. The `ws-ticket`, `ack`, send, and `room.updated` entries are not on `main` until #33 merges, so the implementation branches off `main` after #33 merges. Plan step 0 verifies those four entries exist, and the envelope's `sender` field name, before any client code.

- `GET /v1/rooms` returns `{code, items}`. Each item has `conversation_id`, `workspace_id`, `name`, `description`, `created_at`, and `max_agent_turns`. The room ID is `conversation_id`.
- `GET /v1/rooms/{room_id}/messages?after_seq=<n>&limit=<n>` returns items with `room_seq`, `message_id`, `canonical_bytes`, and `envelope`. The list holds `room.message` and `room.event` rows.
- `POST /v1/rooms/{room_id}/messages` takes `{text, idempotency_key}` (`thread_root_id` and `mentions` are optional and unused in 4b-1). It answers 201 for a new message and 200 for a replay of a stored key.
- `POST /v1/rooms/{room_id}/ack` takes `{up_to_room_seq}` and returns `{code, acknowledged}`. The call is idempotent.
- `POST /v1/rooms/ws-ticket` returns `{code, ticket, expires_at}`. The client opens the stream on the relay's stream port (`--stream-port`) with `?ticket=<ticket>`.
- `room.updated` has `{type, room_id, room_seq?, changed}`, where `changed` is `messages` or `members`. `room_seq` is absent for `members`.
- Error bodies are `{request_id, code, message, details?}`.

## Components

```
api/client.ts     fetch wrapper: base URL, Bearer header (only authorization and content-type are sent, because the relay CORS allows exactly those); maps an error body to ApiError{code, status, requestId}
auth/             TokenGate (paste form) and the sessionStorage token store; a 401 UNAUTHENTICATED clears the token and returns to the gate
live/socket.ts    ticket, connect, reconnect with exponential backoff and a new ticket per attempt; on room.updated invalidates ['room', id] (and ['rooms'] when changed is members); refetches everything on reconnect
rooms/RoomList    useQuery(['rooms'])
rooms/Timeline    useInfiniteQuery(['room', id, 'messages']) with after_seq = last room_seq, limit 100; each fetch repeats until a page returns fewer than 100 rows; rows merged into a Map keyed by room_seq
rooms/Composer    useMutation; optimistic pending row; retry reuses the same idempotency_key
rooms/useAck      after rendered rows change and only while document.visibilityState is 'visible', posts the highest rendered room_seq; debounced, forward-only; a hidden tab acks on its next visibility change
serve/            the sigil-rooms-web bin: static server for dist/ with a CSP header; --relay-url and --stream-url (default: relay port + 1); fixed default port; prints the origin it bound
```

The token never appears in a URL. It lives in `sessionStorage`, which survives a reload and clears when the tab closes. Never `localStorage`. Script injected into the page can read `sessionStorage`; on a localhost relay serving the user's own client that risk is accepted, and two rules shrink it:

- Message text renders as plain text only. No `dangerouslySetInnerHTML`, and no markdown or link rendering in 4b-1. Agent output is untrusted (the parent spec treats the router and room content as injection-prone), and one injected script reads the token.
- `serve/` sends a `Content-Security-Policy` header: `default-src 'self'; connect-src <relay-url> <stream-url>`.

Origin matching: the relay compares `--browser-origin` exactly (scheme, host, port), so `localhost` and `127.0.0.1` do not match each other. `serve/` listens on a fixed default port so the origin is known before `relay up` starts, and it prints the origin it bound. The user opens exactly that origin, not a variant.

Stream URL: the relay derives its stream port as HTTP port + 1 only when `--port` is given (`sigil/cli/sigil.mjs:192`), so the client cannot always derive it. `serve/` takes `--stream-url` and defaults it to the relay URL with its port plus one.

This supersedes the 4a spec text on `main`, which says the client holds the token "in memory only". PR #33 (commit `6f652b3`) already revises that line to `sessionStorage`, following Chris's decision of 2026-10-06. The reason: an in-memory token forces a re-paste on every reload.

## Data flow

1. The user pastes a token. The client stores it and calls `GET /v1/rooms`.
2. The client requests a ticket, opens the stream, and shows a "Live" chip.
3. Opening a room runs the first history fetch. Rendered rows trigger the ack.
4. A `room.updated` frame invalidates the room's query. The refetch uses `after_seq`, so only new rows arrive.
5. A send adds a pending row. On a 200 or 201 the client invalidates the room's query at once and matches the pending row to the returned row by `message_id`, so the row settles even when the socket is down. The `room.updated` frame the sender receives triggers the same refetch, which dedupes.
6. A retry after a lost response reuses the same `idempotency_key`, so the relay's replay path returns 200 with the stored row and the message does not post twice.

## Error handling

| Case | Behavior |
|---|---|
| `401 UNAUTHENTICATED` on any call | Clear the token, return to the paste gate with "Token rejected". |
| `403 HUMAN_CONTEXT_REQUIRED` | Show "This token is not a human token". Keep the token. |
| `503 DATABASE_UNAVAILABLE` | Banner with the code. Query retries twice with backoff. |
| `503 ROOM_SEND_UNAVAILABLE` | Disable the composer and name the `--room-human-identity` flag. |
| `403 NO_SIGNING_KEY` | Setup error, no retry. The token's endpoint is not the loaded identity. |
| `404 ROOM_NOT_FOUND` | Drop the room from the list and return to the list. |
| `429 TICKET_CAP` | The socket backs off and retries. The timeline falls back to refetch on focus. |
| Socket drop or ticket failure | "Live: off" chip. The timeline refetches on window focus and every 30 seconds while the socket is down. |
| Network or CORS failure | Banner "Can't reach relay at `<url>`. Check `--browser-origin`." |
| Send failure | The pending row shows "Failed, retry". Retry reuses the same `idempotency_key`. |
| `400 INVALID_ENVELOPE` or `400 INVALID_REQUEST` (including text over the relay's limit) | The composer keeps the draft and shows the relay's `message`. No retry. |

The ack call is fire-and-forget. A failure logs to the console and does not surface, because the next fetch repeats it and the route is idempotent.

## Testing

- **Unit (Vitest and Testing Library, with `fetch` and `WebSocket` mocked):**
  - `api/client`: error mapping and header attachment.
  - Token store: set, and clear on 401.
  - Socket: ticket, connect, backoff, and `room.updated` triggering an invalidate.
  - Timeline merge: out-of-order frames and duplicate `room_seq`.
  - Composer: optimistic row, retry with the same key, and the 200 replay.
  - Ack: forward-only and debounced.
- **Contract test:** the contract JSON lists route paths, field names, and error codes, not types, so the test asserts only those. Each route the client calls exists, the field names the client reads are listed for that route, and each error code in the error table is listed. A contract change that drops one fails the web package's tests instead of drifting.
- **End-to-end test:** start an in-process relay with a memory repository, `--browser-origin`, and a human identity, then drive the built client in Playwright. Steps: paste a token, list rooms, send, see the message return through `room.updated`, and see the ack. This is the only test that covers the 4a CORS, ticket, and stream path in a real browser. The plan first checks whether the in-memory relay setup in core's tests is reusable here and falls back to a Postgres-backed relay if it is not.
- **Isolation and gates:** the root `package.json` has no `workspaces`, and the plan keeps it that way so core's lockfile and `npm ci` stay unchanged. The web package therefore sits outside every core gate until the plan wires it in:
  - The local pre-push hook lives in the shared git directory (`.git/hooks/pre-push`), is not written by `sigil/scripts/install-git-hooks.mjs` (which installs only `pre-commit`), and runs the full core suite. It never runs web tests. The web package's `npm test` runs on its own.
  - CI (`.github/workflows/ci.yml`) runs `npm ci` and `npm test` at the root only. The plan adds a CI job for the web package: `npm ci`, typecheck, Vitest, and the build, all inside `packages/sigil-rooms-web/`. A root script `test:web` runs the same steps locally.
  - Core's `node --test` must not pick up web tests. Web test files are `*.spec.ts` and `*.spec.tsx` under `src/` (Node 24 `node --test` also matches `*.test.ts`), with no `test/` or `tests/` directory in the package. The plan verifies that `npm test` at the root discovers none of them.
  - Core's `files` whitelist excludes `packages/`. The plan verifies it with `npm pack --dry-run`.

## Open items for the plan

- Confirm the in-memory relay setup is reusable for the end-to-end test.
- Confirm the root test run discovers no web test files, and that `npm pack --dry-run` excludes `packages/`.
- Write the web CI job and the `test:web` root script.
- Pick the static server for `serve/` (a small Node `http` handler, not a framework).

## Delivery

1. Spec review.
2. Implementation plan through the writing-plans skill, in `docs/superpowers/plans/`.
3. Plan execution through subagent-driven development, in a fresh worktree off `main` after #33 merges.
