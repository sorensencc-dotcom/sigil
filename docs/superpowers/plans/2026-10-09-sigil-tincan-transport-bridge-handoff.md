# Sigil Tincan Transport Bridge - Handoff Document

**Date:** 2026-10-09  
**Branch:** `feat/sigil-tincan-bridge`  
**Worktree Location:** `C:\dev\.worktrees\sigil-tincan`  
**Latest Commit:** `513636d feat(tincan): complete transport bridge units`

## 1. Overview
The **Sigil Tincan Transport Bridge** aims to solve multi-host agent execution by routing Sigil room messages over a private Tailscale (`tsnet`) mesh, rather than relying on active background polling loops. 

During this session, we completed the **unit logic and adapter layers** for the bridge. The implementation is fully tested, committed, and ready for network-layer binding.

## 2. What Was Completed
All 7 implementation tasks outlined in the plan have been successfully built, tested, and committed:

1. **Local Developer MCP Adapter (`rooms-mcp-tools.mjs`)**
   - Implemented `sigil_list_rooms`, `sigil_read_room`, and `sigil_post_message`.
   - Wired directly into the existing `mcp-stdio-server`, allowing local CLIs (Claude, Codex) to interact with rooms.
2. **Tailscale Node-to-Endpoint Allowlisting (`whois-auth.mjs`)**
   - Implemented L4 WhoIs verification `verifyTailscaleWhoIs`.
   - Rejects unauthorized nodes (`UNAUTHORIZED_NODE`, `NODE_NOT_IN_ALLOWLIST`) and endpoint mismatches (`NODE_NOT_AUTHORIZED_FOR_ENDPOINT`).
3. **Push Wake Dispatcher (`wake-dispatcher.mjs`)**
   - Implemented targeted process spawning for sleeping agents using the exact CLI flags: `sigil agent run --room-bridge <type> --room-sessions <store>`.
4. **Dispatch Lifecycle with Retries (`dispatch-lifecycle.mjs`)**
   - Built the 45s delivery budget/retry state machine.
   - Accurately maps terminal failures (`host_unreachable`, `wake_process_failed`, `wake_timeout`) directly to canonical room invocation failures.
5. **Immutable Held Queue for Approvals (`held-queue.mjs`)**
   - Built `createHeldQueue` which freezes capability-gated envelopes.
   - Binds the WebAuthn challenge strictly to the canonical hash: `sha256(signedBytes(envelope))`.
6. **Integration Verification (`tincan-integration.test.mjs`)**
   - Validated that all components compose properly.
   - Proved that the held-queue hash mathematically matches the exact hash consumed by the real `enforceCapabilityRiskGate`.

## 3. What Was Deferred (Known Gaps)
As documented in the plan, several pieces were deliberately deferred until prerequisites are met:
- **`sigil_dispatch_task` & `sigil_my_mentions` MCP Tools:** The underlying relay routes do not yet support task requests in rooms or listing mentions. These tools can be added once the relay routes exist.
- **`host_unreachable` Failures:** Currently, `invocations/fail` requires caller authority. If the host is completely unreachable, the relay needs a system-identity path to mark it failed.
- **Grok CLI Bridge:** Awaiting the addition of `grok` to the `--room-bridge` flags in Phase 5.
- **Network Protocol Binding:** The raw `tsnet` HTTP server and webhook callback endpoints were not built. They require a live Tailnet for validation.

## 4. Concrete Next Steps
For the engineer picking up this work:

1. **Review & Merge Units**
   - Inspect commit `513636d` on `feat/sigil-tincan-bridge`.
   - All tests pass via: `node --test --test-timeout=30000 sigil/relay/v1/transport-tincan/ sigil/connectors/v1/rooms-mcp-tools.test.mjs sigil/connectors/v1/mcp-stdio-server.test.mjs`.
2. **Build the Network Listener**
   - Wrap the completed unit logic inside a live Tailscale `tsnet` HTTP server (`tincan-relay`).
   - Create the `POST /v1/dispatch` endpoint that consumes `dispatchDeliveryWithRetry` and `verifyTailscaleWhoIs`.
   - Create the WebAuthn callback receiver (`/v1/approval-callback`) that invokes `heldQueue.releaseEnvelope()` upon approval.
3. **End-to-End Tailnet Testing**
   - Deploy `tincan-relay` on two distinct nodes.
   - Post a room message targeting an offline agent on Node B. 
   - Verify Node A's relay enqueues the delivery, Node B's Tincan dispatcher wakes the agent process, and the message routes successfully.
4. **Relay Route Enhancements**
   - Update the Sigil relay to support `task.request` inside rooms and a new `/v1/mentions` route to unlock the remaining MCP tools.
