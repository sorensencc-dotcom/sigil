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
- A mine/theirs split in the timeline. No route tells the client its own endpoint ID. The client records the `sender` of its first successful send and styles later rows by it. Before that, rows carry no split. A `GET /v1/me` route is a new auth-adjacent route with its own review, so this spec does not add one.
- Cookie or session-exchange login. Deferred in the 4a spec until the client has to work off localhost.
- Approval cards, offline outbox, mobile PWA, and any non-localhost deployment.

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

All shapes are in `sigil/contracts/v1/relay-api.json`.

- `GET /v1/rooms` returns `{code, items}`. Each item has `conversation_id`, `workspace_id`, `name`, `description`, `created_at`, and `max_agent_turns`. The room ID is `conversation_id`.
- `GET /v1/rooms/{room_id}/messages?after_seq=<n>&limit=<n>` returns items with `room_seq`, `message_id`, `canonical_bytes`, and `envelope`. The list holds `room.message` and `room.event` rows.
- `POST /v1/rooms/{room_id}/messages` takes `{text, idempotency_key}` (`thread_root_id` and `mentions` are optional and unused in 4b-1). It answers 201 for a new message and 200 for a replay of a stored key.
- `POST /v1/rooms/{room_id}/ack` takes `{up_to_room_seq}` and returns `{code, acknowledged}`. The call is idempotent.
- `POST /v1/rooms/ws-ticket` returns `{code, ticket, expires_at}`. The client opens the stream on the relay's stream port (`--stream-port`) with `?ticket=<ticket>`.
- `room.updated` has `{type, room_id, room_seq?, changed}`, where `changed` is `messages` or `members`. `room_seq` is absent for `members`.
- Error bodies are `{request_id, code, message, details?}`.

## Components

```
api/client.ts     fetch wrapper: base URL, Bearer header, X-Sigil-Request-Id; maps an error body to ApiError{code, status, requestId}
auth/             TokenGate (paste form) and the sessionStorage token store; a 401 UNAUTHENTICATED clears the token and returns to the gate
live/socket.ts    ticket, connect, reconnect with exponential backoff and a new ticket per attempt; on room.updated invalidates ['room', id] (and ['rooms'] when changed is members); refetches everything on reconnect
rooms/RoomList    useQuery(['rooms'])
rooms/Timeline    useInfiniteQuery(['room', id, 'messages']) with after_seq = last room_seq; rows merged into a Map keyed by room_seq
rooms/Composer    useMutation; optimistic pending row; retry reuses the same idempotency_key
rooms/useAck      after rendered rows change, posts the highest rendered room_seq; debounced, forward-only
serve/            the sigil-rooms-web bin: static server for dist/, --relay-url, prints the --browser-origin value
```

The token never appears in a URL. It lives in `sessionStorage`, which survives a reload and clears when the tab closes. Never `localStorage`. Script injected into the page can read `sessionStorage`; on a localhost relay serving the user's own client that risk is accepted, as in the 4a spec.

## Data flow

1. The user pastes a token. The client stores it and calls `GET /v1/rooms`.
2. The client requests a ticket, opens the stream, and shows a "Live" chip.
3. Opening a room runs the first history fetch. Rendered rows trigger the ack.
4. A `room.updated` frame invalidates the room's query. The refetch uses `after_seq`, so only new rows arrive.
5. A send adds a pending row. The POST result is reconciled by the refetch that the `room.updated` frame for the user's own message triggers; the sender receives that frame too.
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

The ack call is fire-and-forget. A failure logs to the console and does not surface, because the next fetch repeats it and the route is idempotent.

## Testing

- **Unit (Vitest and Testing Library, with `fetch` and `WebSocket` mocked):**
  - `api/client`: error mapping and header attachment.
  - Token store: set, and clear on 401.
  - Socket: ticket, connect, backoff, and `room.updated` triggering an invalidate.
  - Timeline merge: out-of-order frames and duplicate `room_seq`.
  - Composer: optimistic row, retry with the same key, and the 200 replay.
  - Ack: forward-only and debounced.
- **Contract test:** the TypeScript types for the routes above are checked against `sigil/contracts/v1/relay-api.json`, so a contract change fails the web package's tests instead of drifting.
- **End-to-end test:** start an in-process relay with a memory repository, `--browser-origin`, and a human identity, then drive the built client in Playwright. Steps: paste a token, list rooms, send, see the message return through `room.updated`, and see the ack. This is the only test that covers the 4a CORS, ticket, and stream path in a real browser. The plan first checks whether the in-memory relay setup in core's tests is reusable here and falls back to a Postgres-backed relay if it is not.
- **Isolation:** the web package has its own `npm test`. The plan verifies that core's `node --test` run and the pre-push hook do not pick up the web package's tests, and that core's `files` whitelist excludes `packages/`.

## Open items for the plan

- Confirm the in-memory relay setup is reusable for the end-to-end test.
- Confirm core's test glob and pre-push hook skip `packages/`.
- Pick the static server for `serve/` (a small Node `http` handler, not a framework).
- Decide whether `sigil-rooms-web` takes `--relay-url` only, or also the stream port, or derives it. The relay's `--stream-port` is separate from its HTTP port.

## Delivery

1. Spec review.
2. Implementation plan through the writing-plans skill, in `docs/superpowers/plans/`.
3. Plan execution through subagent-driven development, in a fresh worktree off `main` after #33 merges.
