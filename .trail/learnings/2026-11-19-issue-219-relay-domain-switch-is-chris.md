---
title: Issue 219 relay domain switch is claimed done but not on main and relay was down
author: Chris
date: 2026-11-19
branch: main
id: l-db2ff7b8
scope: repo
status: active
src: agent
touches:
  - ".serena/project.yml"
  - scripts/windows/start-sigil-stack.ps1
---

## Decided
Do not close issue 219 on the strength of its comments. On 2026-11-19 the claimed fix could not be confirmed. Closing needs the domain set in whatever now starts the relay, the relay restarted, and health plus delivery to the 7 bare endpoints re-checked.

## Tried and ruled out
- Looking for `--domain rewritelabs.io` in the launcher on origin/main: not there. The launcher is now the deprecated stopgap that points at `sigil service start`, and no commit adds the flag.
- Health check on port 8765 returned nothing and no relay process with a domain argument was running.

## Watch out
- The issue's last comment says the live relay restarted under `--domain rewritelabs.io`. The 2026-11-17 learning says it runs `local`. The edit was probably local or on an unmerged branch.
- Local main was 5 commits behind origin/main with uncommitted .cursor/.serena/.trail edits.

In the code:
- scripts/windows/start-sigil-stack.ps1 (deprecated on main)
- sigil/cli/service-command.mjs (`--service-config`)
- sigil/cli/phase7-setup-policy.mjs:57 (endpoint domain must match relayDomain)
