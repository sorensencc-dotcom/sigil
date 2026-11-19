---
title: "The sigil service path on Windows cannot yet run the live stack, so keep the stopgap launcher"
author: Chris
date: 2026-11-19
branch: main
id: l-64a21fea
scope: repo
status: active
src: agent
touches:
  - ".serena/project.yml"
  - scripts/windows/start-sigil-stack.ps1
---

## Decided
Do not restart SigilStack onto main's `sigil service start` path yet. The live stack keeps running from the local stopgap `scripts/windows/start-sigil-stack.ps1`, which already passes `--domain rewritelabs.io` and the `.sigil-secrets` paths.

## Watch out
- Main's `start-sigil-stack.ps1` is a thin wrapper around `sigil service start`. That command only calls `Start-ScheduledTask` on `SigilStack_relay`, `SigilStack_agent-chief` and `SigilStack_rooms-web`, none of which are installed.
- Even after `sigil service install`, those tasks would fail. They load no secrets (wrap keys, `SIGIL_DATABASE_URL`, GitHub OAuth), set no working directory for the relative `sigil/cli/sigil.mjs`, and register as Interactive/Limited at logon, not S4U/Highest.
- `sigil service` defaults `--dry-run` to false in code (`sigil/cli/service-command.mjs:48`), though `docs/service-config.md` says true. Always pass `--dry-run` when inspecting.
- `sigil doctor --service-config` fails before checking the config if `.sigil/antigravity.identity.json` is missing, because it wants a default identity.

In the code: `sigil/cli/windows-supervisor.ps1:45-56`, `sigil/cli/service-command.mjs:48`. `.sigil/service.json` (gitignored) now exists with absolute `.sigil-secrets` paths; its `--dry-run --json` relay, chief and rooms-web commands match the live launcher's flags exactly.
