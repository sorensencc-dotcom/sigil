---
name: verify-pre-push-gate
description: Use when a change touches the pre-push gate (.githooks/pre-push, sigil/scripts/prepush-tier.mjs, prepush-preflight.mjs, install-git-hooks.mjs) or adds CI path filters to .github/workflows/ci.yml. Exhaustively checks the tier, RAM gate, rebase, hook-overwrite, and CI backstop interactions on the TLA+ model in verify/pre-push-gate.
---

# Verify pre-push gate

## Property and harm

| Rule | Meaning | Harm if broken |
|---|---|---|
| `NoUnverifiedMerge` | nothing merges unless every touched area's gates ran, locally or in CI | a change merges without its tests, for example without live Postgres |
| `LocalCoversLocalReq` | the hook runs the tier its path map promises | a mixed web and core push skips the core suite locally |
| `WebOnlyPushCheap` | a docs or web-only push with a known range never runs the full `npm test` | pushes take 10+ minutes again |
| `RamNeverBlocksWebOnly` | a docs or web-only push is never held up by low RAM | web pushes fail on a starved machine for no reason |

No deadlock: a push blocked on RAM resumes when RAM is freed.

## Run it

```
node verify/pre-push-gate/check.mjs
```

Needs Java 11+ and TLC 2.19 (`tla2tools.jar`). Defaults: `~/.tla/tla2tools.jar`, and `~/.tla/jdk/bin/java` if present. Override with `TLA2TOOLS` and `JAVA`. About 10 seconds.

Exit codes: `0` breaks match `expected.json`; `1` a property fails that is not listed (or a deadlock); `2` a listed finding stopped failing; `3` TLC is missing.

## What it checks

| Config | Models | Must break |
|---|---|---|
| `MC.cfg` | tracked tiered hook, core-only RAM gate, correct classifier and CI filter | none |
| `MC_untracked.cfg` | tiered hook that `npm install` can overwrite | `WebOnlyPushCheap` |
| `MC_current.cfg`, `MC_current_ram.cfg` | the old generated hook with the RAM gate on every non-docs push | `WebOnlyPushCheap`; `RamNeverBlocksWebOnly` |
| `MC_local_bug.cfg` | classifier treats a push as web-only when any file is under web | `LocalCoversLocalReq` |
| `MC_local_bug_ci_holds.cfg` | same classifier bug, CI correct | none (CI backstops it) |
| `MC_ci_bug.cfg` | CI path filter drops gates when any file is under web | `NoUnverifiedMerge` |
| `MC_both_bug.cfg` | both bugs | `NoUnverifiedMerge` |

| Action | Code |
|---|---|
| `Push`, `Unblock` | `.githooks/pre-push`, `prepush-tier.mjs` `gatesForPush`, `prepush-preflight.mjs` RAM gate |
| `Rebase` | a stale `origin/main` makes `changedFilesForPush` return null; the tier fails closed to core |
| `Clobber` | `npm install` runs `prepare`; `install-git-hooks.mjs` now sets `core.hooksPath` instead of writing hook files |
| `BypassPush` | `git push --no-verify`, only with user approval |
| `CIRun` | `.github/workflows/ci.yml` (today: every job runs on every PR, so `CIGates` is all gates) |

## Rules for changes

- A classifier change must keep `areaOf` unknown-path fallback at `core`, and mixed pushes at the union of their gates. `sigil/scripts/prepush-tier.test.mjs` pins both.
- Adding a CI path filter must compute the union of required gates over every touched area, not the first match. Model it by replacing `CIGates` and re-running `MC_ci_bug.cfg`.
- Never weaken a rule to make a config pass. If a mutation config stops breaking, the model lost the guard that mutation removes.

## What the model leaves out

Gate failures and flaky tests; Windows-only behavior; multiple pushes per branch beyond rebases; which tests live in which gate (the area-to-gate map in `PrePushGate.tla` mirrors `prepush-tier.mjs`, so update both).

## Covered code

`verify/pre-push-gate/covered-files.txt`.
