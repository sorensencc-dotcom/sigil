---
title: "Browser live updates use a content-free notify frame, then fetch history"
author: Chris
date: 2026-11-03
standing: true
id: l-8f561d5a
scope: repo
status: active
src: init-sessions
touches:
  - sigil/relay/v1/stream-server.mjs
  - "sigil/relay/v1/stream-server.mjs#createStreamServer.notifyRoom"
---

## Decided
- A pushed frame carrying message content would leak data to ticket-authenticated sockets. Instead the frame only says something changed, and the client fetches by sequence number.
- In the code: Phase 4a: `POST /v1/rooms/ws-ticket` (single-use, 60s), `room.updated` frame `{room_id, room_seq}` via `stream.notifyRoom` in `sigil/relay/v1/stream-server.mjs`, human-only recipients. The client calls `GET /v1/rooms/{id}/messages?after_seq=N`. Agents keep `delivered` frames.

_From past Claude sessions here, Oct 5._
