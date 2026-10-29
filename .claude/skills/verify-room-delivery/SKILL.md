---
name: verify-room-delivery
description: Use when a change touches Sigil room message delivery to a Floor Warden bot (room-dispatch.mjs invocation/delivery creation, floor-warden-replies.mjs, floor-warden-bridge.mjs forward/retry/recover, agent-daemon.mjs poll/ack of room.message). Model-checks the TLA+ model in verify/room-delivery with TLC via the pstack /statechart skill.
---

# Verify room delivery

## Property and harm

Rules (INVARIANTS in `verify/room-delivery/RoomDelivery.tla`):

| Rule | Plain meaning | Harm if broken |
|---|---|---|
| `OneDeliveryPerMention` | each @mention gets at most one delivery row, and exactly one once it runs | the bot is asked twice, or a running mention is never sent |
| `NoDoubleReply` | at most one reply is posted per @mention, however many times the bot ran | duplicate bot replies in the room |
| `ReplyInRightThread` | a reply completes its own trigger's invocation and lands in that trigger's thread | a reply answers the wrong question or the wrong thread |
| `NoLostDelivery` | when nothing more can happen, every posted mention is completed or failed | a mention stuck "running", bot silent, room blocked for that bot |
| `AgentRunsOnce` | the bot's webhook receives each invocation once | duplicate bot runs (wasted work, repeated side effects). **Breaks today, by design: see Findings.** |

## Run it

Use the pstack `/statechart` skill, run from a scratch `--out` folder outside the repo, on `verify/room-delivery/MC.tla` with view `verify/room-delivery/view.mjs`, once per config:

- `MC.cfg`: 2 mentions, 3 attempts, 1 bridge crash (~64k states, ~10 s).
- `MC_chart.cfg`: 1 mention, 2 attempts; gives the full chart (`chart.mmd`).
- `MC_dup_delivery.cfg`, `MC_no_single_shot.cfg`, `MC_no_trigger_check.cfg`, `MC_ack_on_retry.cfg`: broken variants; each must break its rule.

Compare with `verify/room-delivery/expected.md`. Read each break as the shortest path `/statechart` prints. Then `node --test --test-name-pattern="room-delivery replay" sigil/bridges/v1/floor-warden-bridge.test.mjs` replays the known finding on real code.

Drift check: `verify/room-delivery/drift.sh` lists covered files changed since the sync commit.

## Real bug or modeling error

A new break on `MC.cfg` is a model claim, not a bug, until you replay its path against the real code as a test (copy the `setup()` harness in `floor-warden-bridge.test.mjs`, or a relay test for the dispatch/reply side), one test step per model step. If the replay does not reproduce it, the model is wrong: fix the action that drifted from the code, citing the code. Never weaken a rule to make it pass. If a mutation config stops breaking its rule, the model lost the guard that mutation removes; fix the model.

## What each action models

| Action | Code |
|---|---|
| `HumanPostsMention` | `applyRoomDispatch` / `dispatchToTarget` (room-dispatch.mjs), one accept transaction under the room lock; busy agent -> `queued`, no delivery |
| `Promote` (helper inside `AgentReplies`, `FailInv`) | `promoteNextInvocation` (room-dispatch.mjs), inside the reply or fail transaction |
| `BridgePicks` | agent-daemon.mjs `pollOnce`/`processItem` (stream frames only trigger polls; `since = ''` at start) + floor-warden-bridge.mjs `handle` skip checks (`runningFor` trigger match, `forwards[]`) |
| `PostOk`, `RecordForward` | `forward()`: `post()` 2xx, then `update()` writes `forwards[]`, `arm()`; daemon `acknowledge` |
| `PostRetry` | `post()` retry (timeout via `AbortSignal.timeout`, network, 408/429/5xx); `attempts[]` persisted; `>= maxAttempts` -> `fail FLOOR_WARDEN_UNREACHABLE`; else in-loop sleep or throw `FLOOR_WARDEN_RETRY` -> `room_unacked` |
| `PostReject` | `post()` reject -> `fail FLOOR_WARDEN_REJECTED` |
| `AgentReplies` | floor-warden-replies.mjs `runReply` step 8 + `acceptEnvelopeAsync(expectedTriggerMessageId)` single-shot completion; thread = `threadRootOf(trigger)` |
| `AgentGivesUp` | the bot never replies (crash, error); only the reply watch can end it |
| `ReplyTimeout` | reply watch deadline -> `failRoomInvocation REPLY_TIMEOUT` |
| `BridgeCrash`, `BridgeRestart` | process restart; `recover()` re-arms a watch for every running invocation |

## Findings

`AgentRunsOnce` breaks on the real code. Path: you post the @mention; the bridge picks up the delivery; the webhook call times out (the bot already has the request); the bridge retries and the webhook answers OK. The bot now runs the same invocation twice. A crash after a 2xx and before `forwards[]` is written does the same. Only one reply can post (`NoDoubleReply` holds), but the bot does the work twice. The payload carries `delivery_key = invocation id` for the receiver to dedupe; this is at-least-once by design, so the fix (if any) belongs on the webhook side. Replay test: `room-delivery replay` in floor-warden-bridge.test.mjs.

## What the model leaves out

Halt/Stop frames and `sendHalt`; hop budget, refusals, `subjectBlocker`; more than one agent or room; the relay's own outbound stream sequencing; Postgres faults (each transaction is atomic); `failRoomInvocation` itself failing (the `arm(..., Date.now())` retry); delivery state names beyond acked/unacked; timing (deadlines are just "may fire"). Bounds: 2 mentions in 2 threads, 3 attempts, 1 bridge crash.

## Covered code and sync commit

Sync commit: `ea29de9` (main after PR #139). Move it forward only after you re-read the covered files at the new commit, confirm every action table row still matches, and rerun all configs with the expected results.

Covered files: `verify/room-delivery/covered-files.txt` (room-dispatch.mjs `dispatchToTarget`, `promoteNextInvocation`, `applyRoomDispatch`; floor-warden-replies.mjs `runReply`; accept-envelope.mjs completion path; delivery-state.mjs; floor-warden-bridge.mjs `handle`, `forward`, `post`, `fail`, `recover`; floor-warden-payload.mjs `buildForwardPayload` delivery_key; agent-daemon.mjs `processItem`, `pollOnce`, `start`).
