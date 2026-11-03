---
name: verify-suspend-pick
description: Use when a change touches router pick vs human suspension lock order (room-routes.mjs POST /v1/rooms/:id/invocations, lockEndpointForShare, suspendHuman, lookupInvocationSubject, dispatchToTarget subjectBlocker). Exhaustively checks every interleaving of one pick and one suspendHuman on the TLA+ model in verify/suspend-pick.
---

# Verify suspend vs router pick

## Property and harm

Property: after `suspendHuman` commits, that human has no `running` room invocation.

Harm if broken: a suspended human still gets one agent turn. The bot runs under withdrawn authority. Tests cover an active trigger sender (`human-suspension.pg.test.mjs` "router pick racing a suspension") and do not go through `handleRoomRoute` with a revoked trigger sender.

## Run it

From the repo root:

```
node verify/suspend-pick/check.mjs
```

Needs Java 11+ and TLC 2.19 (`tla2tools.jar`). Default locations: `%USERPROFILE%\.tla\tla2tools.jar` and `%USERPROFILE%\.tla\jdk\bin\java.exe`. Override with `TLA2TOOLS` and `JAVA`. About 2 seconds. Pinned TLC flags: `-workers 1 -fp 0 -lncheck final`.

Exit codes: `0` breaks match `expected.json`; `1` a property fails that is not listed; `2` a listed finding stopped failing; `3` TLC is missing.

`node verify/suspend-pick/drift.mjs` lists covered files that changed since the sync commit. Exit 1 means re-read them against `SuspendPick.tla` before trusting a pass.

## What it checks

One router pick and one `suspendHuman`, one room, two endpoints for the subject (the trigger sender, plus one still-active endpoint). Locks are the real row locks: `FOR SHARE` vs `UPDATE`. Reads are READ COMMITTED.

| Config | Models | Must break |
|---|---|---|
| `MC.cfg` | real code, trigger sender already `revoked` | `NoSurvivingInvocation` |
| `MC_active.cfg` | real code, trigger sender still `active` | none |
| `MC_lock_human.cfg` | `STATUS.md` fix (`FOR SHARE` on `humans` first), sender revoked | none |
| `MC_no_endpoint_lock.cfg` | `lockEndpointForShare` removed, sender still active | `NoSurvivingInvocation` |

| Action | Code |
|---|---|
| `PickLockHuman` | intended fix: `SELECT 1 FROM humans WHERE human_id = $1 FOR SHARE` before the endpoint lock (`STATUS.md`) |
| `PickLockEp` | `room-routes.mjs` `lockEndpointForShare(preTrigger.envelope.sender.endpoint_id)` |
| `PickLockRoom` | `room-routes.mjs` `lockRoom` after the sender lock |
| `PickReadSubject` | `room-dispatch.mjs` `subjectBlocker` → `lookupInvocationSubject` |
| `PickCommit` | `dispatchToTarget` `createRoomInvocation` then COMMIT |
| `SuspendUpdateHuman` | `postgres-repository.mjs` `suspendHuman` `UPDATE humans SET status = 'suspended'` |
| `SuspendUpdateActiveEps` | `UPDATE endpoints … WHERE owner_id = $1 AND status = 'active'` |
| `SuspendScan` | `SELECT DISTINCT room_id FROM room_invocations WHERE subject_human_id = $1 AND status IN ('queued', 'running')` |
| `SuspendLockRooms` | `lockRoom` per scanned room |
| `SuspendCommit` | `cancelRoomInvocations` then COMMIT |

## Findings

`NoSurvivingInvocation` breaks on the real code when the trigger sender's endpoint is already revoked. Path in the code's words:

1. Router `FOR SHARE`s the revoked trigger sender.
2. Router `lockRoom`s.
3. `lookupInvocationSubject` still sees `humans.status = active`.
4. `suspendHuman` `UPDATE`s the humans row (pick never locked it).
5. `UPDATE endpoints WHERE status = 'active'` skips the revoked sender, so it does not wait on the pick's `FOR SHARE`.
6. The invocation scan sees no committed running row.
7. The pick commits a `running` invocation.
8. Suspend takes no room lock (the scan was empty) and commits without cancelling.

Recorded in `STATUS.md` ("Known gap: router pick vs suspension after endpoint revoke"). Exposure: one agent turn. Do not weaken the property. The listed fix is `FOR SHARE` on `humans` before the endpoint lock (`MC_lock_human.cfg` holds). Product code is unchanged.

`MC_active.cfg` holds: the active-endpoint `UPDATE` waits on the pick's `FOR SHARE`, then the scan sees the committed row and cancels it. That is the case the existing pg test covers.

## Real bug or modeling error

A new break: read the `path:` line. If those steps are an interleaving `handleRoomRoute` and `suspendHuman` can take, it is a bug — report it, do not weaken the property. If a step needs a lock the SQL never takes, or a read that is not READ COMMITTED, fix `SuspendPick.tla`.

Exit 2: a listed finding stopped failing. Delete it from `expected.json`, rerun, and commit both only after you confirm the code now takes the lock the model added.

`MC_no_endpoint_lock.cfg` must keep breaking `NoSurvivingInvocation`. If it starts holding, the model lost the sender lock; fix `PickLockEp`.

## Covered code and sync commit

Sync commit: `9af1c9a`. Move it forward only after you re-read the covered files at the new commit, confirm every action table row still matches, rerun `node verify/suspend-pick/check.mjs`, and see the same expected.json result.

Covered files: `verify/suspend-pick/covered-files.txt`

- `sigil/relay/v1/room-routes.mjs`: `POST …/invocations` lock order (`lockEndpointForShare`, `lockRoom`, `dispatchToTarget`)
- `sigil/relay/v1/room-dispatch.mjs`: `dispatchToTarget`, `subjectBlocker`
- `sigil/relay/v1/postgres-repository.mjs`: `suspendHuman`, `lockEndpointForShare`, `lookupInvocationSubject`, `cancelRoomInvocations`

Before relying on the check, run `node verify/suspend-pick/drift.mjs`. Empty means the check still describes the code.

## Updating after an intended change

New lock, new subject check, or a new `suspendHuman` write: add the lock to `SuspendPick.tla`, add or update a config in `check.mjs` / `expected.json`, and add one mutation config that the new logic must catch (the way `MC_no_endpoint_lock.cfg` catches a missing `lockEndpointForShare`).

## Not covered

Accept-envelope (has its own sender `FOR SHARE` test that passes). `unsuspendHuman`. `revokeEndpoint`. More than one pick or suspend. Serializable isolation. The HTTP layer around `handleRoomRoute`. Memory repository (no row locks). Postgres `FOR UPDATE SKIP LOCKED` elsewhere.
