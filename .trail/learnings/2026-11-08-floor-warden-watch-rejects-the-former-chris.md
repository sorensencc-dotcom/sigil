---
title: Floor Warden watch rejects the former accidental rows
author: Chris
date: 2026-11-08
branch: main
id: l-d3fa8539
scope: repo
status: active
replaces: l-b2781b5e
src: agent
touches:
  - ".serena/project.yml"
  - sigil/bridges/v1/floor-warden-bridge.mjs
  - sigil/bridges/v1/floor-warden-bridge.test.mjs
  - sigil/bridges/v1/floor-warden-watch-state.mjs
  - sigil/bridges/v1/floor-warden-watch-state.test.mjs
---

## Decided
- Former accidental watch rows are forbidden, except OrphanForward recover.fail.retry which re-arms a watch so a failed timeout confirm is retried.
- Close is a hard shutdown: handle does not POST, recover does not fail invocations.
- FailWatching (unconfirmed fail, watch.source=fail) is a separate derived state from ArmedNoForward (recover of a never-forwarded running invocation). Fail-watch blocks a second handle POST; recover-then-handle still forwards.

## Tried and ruled out
- Forbidding ArmedNoForward|handle.forwarded without splitting states: recover of a never-forwarded running invocation would skip the later handle POST and the mention would only time out.
- Sending every poll tick through applyAndCommit: a 15-minute watch at 2s poll reads the session file hundreds of times. Poll/deadline counters stay in memory; the reducer owns named-state mutations.

## Watch out
- handle after close returns skipped, so the daemon acks the delivery. A successor process recover() arms a timeout watch for a still-running never-forwarded invocation; it does not POST unless a new delivery arrives.
- Two remaining labeled bugs: recover does not clear attempts-only rows; exhausting a fail-watch with no forward leaves a running invocation unwatched.

## In the code:
- `sigil/bridges/v1/floor-warden-watch-state.mjs` (`FORBIDDEN`, `FailWatching`, `recover.fail.retry` arms)
- `sigil/bridges/v1/floor-warden-bridge.mjs` (`canWatchEvent` in `handle`, `recover` returns when closed)
