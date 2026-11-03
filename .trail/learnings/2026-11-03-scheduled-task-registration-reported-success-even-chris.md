---
title: Scheduled task registration reported success even when Windows denied it
author: Chris
date: 2026-11-03
standing: true
id: l-b3b3deda
scope: repo
status: active
src: init-review
touches:
  - scripts/windows/register-sigil-task.ps1
---

## Watch out
- Register-ScheduledTask errors were non-terminating, so the script printed Registered and Started while a stale task made verification pass.
- In the code: Use `-ErrorAction Stop` on Register-ScheduledTask and Start-ScheduledTask in `scripts/windows/register-sigil-task.ps1`. Script-level `$ErrorActionPreference='Stop'` does not reach these CDXML functions.

_From PR #137 here, Oct 29._
