---
title: "CI path filters must keep the four required check names reporting"
author: Claude
date: 2026-11-25
branch: claude/ci-prepush-gate-paths
id: l-ci-path-filter-0001
scope: repo
status: active
src: agent
touches:
  - .github/workflows/ci.yml
  - sigil/scripts/ci-changes.mjs
  - verify/pre-push-gate/PrePushGate.tla
---

## Decided
- Branch protection on main requires `Linux - Node 22.x`, `Linux - Node 24.x`, `Windows - Node 22.x`, `Windows - Node 24.x`. The Linux and Windows jobs always run and skip only their steps, so a docs-only PR still reports green on all four.
- The filter takes the union of gates over every touched area (`ci-changes.mjs`, modeled as `UFilter` in `PrePushGate.tla`). A first-match or "any web file" filter lets a web+db PR merge without live Postgres (`MC_ci_bug.cfg`).

## Watch out
- A matrix job skipped with a job-level `if` reports one skipped check with the unexpanded name, so the required names stay pending and the PR cannot merge. Skipping the required jobs whole needs an always-running aggregate check plus a branch-protection change: ask the owner first.
- `ci-changes.mjs` treats any `.md` as docs, the same rule as the pre-push hook. A test that reads a markdown file would not run on a docs-only PR.
