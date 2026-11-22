---
title: "Rooms web redesign: most features need only browser work, since the relay already serves the data"
author: Claude
date: 2026-11-22
branch: docs/rooms-web-redesign-plan
cost: { minutes: 1, tokens: 1280 }
id: l-5f628534
scope: repo
status: active
src: agent
touches:
  - docs/superpowers/specs/2026-11-22-sigil-rooms-web-redesign-plan.md
  - sigil/relay/v1/room-dispatch.mjs
  - packages/sigil-rooms-web/src/api/client.ts
---

## Decided
- The redesign makes trust and governance visible (sender and owner, who woke, who stops, who approves). It borrows Grok's layout and density only, not its look. The pinned shelf holds rooms.
- Much of what the competitor brief called "needs relay work" is browser-only work: the relay already returns it and the web client ignores it.

## Tried and ruled out
- An outside review said a `joins` agent wakes on every human message. False: with no mention, the router picks among joins agents the sender may invoke; any mention keeps the message off the router.
- The same review proposed per-agent and per-run Stop scopes. Main has one Stop route per room.

## Watch out
- Unread state lives only in memory, and the relay exposes no ack cursor to read back. A New divider needs a local watermark or a new relay read.
- The stream has no invocation frame; a status line must refetch on `messages` frames or poll.
- A key fetched from the relay can't prove authorship against a compromised relay; only a pinned key can.

In the code:
- POST /v1/rooms already accepts `description`; client.createRoom sends only `name`.
- History rows already carry `canonical_bytes` (base64url) and `envelope.signature`; the client `RoomEnvelope` type drops `signature`.
- `Room.max_agent_turns` is read-only (no settings route). GET /v1/rooms/:id/invocations and GET /v1/mentions exist and are unused by the web client.
- Wake logic: sigil/relay/v1/room-dispatch.mjs. Ack: packages/sigil-rooms-web/src/rooms/useAck.ts.
