---
name: room-bridge-sessions
description: Use when a change touches room-bridge turn serialization, session_id resume, or last_seq_by_thread cursor persistence. Runs a bounded TLC model of two room turns and the real room-bridge regression.
---

# Verify room bridge sessions

## Property and harm

`EveryTurnResumes` means a turn that starts after the previous reply is visible reads the saved CLI session. `NoThreadForgotten` means both turns retain their thread cursor after they finish.

If either rule breaks, the next room turn starts a fresh conversation or loses its thread context. The agent may repeat work, answer without prior context, or expose the wrong room history to the CLI.

## Run it

From the repository root, run:

```text
node verify/bridge-session/check.mjs
node --test sigil/bridges/v1/room-bridge.test.mjs
node verify/bridge-session/drift.mjs
```

The first command uses TLC 2.19 from `%USERPROFILE%\.tla\tla2tools.jar` and Java from `%USERPROFILE%\.tla\jdk\bin\java.exe`. Set `TLA2TOOLS` or `JAVA` to override either path. It exhaustively checks the two-turn model, then checks that deliberately non-serialized variants fail each invariant. Exit `0` means the expected results match. Exit `1` means the model or its expected failure changed. Exit `3` means TLC is unavailable.

Read every TLC result with the pstack `/statechart` skill. It turns an invariant violation into the shortest path in room-bridge terms and draws the passing state chart.

## What the model covers

`verify/bridge-session/BridgeSession.tla` models two turns in one room. `ReadSession` represents `runInvocation` reading `sessions.get(roomId)`. `PostReply` represents the reply becoming visible. `StoreSession` represents the `sessions.set` after `sendEnvelope` succeeds. `Serialize = TRUE` represents `roomTails` in `handle`, which makes the second turn wait until the first turn's persistence completes.

`fixed.cfg` must pass. `buggy.cfg` intentionally sets `Serialize = FALSE` and must fail `EveryTurnResumes`. `buggy-thread.cfg` uses the same broken design with `NoThreadForgotten` listed first and must fail that invariant. The shortest counterexample is a reply becoming visible, the next turn starting before the first turn saves its session, and the second turn reading `none`.

## Real code and modeling errors

If `fixed.cfg` fails, compare the path with `room-bridge.mjs` and replay each model step through `handle` in the focused room-bridge test. Treat a path that the code can take as a real bug. Treat a path that needs an absent lock, callback, or state as model drift and update `BridgeSession.tla` before changing the invariant.

If `buggy.cfg` stops failing, the model lost the guard that the mutation removes. Restore the model's distinction before trusting a pass.

## Covered code and sync commit

Sync commit: `c74880ba7b23111ef38c339b8abe66b8d521d87c`

Covered files are listed in `verify/bridge-session/covered-files.txt`. Before relying on the result after a code change, run `node verify/bridge-session/drift.mjs`, read the changed functions against the model, and move the sync commit forward only after the model still describes the code and both commands pass.

## Not covered

The model covers one bridge endpoint, one room, two turns, one shared CLI session, and one cursor per thread. It does not cover multiple bridge processes writing the same session file, atomic file replacement failures, CLI provider behavior, relay delivery, PostgreSQL transactions, more than two overlapping turns, or recovery after a process crash between reply delivery and session persistence.
