---
title: Pre-push hook depends on a script that exists only on some branches
author: Chris
date: 2026-11-03
standing: true
id: l-9c56139a
scope: repo
status: active
src: init-sessions
touches:
  - sigil/scripts/prepush-preflight.mjs
---

## Watch out
- The shared hook calls a preflight script that existed on one branch but not on main or the lease-fix branch, so pushes from other branches failed. Skipping the hook needed explicit user approval.
- In the code: Hook calls `sigil/scripts/prepush-preflight.mjs`, which exists on `fix/mcp-initialize` but not on `main`. Before pushing from another branch, run `npm run audit:jcs` and tests by hand. Use `--no-verify` only with user approval.

_From past Claude sessions here, Oct 25._
