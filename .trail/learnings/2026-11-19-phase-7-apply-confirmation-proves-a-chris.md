---
title: "Phase 7 apply confirmation proves a config label, not the target database"
author: Chris
date: 2026-11-19
branch: docs/trail-learning-issue-219
id: l-3a1885ed
scope: repo
status: active
src: agent
touches:
  - ".serena/project.yml"
  - scripts/windows/start-sigil-stack.ps1
---

## Decided
Treat two Phase 7 setup gaps as open until fixed: the typed phrase names a label, and the registry-refresh gate can be satisfied by config. Review posted on issue 200 (2026-11-19); the issue stays open because that read was not independent.

## Tried and ruled out
- Closing issue 200 on this review: it was a code read only, with no run, and it skipped the inspect module, the runbook and the tests.

## Watch out
- `APPLY PHASE7 <dbLabel>` compares typed text to a free-text label in setup.json, not to the host or database name in the URL held by `databaseEnv`.
- `registryRefreshConfirmed: true` in setup.json returns `verified` without any live relay check, and apply is gated on `verified`.
- The fallback probe is an unauthenticated GET to the loopback relay `/v1/health`.

In the code:
- sigil/cli/phase7-setup-policy.mjs (`authorized`)
- sigil/scripts/phase7-setup.mjs (`probeRegistryRefreshStatus`)
- sigil/cli/phase7-setup-apply.mjs (`applySetup` refresh gate)
