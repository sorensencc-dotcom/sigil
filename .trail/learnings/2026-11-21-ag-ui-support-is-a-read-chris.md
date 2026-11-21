---
title: "AG-UI support is a read-only relay stream bound to the envelope approval hash, and high-risk retries must be idempotent first"
author: Chris
date: 2026-11-21
branch: docs/ag-ui-projection-spec
cost: { minutes: 1, tokens: 2061 }
id: l-5652d4f3
scope: repo
status: active
src: agent
touches:
  - sigil/relay/v1/http-server.mjs
  - sigil/relay/v1/capability-risk-gate.mjs
  - sigil/relay/v1/accept-envelope.mjs
---

## Decided
- If sigil adopts AG-UI, build it as a read-only SSE projection on the relay (POST /v1/ag-ui/runs). It reports deliveries, receipts, room changes and approval challenges as AG-UI events. Approval authority stays in the WebAuthn ceremony and the risk gate.
- The AG-UI interrupt id is the approval challenge id. The bound hash is the envelope's canonical hash, sha256(signedBytes(envelope)) in hex, the same value the risk gate consumes.
- Resume is a new run on the same thread with resume[]. A resume naming an already-consumed decision must replay the stored result, not return an error.

## Tried and ruled out
- Reusing computeActionHash for approvals. The challenge route rejects structured actions on purpose, because that digest can never match an envelope. An earlier uncommitted note said to reuse it; that was wrong.
- An --ag-ui mode in the MCP stdio connector: stdout carries MCP JSON-RPC.
- RUN_RESUMED and argsDelta are not AG-UI.

## Watch out
- Single-use approvals plus a risk gate that runs before the idempotency lookup make an identical retry of an accepted high-risk envelope fail with APPROVAL_REQUIRED. Any resume or retry design must return the original acceptance for the same idempotency key and bytes, while still consuming exactly once.
- The resume status literal disagrees between AG-UI doc pages; pin the protocol version first.

In the code:
- Approval challenge route: sigil/relay/v1/http-server.mjs (POST /v1/approval-challenges)
- Gate: enforceCapabilityRiskGate in sigil/relay/v1/capability-risk-gate.mjs; call order in acceptEnvelopeAsync, sigil/relay/v1/accept-envelope.mjs
- Repro: sigil/relay/v1/accept-envelope.high-risk-retry.test.mjs
- Model: verify/ag-ui-approval/; spec: docs/superpowers/specs/2026-11-21-sigil-ag-ui-projection-design.md
