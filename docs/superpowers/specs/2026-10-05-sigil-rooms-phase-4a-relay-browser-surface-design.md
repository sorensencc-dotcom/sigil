# Sigil rooms phase 4a: relay browser surface design

Status: draft for review, 2026-10-05.
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
- A `room.updated` frame sent to human members after each room commit.
- `POST /v1/rooms/{room_id}/messages`, with relay-side signing through a `signForEndpoint` seam.
- The `--room-human-identity <path>` relay flag.
- A Postgres test for Stop and invocation-fail running concurrently with message accept.
- Contract entries in `relay-api.json`.

Out of scope, with the reason:

- Approval cards and approval routes. They need the WebAuthn design.
- The React package. That is 4b.
- Routing-quality measurement. It is a separate task before relying on the 7B router.
- Multi-relay ticket storage. Tickets live in one relay process; v1 runs one local relay.
- Per-human signing keys. The seam allows them later; no phase needs them yet.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Browser WebSocket auth | Single-use ticket from `POST /v1/rooms/ws-ticket` | The existing `sigil-bearer.` subprotocol already works in a browser, but it sends the long-lived token in a header that tunnels and proxies log. Mobile and other-human phases need the ticket anyway. |
| Pushed frame | `room.updated` with `{room_id, room_seq}`, no content | One render path for live updates, reconnects, and catch-up. A dropped frame is repaired by the next fetch. |
| Scope of 4a | Push channel plus send | Gives 4b a working timeline with send and Stop on a finished relay. |
| Human signing | One identity loaded by `--room-human-identity`, behind `signForEndpoint` | Same trust boundary as today's CLI on a single-owner localhost. The seam keeps per-human keys a later swap. |

## Ticket auth

`POST /v1/rooms/ws-ticket`:

- Caller must be an authenticated human principal (`human_id` set). An agent endpoint gets `403`.
- Response: `{ticket, expires_at}`. The ticket is 32 random bytes, base64url. The response carries `Cache-Control: no-store`.
- Storage is in memory: SHA-256 of the ticket maps to `{endpoint_id, owner_id, human_id, expires_at}`. Raw tickets are never stored or logged. Entries live 60 seconds and are swept lazily.
- At most 8 outstanding tickets per endpoint. A ninth request answers `429`.

Redemption: the browser opens `/v1/stream?ticket=<t>`. The upgrade handler deletes the ticket on first read, so a replay fails. The socket then registers under the ticket's endpoint exactly as a bearer-authenticated socket does.

An unknown, expired, or reused ticket closes with 1008 `unauthorized`. The bearer and `sigil-bearer.` paths are unchanged for CLI and agent clients.

## The `room.updated` frame

Shape: `{type: 'room.updated', room_id, room_seq}`. It carries no message content, sender, or body.

`stream.notifyRoom(endpointId, {room_id, room_seq})` in `sigil/relay/v1/stream-server.mjs` sends it, with the same `readyState` guard as `notify`. It returns false when no socket is connected.

Recipients are human members only, the same rule `emitRoomEvent` uses for fan-out. Agents keep the existing `delivered` frames; the bridges depend on them and this spec does not change that path.

The frame fires after commit, never inside the transaction, so it cannot announce a rolled-back row. Commit points:

1. Accepted `room.message` posts, from the existing envelope path and the new send route.
2. Every `emitRoomEvent` commit (router decisions, Stop and fail events).
3. Membership changes, so the roster refreshes.

One helper, `notifyRoomHumans(room, roomSeq)`, is the only caller of `notifyRoom`, so no commit point can omit the frame.

Client contract: on a frame, call `GET /v1/rooms/{id}/messages?after_seq=<last seen>`. On reconnect, make the same fetch for each open room. Frames are hints; the client dedupes by `room_seq`.

Verify during planning:

- Whether `persistAcceptedEnvelope` returns `room_seq` to every call site.
- Whether the history route returns `room.event` rows next to `room.message` rows. If it does not, 4a adds them, because the timeline needs decision and Stop events.

## Human send route

`POST /v1/rooms/{room_id}/messages`:

- Request: `{text, thread_root_id?, mentions?, idempotency_key}`. The first three are the only fields `room.message` allows; the route calls `validateRoomMessageBody` so the HTTP shape cannot drift from the envelope shape.
- Caller must be a human principal and a room member. The relay binds the sender from the authenticated token and ignores any sender field.
- Response: `201 {message_id, room_seq}`. A repeated `idempotency_key` returns the original result with `200`.

Signing seam: `signForEndpoint(endpoint_id)` returns a signer or throws `NO_SIGNING_KEY`. The v1 implementation holds the single identity loaded from `--room-human-identity <path>`. It refuses any other endpoint. At startup the relay checks that the identity is registered as a human endpoint. Routes call the seam and never read key material.

Without `--room-human-identity`, the route answers `503`, as the router route does without `--room-system-identity`. Existing behavior is unchanged.

Path: the relay builds the envelope with the `LocalOutbox` pattern `emitRoomEvent` uses, then sends it through the existing accept pipeline. Room policy, `room_seq` assignment, fan-out, the agent hop budget, and the router all run as they do for CLI-posted messages. There is no second persistence path.

Verify during planning: whether the accept pipeline can be called in-process with a relay-built envelope or only through the HTTP handler. If only through the handler, extract a shared function. Do not call the route over loopback.

## Tests

Unit tests, in the repo's `*.test.mjs` pattern:

- Ticket issue, single use, 60-second expiry, the 8-outstanding cap, human-only access, and no raw ticket in logs.
- WebSocket upgrade accepts a valid ticket and rejects a replayed, expired, or unknown one with 1008.
- `room.updated` frame shape, human-only recipients, no content.
- Send route: validation reuse, member and human checks, `idempotency_key` replay returning `200`, and `503` without the flag.
- The signing seam refuses any endpoint other than the loaded identity.

Integration test: open a ticket socket, post as the human, and assert exactly one `room.updated` arrives after commit. Force a rollback and assert no frame arrives.

Postgres test (`*.pg.test.mjs`, behind `assert-disposable-test-db.mjs`), closing the phase 3 gap: Stop and invocation-fail run concurrently with accepting a new `room.message` in the same room. The plan fixes exact assertions after reading `lockRoom` and `cancelRoomInvocations`. The invariants:

- No invocation is running after Stop commits.
- `room_seq` stays gapless.
- Stop-event and message order matches `room_seq`.

The test runs in a loop, because one pass proves little for a race.

## Contracts and docs

- Add `ws-ticket`, the send route, and the `room.updated` frame to `relay-api.json`.
- Document `--room-human-identity` in the `relay up` help text in `sigil/cli/sigil.mjs`.
- Update the parent spec's phase 4 line to point at the 4a/4b split.

## Risks

- A relay that holds a human key can forge that human's messages. On single-owner localhost this matches the CLI's trust boundary. The other-humans phase must replace the v1 signer before any second human joins.
- Tickets are process-local. A relay restart invalidates outstanding tickets; the client requests a new one and reconnects.
