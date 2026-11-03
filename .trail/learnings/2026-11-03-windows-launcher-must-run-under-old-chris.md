---
title: "Windows launcher must run under old PowerShell 5.1, which breaks script-root defaults"
author: Chris
date: 2026-11-03
standing: true
id: l-d9d17971
scope: repo
status: active
src: init-review
---

## Watch out
- The scheduled task runs Windows PowerShell 5.1, where the script-root variable is empty inside parameter defaults. The launcher crashed silently with exit 1 and logged nothing.
- In the code: In `scripts/windows/*.ps1`, resolve RepoRoot in the script body from `$MyInvocation.MyCommand.Path`, not in `param()` defaults. `windows-launcher-args.test.mjs` has a static check for this.

_From PR #136 here, Oct 29._
