---
title: "Relay signs human messages with one configured identity, behind a swappable seam"
author: Chris
date: 2026-11-03
standing: true
id: l-282e0855
scope: repo
status: active
src: init-sessions
touches:
  - "sigil/relay/v1/room-human-signer.mjs#createRoomHumanSigner.signForEndpoint"
---

## Decided
- A relay-signed message speaks as the human's endpoint, so it is a security decision. v1 uses one human identity on the relay, the same trust boundary as the CLI.
- In the code: Relay loads the identity via `--room-human-identity <path>`. Route `POST /v1/rooms/{room_id}/messages` goes through `signForEndpoint`, which refuses any other endpoint. Return 503 when the flag is unset.

_From past Claude sessions here, Oct 5._
