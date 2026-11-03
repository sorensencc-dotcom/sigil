---
title: Two reapers sharing the job queue could send the same federated message twice
author: Chris
date: 2026-11-03
standing: true
id: l-00032e0d
scope: repo
status: active
src: init-sessions
touches:
  - sigil/relay/v1/postgres-repository.mjs
  - sigil/cli/memory-repository.mjs
  - sigil/relay/v1/federation-reaper.mjs
  - "sigil/cli/memory-repository.mjs#createMemoryRepository.renewRelayJobLease"
  - "sigil/relay/v1/postgres-repository.mjs#PostgresRepository.renewRelayJobLease"
---

## Decided
- A reaper whose lease had expired still posted a row that another reaper had reclaimed. Its finalize was discarded but the peer got the job twice. A schedule explorer on in-process Postgres found it.
- In the code: Fix: `renewRelayJobLease` in `sigil/relay/v1/postgres-repository.mjs` and `sigil/cli/memory-repository.mjs`, called right before each send in `sigil/relay/v1/federation-reaper.mjs`. It skips the row if renewal updates nothing. Re-verify with `packages/relay-jobs-verification` (PGlite).

_From past Claude sessions here, Oct 25._
