---
title: Floor Warden watch is an explicit table; accidental transitions stay allowed
author: Chris
date: 2026-11-08
branch: main
id: l-b2781b5e
scope: repo
status: active
src: agent
touches:
  - ".serena/project.yml"
  - sigil/bridges/v1/floor-warden-bridge.mjs
---

## Decided
- Floor Warden invocation watch is an explicit named-state table (`deriveWatchState` + `applyWatchEvent`) in the same shape as delivery-state. The bridge still owns I/O; flag mutations for arm, fail, forward, halt, recover, and close go through the reducer.
- Accidental rows from the approved table stay allowed and tagged `accidental: true` so a later fix is a choice. Forbidden timer events without a watch are rejected (no-op). Rejecting those accidental rows would change UX (handle-after-close would not POST; fail-watch would block a second POST; recover-after-close would not fail stale running invocations).

## Tried and ruled out
- Sending every poll tick through `applyAndCommit`: a 15-minute watch at 2s poll reads the session file hundreds of times and made the deadline tests ~15× slower. Poll/deadline counters stay in memory; the reducer owns the named-state mutations.

## Watch out
- ArmedNoForward is one derived state for both an unconfirmed `fail()` watch and recover of a never-forwarded running invocation. Splitting them would change the fail-watch + handle POST.
- Closed is a process-wide overlay; session maps can still hold forwards, attempts, and halts.

## In the code:
- `sigil/bridges/v1/floor-warden-watch-state.mjs` (`STATES`, `EVENTS`, `TRANSITIONS`, `applyWatchEvent`)
- `sigil/bridges/v1/floor-warden-bridge.mjs` (`applyAndCommit`)
