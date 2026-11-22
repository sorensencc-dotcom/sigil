---
title: "rooms-web vitest fails from a lowercase c: working directory"
author: Chris
date: 2026-11-22
branch: feat/issue-257-sender-chips
cost: { minutes: 4, tokens: 1083 }
id: l-fc3784ad
scope: repo
status: active
src: agent
touches:
  - packages/sigil-rooms-web/vite.config.ts
  - packages/sigil-rooms-web/src/setupTests.ts
---

## Watch out
Running vitest in packages/sigil-rooms-web from a shell whose working directory starts with lowercase c: (Git Bash /c/dev, or a c:\dev session folder) fails every spec with "Vitest failed to find the current suite" at src/setupTests.ts afterEach. Vite loads vitest twice, once per drive-letter casing. Run it from PowerShell after Set-Location 'C:\dev\...' (uppercase C:), and all 33 files pass.

## Ruled out
A duplicate vitest install: C:\dev\node_modules\vitest exists, but running node node_modules/vitest/vitest.mjs from the package still failed until the cwd casing changed.
