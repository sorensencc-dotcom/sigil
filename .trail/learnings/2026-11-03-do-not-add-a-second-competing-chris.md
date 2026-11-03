---
title: Do not add a second competing implementation of an existing command
author: Chris
date: 2026-11-03
standing: true
id: l-56b3bf7a
scope: repo
status: active
src: init-review
touches:
  - sigil/cli/sigil.mjs
  - "sigil/cli/sigil.mjs#cmdVerifyContract"
---

## Tried and ruled out
- A branch added a separate verify-contract module duplicating the CLI command already on main. It was closed and the one missing behavior was ported into the existing command.
- In the code: Extend `cmdVerifyContract` in `sigil/cli/sigil.mjs` (backed by `contract-signing.mjs`) rather than adding new verify modules.

_From PR #13 here, Sep 29._
