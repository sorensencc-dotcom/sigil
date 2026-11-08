---
title: Watchdog SIGTERM wait hangs node --test until the grandchild pipe closes
author: Chris
date: 2026-11-08
branch: main
id: l-80e16ad1
scope: repo
status: active
src: agent
touches:
  - ".serena/project.yml"
  - scripts/chief-watchdog.ps1
  - sigil/cli/agent-daemon.mjs
  - sigil/cli/agent-daemon.test.mjs
  - tests/chief-watchdog.test.mjs
---

## Decided
- Watchdog teardown must kill Start-Process grandchildren from the PID file, destroy piped stdio, then SIGKILL pwsh with a bounded wait. `node --test` on Linux Node 22 times out (Node 24 hangs) when a grandchild still holds the stderr write end.
- ProcessExit and POSIX SIGTERM handlers must not close over `$process`: it is `$null` at registration. The PID file is the source of truth.
- On Linux, Start-Process must redirect stdout/stderr so the daemon does not inherit pwsh's pipe. `agent-daemon.stop()` must SIGKILL in-flight piped workers and destroy their stdio.

## Tried and ruled out
- Unbounded `child.on('exit')` after SIGTERM: pwsh can delay SIGTERM, so `finally` never runs and the 30s file timeout fires.
- Killing via `$process` captured in the ProcessExit scriptblock: the variable is `$null` when the handler is registered, so the grandchild survives.
- Bumping `--test-timeout` or skipping the watchdog file: that hides the orphan and leaves the pipe open.

## Watch out
- In the code: `tests/chief-watchdog.test.mjs` `teardownWatchdog`, `scripts/chief-watchdog.ps1` `Stop-ChiefFromPidFile` plus Linux `RedirectStandardOutput`/`RedirectStandardError`, `sigil/cli/agent-daemon.mjs` `stop()` worker kill.
- `Start-Process -RedirectStandard*` fails if the log file already exists; delete it before each restart.
- Do not `await child.on('exit')` after SIGTERM without checking `exitCode`/`signalCode` and a timeout.
