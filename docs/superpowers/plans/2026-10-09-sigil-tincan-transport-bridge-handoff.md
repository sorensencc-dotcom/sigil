# Sigil Tincan Transport Bridge - Handoff Document

**Date:** 2026-10-09, updated 2026-10-10  
**Branch:** `feat/sigil-tincan-bridge`  
**Worktree Location:** `C:\dev\.worktrees\sigil-tincan`  
**Listener:** `3a7214c feat(tincan): serve dispatch on the tailnet` is already on `origin/feat/sigil-tincan-bridge`. This file is the resume record on top of that commit.  
**Worktree state:** clean aside from untracked `.ignore`, `.kb_cache/`, and `codex_prompt.txt`

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
- **Second tailnet node:** Passed 2026-10-10. `100.80.111.33` posted to `100.109.165.118` and the laptop relay returned `DELIVERED` with spawn pid 23332. The same-host hairpin remains a separate check.

## 4. Concrete Next Steps
Start here. Steps that already passed stay as evidence, not as work.

1. **Two-node proof. Passed 2026-10-10.** Node B was `laptop-66oogh2m` (`100.109.165.118`), running `node sigil\relay\v1\transport-tincan\tincan-relay.mjs --config %TEMP%\tincan-two-node-config.json --tailnet` from the clone at `C:\Users\soren\$root`. Node A was `win-dta4v21lkvr` (`100.80.111.33`). `POST /v1/dispatch` returned HTTP 200 `{"status":"DELIVERED","node":"win-dta4v21lkvr.tailb2474f.ts.net.","alreadyRunning":false,"endpointId":"ep_codex","pid":23332}`. WhoIs named the caller. The laptop relay spawned pid 23332 through `node sigil/cli/sigil.mjs agent run --room-bridge codex`. The agent identity was `proof-identity.json` and the relay URL was `http://127.0.0.1:8791`, so that process can exit after the spawn. `DELIVERED` records the spawn, not a finished room turn.
2. **Relay routes.** Add `task.request` inside rooms, with an assignee field, and add `/v1/mentions`, before implementing `sigil_dispatch_task` and `sigil_my_mentions`.
3. **Already verified on 2026-10-09 and 2026-10-10.** Hermetic `node --test --test-timeout=30000 "sigil/relay/v1/transport-tincan/*.test.mjs"`: 29 pass, 1 skipped, 0 fail. `SIGIL_TINCAN_LIVE=1` hairpin to this host's Tailscale address: pass in 145 ms. Pre-push `npm test` for `3a7214c`: 1471 pass, 0 fail, 175 skipped. A later docs push was cancelled once by `sigil/cli/relay-up-p2p.test.mjs:58` at 30000 ms (0 fail, 1 cancelled). That timeout is outside tincan. Push with Git bash on `PATH`. `C:\Windows\System32\bash.exe` cannot open the hook file.
