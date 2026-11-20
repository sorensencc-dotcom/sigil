---
title: Windows sigil service runs a per-component runner because Task Scheduler cannot restart crashed programs or carry secrets
author: Chris
date: 2026-11-20
branch: fix/windows-service-parity
cost: { minutes: 37, tokens: 471882 }
id: l-cdb3bf4c
scope: repo
status: active
src: agent
touches:
  - docs/service-config.md
  - sigil/cli/service-command.mjs
  - sigil/cli/service-command.test.mjs
  - sigil/cli/service-config.mjs
  - sigil/cli/service-config.test.mjs
  - sigil/cli/service-runner.mjs
  - sigil/cli/service-runner.test.mjs
  - sigil/cli/windows-supervisor.mjs
  - sigil/cli/windows-supervisor.ps1
  - sigil/cli/windows-supervisor.test.mjs
---

## Decided
Each Windows scheduled task runs `sigil service run <component>`, which loads secrets from the top-level `secrets` block in service.json, waits for the relay ports, writes logs, and restarts the child with backoff (1 s doubling to 300 s, reset after 60 s up).

## Tried and ruled out
- Relying on Task Scheduler's RestartCount/RestartInterval: it fires only when a task fails to launch, not when the program exits non-zero.
- A powershell.exe wrapper with `*>>` redirection per task: no secrets, no working directory, and stopping the task orphans the node child.

## Watch out
- Passing JSON as a `powershell.exe -File` argument loses its double quotes, so the parameter fails to bind. Send it base64 (`-PlanBase64`).
- Mocked supervisor tests hid that bug and a wrong field name (`supervisor` vs `supervisor_target`). Keep the win32-only tests that run the real .ps1.
- `stop` must find runner PIDs before Stop-ScheduledTask and taskkill /T them; port-less agents otherwise survive.

In the code: sigil/cli/service-runner.mjs, sigil/cli/windows-supervisor.ps1, sigil/cli/windows-supervisor.mjs, docs/service-config.md.
