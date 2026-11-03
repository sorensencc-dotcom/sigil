---
title: "Pre-push hook runs full test suite even for web-only changes, starving the machine"
author: Chris
date: 2026-11-03
standing: true
id: l-3d47b80a
scope: repo
status: active
src: init-sessions
---

## Decided
- The untracked hook ran the whole repo suite on every push, taking 10+ minutes. Relay CLI tests then hit 30s timeouts for a change that only touched the web package.
- In the code: Hook is `C:\dev\sigil-repo\.git\hooks\pre-push` (untracked, backup `pre-push.bak-20261029`). It now runs only vitest in `packages/sigil-rooms-web` when all changed files are under that path. Other changes still run `npm test`.

_From past Claude sessions here, Oct 29._
