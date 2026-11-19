---
title: Floor Warden bot replies only land in the room once its reply token is configured
author: Chris
date: 2026-11-19
branch: main
id: l-d7079c0b
scope: repo
status: active
src: agent
touches:
  - scripts/windows/start-sigil-stack.ps1
---

## Decided
To test a Phase 7 room bot end to end, post a room message that mentions it, then check that relay.out.log shows `relay.reply_persisted`. `relay.reply_received` alone is not enough. A reply only persists when the external routine sends the bot's reply token together with the Cloudflare Access service-token headers. Configuring that token turned a REPLY_TIMEOUT into a persisted reply in about 1.5 minutes.

## Tried and ruled out
Testing before the reply tokens were created: the relay logged `relay.reply_received` twice for that invocation but never `relay.reply_persisted`, and the room got an `invocation_failed` / `REPLY_TIMEOUT` event about 15 minutes after the post.

## Watch out
The first forward from the bot to the routine's webhook can time out. The bridge retries up to 5 times, and the second attempt worked after about 40 s. A floor_warden.err.log line "webhook ... unavailable (timeout), attempt 1 of 5" is not a failure on its own.

In the code:
- Room post: `POST /v1/rooms/<id>/messages` with body `{text, idempotency_key, mentions:[endpoint_id]}` and header `X-Sigil-CSRF: 1`; needs a human browser session.
- Reply tokens: `sigil bot token create --bot-id <id>`; it needs `SIGIL_DATABASE_URL` set in the shell first.
- Logs: `.sigil/logs/relay.out.log` (hops `relay.invocation_created`, `relay.reply_received`, `relay.reply_persisted`) and `.sigil/logs/<bot>.err.log`.
