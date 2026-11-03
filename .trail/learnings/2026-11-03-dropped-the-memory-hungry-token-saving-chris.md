---
title: Dropped the memory-hungry token-saving proxy; it cost more than it saved
author: Chris
date: 2026-11-03
standing: true
id: l-cbb89f8a
scope: repo
status: active
src: init-sessions
---

## Tried and ruled out
- The local proxy held about 626 MB of RAM and, because the desktop app ignored its env var, little traffic went through it. It also starved the pre-push memory gate, so it was removed completely.
- In the code: Headroom is fully removed: container, image, `uv tool uninstall headroom-ai`, SessionStart hooks, MCP entry in `~/.claude.json`. Do not reinstall it or set `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`.

_From past Claude sessions here, Oct 29._
