# Agent safety gates implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three remaining agent-safety gaps with deterministic tests, isolated adversarial guidance, render verification, and reproducible dependency checks.

**Architecture:** Extend the existing healing pipeline so a failed Iron Gate produces an audit packet for a separate auditor and only passes structured remediation guidance back to the repair worker. Add a small render-verification module that launches the existing headless-browser tooling against generated HTML and rejects blank or malformed output. Add dependency validation as a checked-in script and CI/package command that verifies the lockfile and runs `npm ci`.

**Tech Stack:** TypeScript/Node.js, Node test runner, existing local-provider abstractions, Playwright/Chromium if already present, npm lockfile.

**Spec:** Ferrox Labs Field Manual No. 13 findings supplied in the user request.

## Global Constraints

- Preserve fail-closed behavior: malformed auditor output or render output fails validation.
- Do not allow the auditor to write files or return full replacement code.
- Keep validation deterministic and runnable without an LLM in unit tests.
- Do not alter unrelated working-tree changes.

---

### Task 1: Integrate adversarial cross-auditing into failed repair attempts

**Files:**
- Inspect/modify: `modules/healing/*` and the existing repair-loop caller identified by `graft ask`.
- Test: the existing healing/repair tests, plus a focused regression test beside the caller.

**Interfaces:**
- Consume the existing `runAdversarialCrossAudit(packet, localProvider)` function.
- Produce a typed audit result containing `consensus`, `blockerAnalysis`, and `targetedFixRecipe`.

- [ ] Write a failing test proving a failed Iron Gate invokes the auditor with a clean packet and does not immediately resubmit the same raw failure unchanged.
- [ ] Run the focused test and verify the expected missing-integration failure.
- [ ] Implement the smallest orchestration change: construct the packet from the failed diff, test output, declared scope, and bounded history; invoke the auditor through dependency injection; reject malformed/non-consensus guidance.
- [ ] Run the focused healing tests and the full relevant test group.

### Task 2: Add deterministic headless render-quality verification

**Files:**
- Create or modify: the existing HTML/Mermaid verification skill under `skills/html-visual-verify/`.
- Test: adjacent unit/integration test file for valid, blank, and malformed render cases.
- Modify: `package.json` only if an existing browser test command needs a stable entry point.

**Interfaces:**
- Produce `verifyRenderedAsset(path, options) -> { valid: boolean, width, height, darkFraction, colorVariance, errors[] }`.

- [ ] Write failing tests for a visible HTML asset, a blank/white asset, and a page with a browser console/runtime error.
- [ ] Run the tests and verify they fail because the render gate is absent.
- [ ] Implement browser launch, page load, screenshot/frame sampling, console-error capture, and threshold checks with explicit defaults.
- [ ] Run the focused render tests, then the existing visual-verification tests.

### Task 3: Enforce reproducible dependency hydration

**Files:**
- Create: `scripts/verify-dependencies.mjs`.
- Modify: `package.json` scripts and CI workflow if an established validation workflow exists.
- Test: `scripts/verify-dependencies.test.mjs` or the repository’s established script-test location.

**Interfaces:**
- The command exits nonzero when `package-lock.json` is absent, `npm ci --dry-run` fails, or required compiler/tokenizer packages are unavailable.
- The command exits zero when the lockfile and required packages are consistent.

- [ ] Write failing tests for a missing lockfile and missing required dependency declarations.
- [ ] Run the tests and verify they fail for the intended reasons.
- [ ] Implement lockfile/package consistency checks and an explicit `npm ci --dry-run` validation path without mutating `node_modules`.
- [ ] Wire the command into the repository’s pre-push/CI validation path.
- [ ] Run the dependency tests and the complete validation suite.

### Task 4: Review and document the gates

**Files:**
- Modify: the relevant skill README or operator documentation.
- Modify: `STATUS.md` with completed work, tests, blockers, and next action.

- [ ] Document the auditor boundary, render thresholds, and dependency command.
- [ ] Run `git diff --check` and inspect the final diff for scope violations.
- [ ] Refresh the context graph with `graft build` when the code changes are complete.

