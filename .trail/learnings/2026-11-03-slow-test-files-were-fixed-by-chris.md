---
title: "Slow test files were fixed by cutting process spawns, not raising timeouts"
author: Chris
date: 2026-11-03
standing: true
id: l-75635f12
scope: repo
status: active
src: init-review
touches:
  - sigil/cli/relay-up-ingress.test.mjs
---

## Watch out
- Windows Node 22 CI kept failing because the whole-file 30s test timeout was crossed under load. Earlier fixes targeted port collisions and missed the real cause: wall-clock time from many child processes.
- In the code: `npm test` runs `node --test --test-timeout=30000`, which caps the whole file under process isolation. Reduce spawns (e.g. init fixture once in `sigil/cli/relay-up-ingress.test.mjs`) and stub sleeps. Do not add skips, retries or timeout bumps.

_From PRs #148, #134 here, Oct 30._
