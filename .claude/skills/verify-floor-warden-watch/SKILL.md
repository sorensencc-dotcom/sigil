---
name: verify-floor-warden-watch
description: Use when a change touches Floor Warden invocation-watch (floor-warden-watch-state.mjs STATES/FORBIDDEN/applyWatchEvent/canWatchEvent, floor-warden-bridge.mjs handle/recover/close/fail/onDeadline/onPoll). Exhaustively walks every reachable applyWatchEvent sequence on the real reducer.
---

# Verify Floor Warden invocation watch

## Property and harm

Property: a fail-watch never POSTs again, close never forwards or recover-fails, and a failed recover re-arms a watch.

Harm if broken: the bot runs the same invocation twice; a closed process still POSTs; recover after close fails a live invocation; a failed timeout confirm is never retried.

Unit tests pin named rows. They do not walk every reachable sequence. This check does, on the real `applyWatchEvent`, not a second model of it.

## Run it

From the repo root:

```
node verify/floor-warden-watch/check.mjs
node verify/floor-warden-watch/mutate.mjs
```

Needs Node 22+. No Java, no Docker. About 200 ms.

Exit codes of `check.mjs`: `0` breaks match `expected.json`; `1` a property fails that is not listed; `2` a listed finding stopped failing.

`node verify/floor-warden-watch/drift.mjs` lists covered files that changed since the sync commit. Exit 1 means re-read them against the action table below before trusting a pass.

## What it checks

BFS from every `snapshotFor(state)` over every `EVENTS` value and bounded extras (`maxAttempts` 1 and 2, attempts, a fail/recover forward). Snapshots are canonicalized (flags + capped counters), so the graph is finite.

| Property | Plain meaning | Must hold? |
|---|---|---|
| `forbidden-never-accepted` | `applyWatchEvent` rejects every `FORBIDDEN` pair | yes |
| `fail-watching-blocks-forward` | `FailWatching` rejects `handle.forwarded` | yes |
| `halted-blocks-forward` | `Halted` rejects `handle.forwarded` | yes |
| `closed-blocks-handle-recover` | `Closed` rejects handle POST/attempts/fail.retry and recover arm/fail | yes |
| `closed-stays-closed` | a closed snapshot never opens | yes |
| `failed-recover-rearms` | `OrphanForward` + `recover.fail.retry` arms a watch | yes |
| `fail-watch-exhaustion-unwatched` | exhausting a fail-watch without `fail.ok` must not drop the watch and leave Idle | **breaks today** |
| `handle-guards-forward` | `handle()` still calls `canWatchEvent(..., 'handle.forwarded')` | yes |
| `recover-returns-when-closed` | `recover()` returns when `closed` | yes |

| Action | Code |
|---|---|
| `handle.forwarded` | `floor-warden-bridge.mjs` `forward()` after a 2xx `post()`, `applyAndCommit(..., 'handle.forwarded')` |
| `handle.fail.retry` / `handle.fail.ok` | `fail()`: unconfirmed `failRoomInvocation` vs confirmed |
| `handle.attempts` | `forward()` retry loop |
| `recover.arm` | `recover()` for a still-young running invocation |
| `recover.fail.retry` / `recover.fail.ok` | `recover()` past deadline: `failConfirmed` catch vs success |
| `deadline.fail.retry` / `deadline.fail.ok` | `onDeadline` → `watchError` / `failConfirmed` |
| `poll.error` / `poll.halt.retry` / `poll.done` | `onPoll` |
| `close` | reducer only; process `close()` sets the in-memory `closed` flag and disarms timers, and does not write `snapshot.closed` |

## Findings

`fail-watch-exhaustion-unwatched` breaks on the real reducer. Shortest path the enumerator prints:

`FailWatching --poll.halt.retry(maxAttempts=1)--> Idle`

In the code's words: `fail()` cannot confirm `failRoomInvocation`, so `handle.fail.retry` arms a fail-watch. A later `poll.halt.retry`, `poll.error`, or `deadline.fail.retry` (`onDeadline` → `watchError`) at `maxAttempts` sets `watch = null` and leaves Idle: no forward, no halt, not closed. `syncWatch` disarms the timer. The invocation is still `running` on the relay. Nothing watches it until a later `recover()`.

Recorded in the watch-machine learning (exhausting a fail-watch with no forward leaves a running invocation unwatched). Do not weaken the property. Product code is unchanged.

## Real bug or modeling error

A new break: read the `path:` line. If those events are ones `applyAndCommit` / `handle` / `recover` / `onDeadline` / `onPoll` can apply, it is a bug — report it, do not weaken the property. If a step uses an extra the bridge never passes (for example `maxAttempts` on `handle.skip`), fix `EXTRAS` in `explore.mjs`.

Exit 2: a listed finding stopped failing. Delete it from `expected.json`, rerun, and commit both only after you confirm the reducer now keeps a fail-watch or finishes the invocation on exhaustion.

`mutate.mjs` must keep catching `fail-watching-blocks-forward`, `failed-recover-rearms`, and `closed-blocks-handle-recover`. If it prints `MISSED` or `SKIPPED`, the check lost power or the anchor text moved; fix `mutate.mjs` before trusting a pass.

## Covered code and sync commit

Sync commit: `5e35665`. Move it forward only after you re-read the covered files at the new commit, confirm every action table row still matches, rerun `node verify/floor-warden-watch/check.mjs` and `node verify/floor-warden-watch/mutate.mjs`, and see the same expected.json result.

Covered files: `verify/floor-warden-watch/covered-files.txt`

- `sigil/bridges/v1/floor-warden-watch-state.mjs`: `STATES`, `EVENTS`, `FORBIDDEN`, `deriveWatchState`, `canWatchEvent`, `applyWatchEvent`
- `sigil/bridges/v1/floor-warden-bridge.mjs`: `handle` (`canWatchEvent` before POST), `fail`, `recover` (returns when `closed`), `onDeadline`, `onPoll`, `close`

Before relying on the check, run `node verify/floor-warden-watch/drift.mjs`. Empty means the check still describes the code.

## Updating after an intended change

New named state, new event, or a new forbidden pair: add it to `STATES`/`EVENTS`/`FORBIDDEN` in the reducer (the explorer reads those), add the property or pair to `explore.mjs` if it is a new promise, add one mutation in `mutate.mjs` that the new logic must catch, and run both commands.

## Not covered

Timer scheduling (`setTimeout` / `setInterval`). Concurrent `handle` and `recover` (the session write is serialized by `applyAndCommit`). `recover()` not clearing attempts-only session rows. Process `close()` not persisting `snapshot.closed` (it is in-memory; a successor `recover()` re-arms running invocations on purpose). Room delivery, reply posting, and webhook retries (see `verify-room-delivery`). More than one invocation.
