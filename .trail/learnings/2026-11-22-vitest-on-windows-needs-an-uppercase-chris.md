---
title: "Vitest on Windows needs an uppercase drive path, so rooms-web stops early on a lowercase one"
author: Chris
date: 2026-11-22
branch: feat/issue-257-sender-chips
cost: { minutes: 30, tokens: 373395 }
id: l-36b25900
scope: repo
status: active
src: agent
touches:
  - STATUS.md
  - packages/sigil-rooms-web/src/App.tsx
  - packages/sigil-rooms-web/src/rooms/RowView.spec.tsx
  - packages/sigil-rooms-web/src/rooms/RowView.tsx
  - packages/sigil-rooms-web/src/rooms/SenderChip.spec.tsx
  - packages/sigil-rooms-web/src/rooms/SenderChip.tsx
  - packages/sigil-rooms-web/src/rooms/ThreadPanel.spec.tsx
  - packages/sigil-rooms-web/src/rooms/ThreadPanel.tsx
  - packages/sigil-rooms-web/src/rooms/Timeline.tsx
  - packages/sigil-rooms-web/src/rooms/useContacts.ts
---

## Decided
Vitest on Windows must run from an uppercase drive path. With a lowercase drive (c:\dev\...), vitest loads itself and the setup file under two path casings, and every spec fails with "Vitest failed to find the current suite". rooms-web now stops early with a clear error that names the uppercase path to cd into. Build and dev are not affected.

The e2e thread check was stale, not the app: since reply previews landed, the main timeline shows the latest reply under its root. The check now asserts the reply appears only as a preview, never as its own row.

## Tried and ruled out
- Calling process.chdir to an uppercase path inside the config: too late, because vitest has already loaded from the lowercase path.
- Pinning root to an uppercase path in the config: same failure.

## Watch out
PowerShell Set-Location uppercases the drive by itself, so you cannot reproduce the failure from PowerShell. Spawn node with a literal lowercase cwd instead. Agent harnesses often report the working directory as lowercase c:\dev.

In the code:
- packages/sigil-rooms-web/vite.config.ts guard (only when process.env.VITEST is set on win32)
- packages/sigil-rooms-web/e2e/rooms.e2e.ts thread section uses .reply-preview-text and .text locators
- AGENTS.md "Testing before you push" rule; C:\dev\AGENTS.md has the workspace-wide rule
