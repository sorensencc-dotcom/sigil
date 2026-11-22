---
title: "Judge the rooms client from a fresh build, not the running one, and use a throwaway stack to walk it"
author: Chris
date: 2026-11-22
branch: docs/rooms-web-live-walkthrough
cost: { minutes: 1, tokens: 1073 }
id: l-f3e8ec9f
scope: repo
status: active
src: agent
touches:
  - docs/superpowers/specs/2026-11-22-rooms-web-live-walkthrough.md
---

## Decided
The running rooms client is served from a prebuilt dist that a merge to main does not update. Rebuild and restart before using it as a visual baseline. Walk the UI on a throwaway in-memory relay with a test identity, never the OAuth-backed live stack.

## Tried and ruled out
Signing in to the live client: it uses GitHub OAuth for the owner's real account. A stub agent through the claude bridge: the bridge spawns a fixed CLI command, so the stub failed with CLI_START_FAILED. Router, hold, and cap events stay unseen without a real agent.

## Watch out
Live relay is on 8791, not 8765 as AGENTS.md says. A room system identity must be endpoint ep_relay_system, owner relay_system, with no @local suffix. The dev relay has no Postgres, so Settings shows DATABASE_UNAVAILABLE.

In the code:
Live dist: C:\dev\sigil-repo\packages\sigil-rooms-web\dist. Dev stack: sigil relay up --port 7777 --stream-port 7778 --browser-origin http://127.0.0.1:5199 --room-human-identity <id> ; node packages/sigil-rooms-web/bin/sigil-rooms-web.mjs --port 5199 --relay-url http://127.0.0.1:7777
