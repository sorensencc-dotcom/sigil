---
title: "Adding the domain to endpoint ids means re-keying Postgres, not just editing the registry"
author: Chris
date: 2026-11-19
branch: main
id: l-901edfa9
scope: repo
status: active
src: agent
touches:
  - ".serena/project.yml"
  - scripts/windows/start-sigil-stack.ps1
---

## Decided
On a relay started with --domain, sends to an endpoint only work when its id is local@domain. Recipient lookup matches the id exactly, and every live endpoint id is bare (ep_chief and the others). So the relay warns at startup that it will reject every envelope. A TLA+ statechart of the cutover (2026-11-19) shows direct delivery needs four changes together: the registry ids, the Postgres ids, the agent identity files, and a relay restart. Room delivery to chief breaks in every state where those four disagree. Do the cutover in one maintenance window with a pg_dump taken first, or alias local@<own domain> to the bare id in code. Neither has been chosen yet.

## Tried and ruled out
- Renaming ids in the registry file alone: on restart, registry seeding inserts new endpoint rows with ON CONFLICT DO NOTHING. Bot rows, room invocations, tokens and directory links stay on the old bare ids. The new endpoints get no key rows, because those key_ids already exist under the old endpoints.
- Restarting SigilStack from a non-admin shell: Stop-ScheduledTask kills only the launcher. The elevated node children keep running, and a non-elevated Stop-Process gets "Access is denied". The new launcher then logs "already running; leaving it alone". A real restart needs an Administrator shell that also kills whatever is listening on 8791/8792/8796/8797/5173 and the chief agent process.

## Watch out
- The relay's health path is /v1/health. /healthz and /readyz return 401.
- endpoint_id is the primary key of endpoints. About 15 migrations add tables that reference it, and they have no ON UPDATE CASCADE.

In the code:
- sigil/cli/sigil.mjs:315 startup warning "no endpoint ... belongs to domain"
- sigil/relay/v1/validate-envelope.mjs:52 checkRecipientLocality; sigil/relay/v1/federation-router.mjs:12 decideRoute
- sigil/cli/registry-seed.mjs:33 seedRegistry (insert-only)
- sigil/cli/registry-store.mjs:85 toRegistryMap keys on endpoint_id, with no alias field
- scripts/windows/start-sigil-stack.ps1:140-165 supervisor loop adopts running children instead of replacing them
- statechart model: scratchpad regfix/RegFix.tla
