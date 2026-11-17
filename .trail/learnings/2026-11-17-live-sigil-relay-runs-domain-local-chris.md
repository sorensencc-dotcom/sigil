---
title: "Live Sigil relay runs domain local with its registry inside the repo, which blocks the Phase 7 first apply"
author: Chris
date: 2026-11-17
branch: main
id: l-c9d2bdfb
scope: repo
status: active
src: agent
touches:
  - ".serena/project.yml"
  - scripts/windows/start-sigil-stack.ps1
---

## Decided
Issue 201 read-only checks, 2026-11-16. The live relay (SigilStack scheduled task) runs with domain `local`, while the approved first-group endpoints are @rewritelabs.io. Its registry and operator identity live inside the repo, and Phase 7 setup rejects paths inside the repo. Registry refresh from #194 is deployed: the relay started from a commit that contains the merge, and the refresh call is unconditional.

In the code:
- scripts/windows/start-sigil-stack.ps1 relay args: `--domain local`, `--registry .sigil/registry.json`, `--room-human-identity .sigil/antigravity.identity.json`
- sigil/cli/phase7-setup-policy.mjs:57 (endpoint domain must equal relayDomain), :77 (path must be outside the repo)
- sigil/cli/sigil.mjs:451 startRegistryRefresh is unconditional in cmdRelayUp
- sigil/scripts/phase7-setup.mjs:373 probeRegistryRefresh is hardcoded 'unverified', so planSetup blocks bot creation
- DB: localhost:55432 db sigil (docker sigil_postgres)

## Tried and ruled out
Reading the Floor Warden webhook env values to learn the auth scheme was denied and is not needed. The bridge defaults to `Authorization: Bearer` (floor-warden-bridge.mjs:52), and the reply gate accepts only Bearer (floor-warden-gate.mjs:8).

## Watch out
- The launcher's FloorWardenBotId 016f0b34 is the ep_chief roster row, not the approved Floor Warden bot 8e21de41.
- ep_grokbot already exists and differs from the approved ep_grok_bot by one underscore.
- The registry ACL grants Authenticated Users modify rights on a file the relay hot-reloads.
