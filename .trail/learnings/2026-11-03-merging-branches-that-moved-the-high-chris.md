---
title: Merging branches that moved the high-risk approval gate would consume approvals twice
author: Chris
date: 2026-11-03
standing: true
id: l-23a4e2ba
scope: repo
status: active
src: init-sessions
touches:
  - sigil/relay/v1/accept-envelope.mjs
  - "sigil/relay/v1/capability-risk-gate.mjs#enforceCapabilityRiskGate"
---

## Watch out
- One branch extracted the capability risk gate to run early, while main re-added an inline check. Keeping both would double-consume the approval and reject already-approved envelopes.
- In the code: In `sigil/relay/v1/accept-envelope.mjs` keep only the early `enforceCapabilityRiskGate` call (sync-forward and Phase-2 entry). Do not reintroduce inline `highRiskCapabilities` or a second approval-consume block.

_From past Claude sessions here, Sep 19._
