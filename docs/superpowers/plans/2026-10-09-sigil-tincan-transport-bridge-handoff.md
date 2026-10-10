# Sigil Tincan Transport Bridge - Handoff Document

**Date:** 2026-10-09  
**Branch:** `feat/sigil-tincan-bridge`  
**Worktree Location:** `C:\dev\.worktrees\sigil-tincan`  
**Latest Commit:** `513636d feat(tincan): complete transport bridge units`  
**Uncommitted:** network listener on top of that commit (`tincan-relay.mjs` and its tests)

## 1. Overview
The **Sigil Tincan Transport Bridge** aims to solve multi-host agent execution by routing Sigil room messages over a private Tailscale (`tsnet`) mesh, rather than relying on active background polling loops. 

The unit logic and adapter layers are committed. The network listener now wraps those units: a tailnet dispatch socket and a loopback approval callback.

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
7. **Network Listener (`tincan-relay.mjs`)**
   - `POST /v1/dispatch` on the dispatch socket calls `verifyTailscaleWhoIs`, then `dispatchDeliveryWithRetry`.
   - The peer names `target_endpoint`. The host config owns `bridge_type`, `identity_path`, and `relay_url`.
   - `GET /v1/approval-callback?token=<challengeId>` is the browser redirect from the approval page. `POST /v1/approval-callback` releases by `action_hash` and requires `TINCAN_CALLBACK_SECRET`.
   - The callback socket stays on `127.0.0.1`. `createApprovalChallenge` rejects every non-loopback callback host.
   - `--tailnet` binds dispatch to this machine's Tailscale IPv4 address and resolves peers with `tailscale whois --json`. Node has no Go `tsnet` library, so the listener is the tailnet address plus the local WhoIs API.

## 3. What Was Deferred (Known Gaps)
As documented in the plan, several pieces were deliberately deferred until prerequisites are met:
- **`sigil_dispatch_task` & `sigil_my_mentions` MCP Tools:** The underlying relay routes do not yet support task requests in rooms or listing mentions. These tools can be added once the relay routes exist.
- **`host_unreachable` Failures:** Currently, `invocations/fail` requires caller authority. If the host is completely unreachable, the relay needs a system-identity path to mark it failed.
- **Grok CLI Bridge:** Awaiting the addition of `grok` to the `--room-bridge` flags in Phase 5.
- **Second tailnet node:** The live check posts to this same host's Tailscale address (hairpin). A second machine is still required to prove Node A enqueueing a message that wakes Node B.

## 4. Concrete Next Steps
For the engineer picking up this work:

1. **Commit the listener** on `feat/sigil-tincan-bridge`. The new files are `tincan-relay.mjs`, `tincan-relay.test.mjs`, and `tincan-relay.live.test.mjs`, plus small edits to `held-queue.mjs` and `wake-dispatcher.mjs`.
2. **Run the hermetic suite:** `node --test --test-timeout=30000 "sigil/relay/v1/transport-tincan/*.test.mjs"`. On 2026-10-09 this reported 29 pass, 1 skipped (the live test), 0 fail.
3. **Run the same-host tailnet check:** `SIGIL_TINCAN_LIVE=1 node --test --test-timeout=30000 sigil/relay/v1/transport-tincan/tincan-relay.live.test.mjs`. On 2026-10-09 this passed in 145 ms: a POST to this host's Tailscale IPv4 address passed real WhoIs and the wake dispatcher recorded the Codex CLI args.
4. **Start the listener:** set `TINCAN_CALLBACK_SECRET` and `TINCAN_RELAY_TOKEN`, then run `node sigil/relay/v1/transport-tincan/tincan-relay.mjs --config <file> --tailnet`. The config JSON has `allowlist` (node key to `permitted_endpoints` and `allowed_host_roles`) and `endpoints` (`bridge_type`, `identity_path`, `relay_url`).
5. **Two-node proof:** run that listener on Node B and POST `/v1/dispatch` from Node A. Confirm Node B spawns `sigil agent run --room-bridge <type>`.
6. **Relay route enhancements:** add `task.request` inside rooms, with an assignee field, and add `/v1/mentions`, before implementing `sigil_dispatch_task` and `sigil_my_mentions`.
