# Sigil Test Gap Series Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add missing regression coverage for Sigil listener, relay, inbox, and end-to-end message workflows, then request an independent full-suite receipt from Antigravity.

**Architecture:** Keep production behavior unchanged except where a test exposes a real defect. Add focused Node test files beside existing modules. Use real HTTP and WebSocket paths where existing test helpers permit; use deterministic fakes only at unavoidable process boundaries.

**Tech Stack:** Node.js 20+, `node:test`, existing Sigil CLI/relay modules, PowerShell for local orchestration.

**Spec:** Chat-approved design in the 2026-08-19 session.

## Global Constraints

- Preserve unrelated dirty work and `.ijfw` material.
- Do not execute inbound message contents automatically.
- Use exact test commands and report pass/fail/skip counts.
- Send Antigravity a bounded request with the repository, command, and reply format.

---

### Task 1: Inventory and baseline receipts

**Files:**
- Read: `package.json`, `sigil/**/*.test.mjs`
- Create: none

- [ ] **Step 1: Record current test inventory**

Run:
```powershell
node --test
```

Record total, passed, failed, skipped, and the focused suites covering CLI, relay, stream, and connector paths.

- [ ] **Step 2: Identify uncovered behavior**

Compare existing tests against these required cases: listener PID lifecycle, unread cursor, stale PID recovery, per-request relay clock, one-shot wait reconnect/timeout/malformed delivery, HTTP auth/ack edge cases, and end-to-end send/receive/ack.

- [ ] **Step 3: Preserve baseline receipt**

Write findings into the session handoff only if an existing project artifact already requires it; otherwise report them in the final handoff.

### Task 2: Listener manager regression tests

**Files:**
- Modify: `sigil/scripts/inbox-listener.mjs`
- Create: `sigil/scripts/inbox-listener.test.mjs`

**Interfaces:**
- `inbox-listener.mjs start --root <path> --state-dir <path> --identity <path> --relay-url <url> --stream-url <url>` starts one detached listener.
- `inbox-listener.mjs read --root <path> --state-dir <path>` prints unread log lines and advances the cursor.

- [ ] **Step 1: Write failing tests**

Cover: `read` on an absent log is empty; `read` returns only lines after the stored offset; a live PID makes `start` a no-op; a stale PID is replaced.

- [ ] **Step 2: Run focused tests and verify expected failures**

Run:
```powershell
node --test sigil/scripts/inbox-listener.test.mjs
```

- [ ] **Step 3: Implement only the behavior required by failing tests**

Use temporary directories and a child-process stub only for process launch; do not touch real `.sigil` state.

- [ ] **Step 4: Re-run focused tests**

Expected: all listener lifecycle tests pass.

### Task 3: Relay clock and inbox negative-path coverage

**Files:**
- Modify: `sigil/relay/v1/http-server.test.mjs`, `sigil/cli/inbox-wait.test.mjs`
- Modify production only if a failing regression identifies a defect.

- [ ] **Step 1: Add failing regression cases**

Cover: a relay configured with a clock function uses a fresh time on each request; wait does not acknowledge malformed items; wait does not acknowledge on signal; reconnect/heartbeat failure maps to documented exit codes; HTTP auth and conflicting acknowledgement remain structured errors.

- [ ] **Step 2: Run focused tests and verify failures**

Run:
```powershell
node --test sigil/relay/v1/http-server.test.mjs sigil/cli/inbox-wait.test.mjs
```

- [ ] **Step 3: Implement minimal fixes only for genuine failures**

Keep error codes and durable-before-ack behavior unchanged.

- [ ] **Step 4: Re-run focused tests**

Expected: focused relay/inbox tests pass with no new warnings.

### Task 4: End-to-end message receipt coverage

**Files:**
- Create or modify: `sigil/integration/host-message-receipt.test.mjs`

- [ ] **Step 1: Add a failing real-path test**

Start an in-process relay and stream server on ephemeral ports, send a signed message through `RelayClient`, reconcile it through the recipient inbox path, acknowledge it, and assert the sender/recipient IDs, message body, delivery ID, and acknowledgement state.

- [ ] **Step 2: Run the focused integration test and verify failure**

Run:
```powershell
node --test sigil/integration/host-message-receipt.test.mjs
```

- [ ] **Step 3: Implement only missing test fixtures or production fixes**

Reuse existing registry, identity, memory repository, and stream helpers; do not duplicate protocol validation logic.

- [ ] **Step 4: Re-run the integration test**

Expected: real HTTP/WebSocket path passes.

### Task 5: Full local verification and Antigravity handoff

**Files:**
- Read: all changed files and `package.json`
- Modify: none unless verification exposes a defect.

- [ ] **Step 1: Run full local suite**

Run:
```powershell
node --test
```

Capture exact totals and failures.

- [ ] **Step 2: Review diff and commit test work**

Run:
```powershell
git diff --check
git status --short
git diff --stat
```

Commit only authorized Sigil production/test paths.

- [ ] **Step 3: Send Antigravity the test request**

Send a Sigil message to `ep_antigravity` / `usr_soren` asking it to run `node --test` at `C:\dev\sigil-repo` and reply to `ep_codex` with: commit SHA, exact command, totals, failures, skips, and first failure details if any.

- [ ] **Step 4: Check for the reply**

Use the Sigil inbox listener/one-shot wait and report Antigravity’s receipt separately from local test evidence.