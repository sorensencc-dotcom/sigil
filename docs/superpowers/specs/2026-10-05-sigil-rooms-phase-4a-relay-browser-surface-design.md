# Sigil rooms phase 4a: relay browser surface design

Status: draft for review, 2026-10-05; revised 2026-10-06 after code review.
Parent spec: `docs/superpowers/specs/2026-10-02-sigil-rooms-design.md` (Clients section and delivery phase 4).
Builds on: phase 3 (PR #23, merge `73f0b93`), which adds the router, `room.event`, and the relay system identity.

## Goal

A browser client can authenticate to the relay, receive live room updates, and post as the human, without holding a long-lived token in a WebSocket URL. The relay side ships and is tested before any UI exists.

## Phase 4 split

The parent spec's phase 4 (room list, timeline, threads, roster modes, Stop, approval cards) is more than one spec, plan, and implementation cycle. It splits as follows:

- **4a (this spec).** Relay browser surface: `ws-ticket`, the `room.updated` WebSocket frame, the human send route, and the Stop/fail concurrency test from the phase 3 open items.
- **4b.** The React package `@sorensencc/sigil-rooms-web`: timeline plus send first, then Stop and roster modes.
- **Later.** Approval cards. They depend on the risk gate and WebAuthn ceremony, so they get their own design.

Correction to the phase 3 wrap: the relay has no SSE. Its push transport is the WebSocket at `/v1/stream`. The wrap's "room.events not pushed over SSE" item is closed by the `room.updated` frame below.

## Scope

In scope:

- `POST /v1/rooms/ws-ticket` and ticket redemption on the WebSocket upgrade.
- `POST /v1/rooms/{room_id}/ack`, so a browser-only human can mark room deliveries read.
- The `--browser-origin` allowlist and CORS on every route the browser calls.
- A `room.updated` frame sent to human members after each room commit.
- `POST /v1/rooms/{room_id}/messages`, with relay-side signing through a `signForEndpoint` seam.
- The `--room-human-identity <path>` relay flag.
- A Postgres test for Stop and invocation-fail running concurrently with message accept.
- Contract entries in `relay-api.json`.

Out of scope, with the reason:

- Approval cards and approval routes. They need the WebAuthn design.
- The React package. That is 4b.
- Routing-quality measurement. It is a separate task before relying on the 7B router.
- Multi-relay ticket storage. Tickets live in one relay process; v1 runs one local relay. The main HTTP server and the stream server on `port+1` share one ticket store inside that process.
- Per-human signing keys. The seam allows them later; no phase needs them yet.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Browser WebSocket auth | Single-use ticket from `POST /v1/rooms/ws-ticket` | The existing `sigil-bearer.` subprotocol already works in a browser, but it sends the long-lived token in a header that tunnels and proxies log. Mobile and other-human phases need the ticket anyway. |
| Pushed frame | `room.updated` with `{room_id, room_seq?, changed}`, no content | One render path for live updates, reconnects, and catch-up. A dropped frame is repaired by the next fetch. |
| Scope of 4a | Push channel plus send | Gives 4b a working timeline with send and Stop on a finished relay. |
| Human signing | One identity loaded by `--room-human-identity`, behind `signForEndpoint` | Same trust boundary as today's CLI on a single-owner localhost. The seam keeps per-human keys a later swap. |

## Ticket auth

`POST /v1/rooms/ws-ticket`:

- Caller must be an authenticated human principal (`human_id` set). An agent endpoint gets `403`.
- Response: `{ticket, expires_at}`. The ticket is 32 random bytes, base64url. The response carries `Cache-Control: no-store`.
- Storage is in memory: SHA-256 of the ticket maps to `{endpoint_id, owner_id, human_id, expires_at}`. Raw tickets are never stored or logged. Entries live 60 seconds and are swept lazily.
- At most 8 outstanding tickets per endpoint. A ninth request answers `429`.

Shared store: the stream server listens on `port+1`, separate from the HTTP server that issues tickets. `cmdRelayUp` in `sigil/cli/sigil.mjs` builds one ticket store and passes the same instance to both (`createRelayServer` and `createStreamServer` each take it as a parameter; there is no `createRelay` function), so a ticket issued on one port redeems on the other. A test issues on the HTTP port and redeems on the stream port.

CORS and origins: browsers send `Origin` on cross-origin requests and on every WebSocket upgrade, and also on some same-origin requests (`POST`, and `fetch` with CORS mode), so a browser client cannot rely on sending none. The relay keeps an origin allowlist (`--browser-origin <origin>`, repeatable; default none, so no browser origin works until configured). CORS preflight and response headers apply to every route the browser calls: `POST /v1/rooms/ws-ticket`, `POST /v1/rooms/{room_id}/messages`, `GET /v1/rooms/{room_id}/messages` (history), the room ack route below, and the room list and member routes the 4b client uses. The stream upgrade checks `Origin` against the same list and closes 1008 on a mismatch. A request with no `Origin` header (CLI and agent clients) skips the check. The allowlist matches origins exactly (scheme, host, port) and never reflects an arbitrary `Origin` back. Where the browser gets its bearer token: `POST /v1/auth/login` does not supply one. It requires an existing bearer principal and returns a 5-minute `human_sessions` row (`session_id`, `expires_at`), not a token, and no route accepts a `session_id` as a credential. Today the only way to hold a human bearer token is `POST /v1/endpoint-tokens`, which itself needs a bearer token. Decision (Chris, 2026-10-06): the 4b client takes a pasted bearer token, which fits a relay that runs on the user's own machine and adds no auth route that would need its own security review. A session-to-token exchange route, or a relay-set `HttpOnly` cookie (the safer store, since page script never sees the token, but it adds an auth route needing its own security review), is deferred until 4b needs to work off localhost. 4a's routes (`ws-ticket`, `ack`, `messages`) work with any valid human bearer token, so this does not block 4a. The 4b client pastes the token once and keeps it in `sessionStorage`: it survives reloads and clears when the tab closes. Never `localStorage`, never a URL. Script injected into the page can read `sessionStorage`; on a localhost-only relay serving the user's own UI that risk is accepted.

Redemption: the browser opens `/v1/stream?ticket=<t>`. The upgrade handler deletes the ticket on first read, so a replay fails. The socket registers in `browserClients` (see Sockets below), not in the bearer `clients` map.

An unknown, expired, or reused ticket closes with 1008 `unauthorized`. The bearer and `sigil-bearer.` paths are unchanged for CLI and agent clients.

Residual exposure: the ticket travels in the URL, and URLs reach reverse-proxy logs, access logs, browser history, and devtools. Single use and a 60-second lifetime bound the damage, because a logged ticket is already spent. As an operational constraint, the relay never logs the raw request URL or query string for `/v1/stream`, and the docs tell anyone fronting the relay with a proxy to do the same. A test asserts that the relay's own log output never contains a ticket.

## The `room.updated` frame

Shape: `{type: 'room.updated', room_id, room_seq?, changed: 'messages' | 'members'}`. It carries no message content, sender, or body.

Membership changes do not consume a `room_seq`, so a `members` frame omits `room_seq`. The client reacts to `changed`: `messages` triggers the history fetch, `members` refetches the roster. Adding the field is cheaper than emitting a `room.event` row for every join and leave.

`stream.notifyRoom(endpointId, {room_id, room_seq, changed})` in `sigil/relay/v1/stream-server.mjs` sends it (`room_seq` is omitted for `changed: 'members'`), with the same `readyState` guard as `notify`. It returns false when no socket is connected.

Recipients are every active human member of the room, including the sender, so the sender's other tabs refresh. `room.updated` does not reuse the `emitRoomEvent` fan-out. That fan-out drops a human at 500 unacked deliveries, and a browser-only human never acks, so they would go silent. The frame is a push hint that creates no delivery row and has no cap. Agents keep the existing `delivered` frames; the bridges depend on them and this spec does not change that path.

Who acks, and why the existing ack route cannot: room deliveries start `queued` on Postgres, and the history route never moves them. Postgres refuses `queued` to `acknowledged` (`delivery-state.mjs` allows only `queued` to `delivered` or `delivery_rejected`), and history rows carry no `delivery_id` for the browser to ack. A browser-only human would otherwise never ack and the sender would never see `read`.

Decision: a bulk route, `POST /v1/rooms/{room_id}/ack` with body `{up_to_room_seq}`. In one transaction it moves every delivery for the caller's endpoint on room messages with `room_seq` at or below that value to `acknowledged`, from `queued` or `delivered`. It does this through a dedicated repository method, `acknowledgeRoomDeliveries`, not by loosening `canTransition` for every caller, so the state machine stays unchanged everywhere else. Rows already `acknowledged` or later are left alone, which makes the call idempotent. The caller must be a room member (`404 ROOM_NOT_FOUND` otherwise). After the transaction commits, the route sends one `delivery.receipt` frame per row it moved, each in its own `try`, through `sendReceiptFrame`. The alternative, adding `delivery_id` to history rows and flipping `queued` to `delivered` on read, needs one ack call per row and changes the history shape the 4b client verifies against `canonical_bytes`, so it is rejected. The 4b client calls the route after each history fetch with the highest `room_seq` it rendered; the relay does not infer reads. Until it does, the sender's receipts for that human show `queued` or `delivered`, not `read`.

The frame fires after commit, never inside the transaction, so it cannot announce a rolled-back row. Commit points:

1. Accepted `room.message` posts, from the existing envelope path and the new send route.
2. Every `emitRoomEvent` commit (router decisions, Stop and fail events).
3. Membership changes, so the roster refreshes.

One helper, `notifyRoomHumans(room, {room_seq, changed})`, is the only caller of `notifyRoom`, so no commit point can omit the frame. The helper registers the frame inside `acceptEnvelopeAsync`, not in a route handler, so the HTTP envelope route, the p2p path, and the AgentMail path all send it.

The existing `onPersisted` hook cannot carry this frame. `acceptEnvelopeAsync` calls it at `accept-envelope.mjs:439`, inside the `withTransaction` callback, before `COMMIT` in `with-transaction.mjs`. A frame sent from there can announce a row that a failed `COMMIT` then discards. (The existing `delivered` notifications share this timing. This spec leaves them unchanged.) The plan adds an after-commit queue instead:

- There are two `withTransaction` implementations and both change: `sigil/relay/v1/with-transaction.mjs` (Postgres) and the method at `sigil/cli/memory-repository.mjs:101` (the in-memory repository behind `sigil relay up`, a wrapper with a rollback undo stack). Both expose `afterCommit(fn)`.
- The queue lives in an `AsyncLocalStorage` store, so `notifyRoomHumans` finds the open transaction without threading a parameter through every caller. `memory-repository.mjs` already uses `AsyncLocalStorage` for its rollback stack.
- Nested `withTransaction` calls share the outermost queue. Callbacks run only when the outermost transaction commits, and are dropped if any level rolls back.
- A throwing callback is logged and never fails the already-committed request.
- `notifyRoomHumans` outside a transaction sends immediately.

A test forces `COMMIT` to fail and asserts that no frame arrives.

Sockets. `createStreamServer` keeps one socket per endpoint (`clients.set(endpointId, socket)`), so a second connection evicts the first. With one human identity, a browser tab and the CLI inbox listener share an endpoint and would evict each other. Ticket sockets therefore live in a separate map, `browserClients: Map<endpoint_id, Set<socket>>`. `notifyRoom` sends to every socket in the set, and a closing socket removes only itself. Two tabs both receive frames, and a browser never evicts a bearer socket. Bearer-socket behavior and the existing frames do not change.

Client contract: on a frame, call `GET /v1/rooms/{id}/messages?after_seq=<last seen>`. On reconnect, make the same fetch for each open room. Frames are hints; the client dedupes by `room_seq`.

Already verified: the history route returns `room.event` rows next to `room.message` rows. `listRoomMessages` filters on `conversation_id` and `room_seq` only, with no `message_type` filter (`postgres-repository.mjs:1830-1841`). The plan adds a test that pins this, and checks that the in-memory repository behaves the same.

`persistAcceptedEnvelope` returns `room_seq` at no call site today. The two room callers, `accept-envelope.mjs:429` and `room-events.mjs:48`, already hold it in a local variable, so the plan passes that variable to `notifyRoomHumans`. The repository does not change. Duplicate-accept paths get `room_seq` from `lookupRoomMessage`.

## Human send route

`POST /v1/rooms/{room_id}/messages`:

- Request: `{text, thread_root_id?, mentions?, idempotency_key}`. The first three are the only fields `room.message` allows; the route calls `validateRoomMessageBody` so the HTTP shape cannot drift from the envelope shape.
- Caller must be a human principal and a room member. The relay binds the sender from the authenticated token and ignores any sender field.
- Response: `201 {message_id, room_seq}`. A repeated `idempotency_key` returns the original result with `200`.

Idempotency. A retry that builds a fresh envelope with the same key would hit a unique-key conflict (`409`, or `500` when two retries race). The route therefore:

1. Scopes the key to the room, so the same key in two rooms does not collide.
2. Looks the key up before building an envelope and returns the stored `message_id` and `room_seq` with `200`.
3. Handles a racing retry that loses the insert. `acceptEnvelopeAsync` turns any error it does not define into `500 INTERNAL_ERROR` (`toResponse`, `accept-envelope.mjs:117-127`), so a raw `23505` never reaches the route. The accept pipeline therefore maps a unique violation on the idempotency key to its own typed code, `IDEMPOTENCY_RACE`, added to `statusByCode`. The send route catches that code, re-reads the stored row through the idempotency lookup, and answers `200` with the stored `message_id` and `room_seq`. `IDEMPOTENCY_RACE` is never returned to a client.
4. The in-memory repository must reject a duplicate key the same way. Today it overwrites the earlier entry silently (`persistAcceptedEnvelope` sets the `idempotency` map without checking), so a relay without a database would accept two messages for one key. The plan makes it throw `IDEMPOTENCY_RACE` and tests both repositories.

Signing seam: `signForEndpoint(endpoint_id)` returns a signer or throws `NO_SIGNING_KEY`. The v1 implementation holds the single identity loaded from `--room-human-identity <path>`. It refuses any other endpoint. At startup the relay checks that the identity file's public key matches the key the registry holds for that endpoint, the way `ROOM_SYSTEM_KEY_MISMATCH` does for the system identity (`postgres-repository.mjs:494-499`, `memory-repository.mjs:234`), and refuses to start on a mismatch. Checking `kind` alone is not enough: the registry defaults `kind` to human while Postgres rows default to agent, so a kind check can pass or fail for the wrong reason. A relay-built envelope is signed with this key, so a mismatch would fail verification at accept time. Routes call the seam and never read key material. The route also checks that the authenticated principal's endpoint equals the loaded identity's endpoint before it asks for a signer, so the seam is never the only guard.

Without `--room-human-identity`, the route answers `503`, as the router route does without `--room-system-identity`. Existing behavior is unchanged.

Path: the relay builds the envelope with the `LocalOutbox` pattern `emitRoomEvent` uses, then sends it through the existing accept pipeline. Room policy, `room_seq` assignment, fan-out, the agent hop budget, and the router all run as they do for CLI-posted messages. There is no second persistence path.

Accept options. `acceptEnvelopeAsync` has four call sites, and each builds its own options today: `POST /v1/envelopes` (`http-server.mjs`), the new send route, the libp2p path (`p2p-data-protocol.mjs`, through `wireDataProtocol`), and AgentMail (`agentmail-adapter.mjs`). `POST /v1/envelopes` passes `registered`, `request_id`, `now`, `repository`, `relayDomain`, `persist`, `federationMode`, `federationIdentity`, `fetchImpl`, `stream_seq`, `resendMetrics`, `logger`, `onPersisted`, and `systemIdentity`. The p2p path does not pass `systemIdentity`, and AgentMail passes none of the stream or room options, so room messages accepted through them would skip routing and `room.updated`. One options builder, `buildAcceptOptions`, produces the full set, and all four call sites use it, overriding only what differs per transport (`request_id`, and for p2p the peer identity check). The plan adds a test that fails when any call site omits an option the builder sets.

Verified: `acceptEnvelopeAsync` is exported and already called in-process by the AgentMail and p2p paths, so no extraction is needed. The relay-built envelope passes verification only if the identity file's key matches the registry, which the startup check enforces. Do not call the route over loopback.

## Tests

Unit tests, in the repo's `*.test.mjs` pattern:

- Ticket issue, single use, 60-second expiry, the 8-outstanding cap, human-only access, and no raw ticket in logs.
- WebSocket upgrade accepts a valid ticket and rejects a replayed, expired, or unknown one with 1008.
- `room.updated` frame shape, human-only recipients, no content.
- Send route: validation reuse, member and human checks, `idempotency_key` replay returning `200`, two racing retries both answering `200` with one stored message, the same key in two rooms creating two messages, and `503` without the flag.
- All four accept call sites use the shared options builder, and a room message accepted over p2p or AgentMail sends `room.updated` and reaches the router.
- `POST /v1/rooms/{room_id}/ack` moves `queued` and `delivered` deliveries to `acknowledged` up to `up_to_room_seq`, is idempotent, rejects non-members, leaves other callers' deliveries alone, and sends one receipt frame per moved row.
- A racing retry loses the insert, gets `IDEMPOTENCY_RACE` internally, and the client sees `200` with the stored result. The in-memory repository throws on a duplicate key instead of overwriting.
- CORS: preflight and response headers on every browser-called route for an allowlisted origin, none for another origin, and the stream upgrade rejects a bad `Origin` with 1008 while a request with no `Origin` passes.
- Startup refuses a human identity whose key differs from the registry key for that endpoint.
- Ticket store: issue on the HTTP port, redeem on the stream port. CORS preflight answers only allowlisted origins.
- `room.updated` goes to every active human member, including the sender, with no 500-delivery cap, and a `members` frame carries `changed: 'members'` and no `room_seq`.
- Nested `withTransaction`: after-commit callbacks run once, only when the outermost transaction commits, against both the Postgres and in-memory implementations.
- The signing seam refuses any endpoint other than the loaded identity.

Integration test: open a ticket socket, post as the human, and assert exactly one `room.updated` arrives after commit. Force a rollback and assert no frame arrives.

Postgres test (`*.pg.test.mjs`, behind `assert-disposable-test-db.mjs`), closing the phase 3 gap: Stop and invocation-fail run concurrently with accepting a new `room.message` in the same room. Lock order was checked against the code: accept takes the room through `UPDATE rooms` when it assigns `room_seq` (`postgres-repository.mjs:1808-1815`), while Stop and fail call `lockRoom` first (`SELECT ... FOR UPDATE`, `:1816-1821`; `room-routes.mjs:202-230`), and `cancelRoomInvocations` touches only queued and running rows (`:1761-1768`). Codex's review found no lock-order inversion. The test pins that. The plan fixes exact assertions. The invariants:

- No invocation triggered before the Stop event's `room_seq` is still running after Stop commits. An invocation triggered by a message with a higher `room_seq` is a new invocation and is allowed.
- Stop that emits no event (nothing was queued or running) holds the same invariant. The test asserts it against the room's `room_seq` at the time Stop committed.
- `room_seq` stays gapless.
- Stop-event and message order matches `room_seq`.

The test runs in a loop, because one pass proves little for a race.

## Contracts and docs

- Add `ws-ticket`, the send route, and the `room.updated` frame to `relay-api.json`.
- Document `--room-human-identity` and `--browser-origin` in the `relay up` help text in `sigil/cli/sigil.mjs`.
- Add `POST /v1/rooms/{room_id}/ack` to `relay-api.json`.
- Update the parent spec's phase 4 line to point at the 4a/4b split.

## Risks

- A relay that holds a human key can forge that human's messages. On single-owner localhost this matches the CLI's trust boundary. The other-humans phase must replace the v1 signer before any second human joins.
- Tickets are process-local. A relay restart invalidates outstanding tickets; the client requests a new one and reconnects.
