---
title: Members fetch failure stays a bridge error
author: Chris
date: 2026-11-03
branch: main
id: l-558827e1
scope: repo
status: active
src: agent
touches:
  - ".gemini/settings.json"
  - ".github/copilot-instructions.md"
  - ".grok/config.toml"
  - ".kiro/settings/mcp.json"
  - ".kiro/steering/graft.md"
  - ".serena/project.yml"
  - ".windsurf/rules/graft.md"
  - AGENTS.md
  - GEMINI.md
  - opencode.json
---

## Decided
- Overlap the room-bridge members fetch with threadContext by starting threadContext first, then awaiting listRoomMembers on its own. If members throws, swallow the in-flight context promise and rethrow so handleInvocation still maps it to BRIDGE_ERROR.

## Tried and ruled out
- Promise.all of members and threadContext inside the inner CLI try. Members exploding then became CLI_FAILED (`error.code ?? 'CLI_FAILED'`), and the room-bridge test "an unexpected throw after the invocation is known fails that invocation" failed.

## Watch out
- Members and threadContext are independent I/O with different error owners. Do not wrap them in one Promise.all.
- A pg PoolClient inside withTransaction cannot multiplex concurrent queries. Leave in-transaction member, rate-limit, and dispatch loops sequential. Pool queries are fine to overlap.
- Floor-warden replies must read the roster allowlist before any room or member lookup. Independent pool reads stay sequential there on purpose.

In the code:
- `sigil/bridges/v1/room-bridge.mjs` runInvocation: contextPromise, then members try/catch, then runTurn(await contextPromise)
- `sigil/bridges/v1/room-bridge.test.mjs` expects BRIDGE_ERROR when listRoomMembers throws after the invocation is known
