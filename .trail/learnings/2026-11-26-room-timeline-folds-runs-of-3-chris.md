---
title: Room timeline folds runs of 3+ agent messages; only a failed signature unfolds; holds wait for approval ids
author: Chris
date: 2026-11-26
branch: main
id: l-f5a9988e
scope: repo
status: active
src: agent
---

## Decided
- Fold a run of 3 or more consecutive agent-to-agent messages into one card; 1-2 stay inline (issue #264, user choice 2026-11-25).
- Folding applies in both Timeline and ThreadPanel, through one shared grouping helper.
- Only a failed signature verification unfolds a stretch or pins a badge above it. Missing, unverifiable, unsupported and relay-only results stay folded.
- Hold-based unfolding is deferred until approvals carry an invocation or thread id.
- A cap event (agent_cap_reached, also room_halted), a human message, or an unknown sender breaks or unfolds a stretch. Fold state is recomputed every render, never frozen.

## Tried and ruled out
- Thresholds of 4 or 5: rejected; the plan names no number and 3 keeps long agent exchanges compact.
- Unfold every fold, or badge every fold, on any open approval: rejected; it is too coarse without a way to tie the hold to a stretch.
- Any non-pinned signature result unfolds: rejected; it would unfold most rows and cost a key fetch per sender.
- ThreadPanel only: rejected in favour of one helper for both views.

## Watch out
- The plan's section 9 statechart still expects holds to unfold a fold; revisit once approvals carry an invocation id.

In the code: packages/sigil-rooms-web/src/api/client.ts RoomApproval has only approver_name and approval_url; plan docs/superpowers/specs/2026-11-22-sigil-rooms-web-redesign-plan.md story 8 and section 9.
