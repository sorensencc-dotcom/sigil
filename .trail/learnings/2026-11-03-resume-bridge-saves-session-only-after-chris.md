---
title: "Resume bridge saves session only after reply posts, so tests must wait for the saved state"
author: Chris
date: 2026-11-03
standing: true
id: l-834fe8e2
scope: repo
status: active
src: init-review
touches:
  - sigil/bridges/v1/rooms-bridges-exit.test.mjs
---

## Watch out
- Intermittent Linux failures came from tests reading the session store right after the reply appeared, before the store write landed. The order is intentional so a rejected post cannot advance the session.
- In the code: In `sigil/bridges/v1/rooms-bridges-exit.test.mjs`, each waitFor must also wait on the session-store state being asserted. Do not reorder product code, and do not add sleeps.

_From PR #149 here, Oct 30._
