---
title: Keep MCP connectors isolated from room services
author: Chris
date: 2026-11-21
branch: codex/kb-sync-connector-service-20261121
cost: { minutes: 17, tokens: 53534 }
id: l-d022f618
scope: repo
status: active
src: agent
touches:
  - sigil/cli/service-config.mjs
  - docs/service-config.md
  - sigil/cli/connector-daemon.mjs
---

## Decided
Use Sigil's existing per-component supervisor with a dedicated connector-only service config for the KB-Sync MCP endpoint because this gives it independent install, start, stop, status, restart, and log handling without coupling it to rooms.

## Tried and ruled out
A bespoke connector supervisor duplicates the lifecycle implementation. Reusing the legacy whole-mesh startup path couples this endpoint to rooms and can restart unrelated components, so neither meets the isolation requirement as directly.

## Watch out
Service commands control every component listed in the selected config. Keep the KB-Sync config connector-only. Add future providers through fixed Sigil adapters because arbitrary commands from config would turn service management into a code execution surface.

## In the code
`sigil/cli/service-config.mjs` validates `connectors[]` and creates `connector-<name>` plans. The standalone example is `.sigil/kb-sync-service.json` in `docs/service-config.md`; it uses `sigil/cli/connector-daemon.mjs` on loopback port 4411 and an explicit relay URL.
