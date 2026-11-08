---
title: Walk the real watch reducer instead of a TLA+ copy of the table
author: Chris
date: 2026-11-08
branch: main
id: l-a99b4e55
scope: repo
status: active
src: agent
touches:
  - ".serena/project.yml"
  - CLAUDE.md
---

## Decided
- Floor Warden invocation-watch is checked by walking the real `applyWatchEvent` over every reachable named state, not by a TLA+ reimplementation. The reducer is already a finite table; a second model would drift.
- `fail-watch-exhaustion-unwatched` is a listed finding: `FailWatching` plus `poll.halt.retry`/`poll.error`/`deadline.fail.retry` at maxAttempts drops the watch and leaves Idle while the invocation is still running. Do not weaken that property.

## Tried and ruled out
- TLA+ of the watch table: it would copy `FORBIDDEN` and go stale the next time the JS table moved.
- Treating exhaustion as out of scope: the watch-machine work already named it as a remaining bug, and the enumerator hits it in one step.

## Watch out
- In the code: `verify/floor-warden-watch/check.mjs`, `mutate.mjs` must keep catching a removed `FailWatching|handle.forwarded` row.
- Process `close()` does not persist `snapshot.closed`; a successor `recover()` re-arms on purpose.
