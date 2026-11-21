# Sigil AG-UI projection design

- **Status:** Approved by Tier 1 (Chris Sorensen) in chat on 2026-11-21. Build in the order of section 9; open questions in section 10 stay open until the step that needs them.
- **Date:** 2026-11-21
- **Model:** `verify/ag-ui-approval/` (TLA+, checked with TLC; results in `verify/ag-ui-approval/expected.md`)
- **Protocol:** [AG-UI 1.0 run input specification](https://docs.ag-ui.com/spec/1.0/basic/run-input.md) and its interrupt and resume pattern

## 1. Goal

To let AG-UI clients (CopilotKit and other AG-UI frontends) watch a Sigil task and answer its approval prompts, add a read-only AG-UI event stream to the relay. The stream reports what the relay records. It never grants approval, never runs tools, and never signs anything.

## 2. Non-goals

- Starting new tasks from an AG-UI client. Phase 1 attaches to an existing task only.
- Token-level text streaming (`TEXT_MESSAGE_CONTENT` per token). Sigil carries no worker token deltas.
- A WebSocket AG-UI binding. AG-UI defines no standard WebSocket binding; SSE is the required transport.
- `STATE_DELTA` (JSON Patch). Sigil has no shared state document to patch.
- Any change to the MCP stdio connector (`sigil/connectors/v1/mcp-stdio-server.mjs`). Its stdout carries MCP JSON-RPC, so it cannot carry SSE.
- A deny decision. See section 10.

## 3. What exists today

| Surface | Location | Fact the design relies on |
|---|---|---|
| Approval challenge issue | `POST /v1/approval-challenges`, `sigil/relay/v1/http-server.mjs:400` | Body takes `action_hash` and `callback_url` only. `action_hash` must be the envelope's canonical hash, `sha256(signedBytes(envelope))` in hex. A structured `body.action` is rejected with `INVALID_ACTION`. |
| Challenge row | `createApprovalChallenge`, `sigil/relay/v1/postgres-repository.mjs:470` | Stores `challenge_id`, `endpoint_id`, `action_hash`, `webauthn_challenge`, `callback_url`, `token_hash`, `status`, `created_at`, and `expires_at`. No conversation, task, message id, capability, or envelope body. |
| Challenge shape | `createApprovalChallenge`, `sigil/relay/v1/approval-ceremony.mjs:96` | 5-minute TTL. `approvalUrl` comes from relay config (`/approve?challenge=…&cb=…`). The callback must be localhost HTTP. |
| Approval page | `renderApprovalPage`, `sigil/relay/v1/approval-ui.mjs` | Shows the action hash only. The human cannot see what they approve. |
| WebAuthn ceremony | `GET /approve`, `POST /v1/approval-challenges/:id/assertion`; `verifyWebAuthnApproval`, `approval-ceremony.mjs:121` | Binds challenge id, action hash, endpoint, origin, RP ID, and user verification. |
| Decision record | `finalizeApprovalDecision`, `postgres-repository.mjs:486` | Marks the challenge `consumed` and inserts a decision with `status = 'approved'` and the challenge's `expires_at`. No other decision status is ever written. |
| Approval consumption | `enforceCapabilityRiskGate`, `sigil/relay/v1/capability-risk-gate.mjs:26` | A high-risk envelope is accepted only if `consumeApprovalDecision` finds an `approved`, unexpired decision for its canonical hash. Consumption is single-use. |
| Live stream | `createStreamServer`, `sigil/relay/v1/stream-server.mjs:34` | WebSocket frames with bearer-token or ticket auth and an origin allowlist. |
| SSE pattern | `createMcpMemoryBridge.handleRequest`, `sigil/connectors/v1/mcp-memory-bridge.mjs:150` | Working `text/event-stream` response code to copy. |

`computeActionHash` (`sigil/relay/v1/action-hash.mjs`) is **not** the approval hash. It digests abstract action fields, and the challenge route rejects it on purpose. The projection uses the envelope canonical hash.

## 4. Statechart findings

The TLA+ model in `verify/ag-ui-approval/` covers one thread, one gated envelope, and one AG-UI client. The worker's envelope consumes the approval in the risk gate; the AG-UI client only observes, resumes, or cancels. The constant `Fixed` switches between the relay on main (`MC_current.cfg`) and this design (`MC.cfg`).

**This design (`MC.cfg`): every rule holds** (36 states). No effect without a consumed approval; an approval is consumed at most once; the effect happens at most once; an identical worker retry is not rejected; each run emits at most one terminal event; every run that was not cut ends exactly once; an error never hides an effect that happened; a success shows the result; a cut stream never counts as success; no deadlock.

**The relay on main (`MC_current.cfg`): two rules break** (40 states).

1. `WorkerRetryNotRejected`: start run, worker asks for approval, you approve, worker sends the gated envelope, worker resends the same envelope. The retry gets `403 APPROVAL_REQUIRED`.
2. `ErrorMeansNoEffect`: start run, worker asks for approval, you approve, client resumes, worker sends the gated envelope, connection drops, client retries the resume. The client sees `RUN_ERROR` although the action ran.

**Replay against real code:** path 1 reproduces on main without AG-UI. `sigil/relay/v1/accept-envelope.high-risk-retry.test.mjs` accepts an approved high-risk envelope (`202`), then sends the identical envelope and gets `403 APPROVAL_REQUIRED`. Cause: in `acceptEnvelopeAsync`, `enforceCapabilityRiskGate` (`accept-envelope.mjs:291`, and `:232` on the sync path) runs before the idempotency lookup (`accept-envelope.mjs:415`), so the already-`consumed` decision fails the gate before the duplicate path can answer. The test is marked `todo` until step 1 of section 9 lands. Path 2 needs the projection to exist; section 8 prevents it by design.

**Found while modelling:** an earlier draft ended the run with `RUN_ERROR` when a client resumed before the human approved. The human could still approve afterwards and the worker's envelope then went through, so the client showed an error for an action that took effect. Section 8 fixes this: an early resume is refused and the interrupt stays open, and an explicit cancel revokes the challenge.

<details><summary>Mermaid source: statecharts (verify/ag-ui-approval/chart.mmd, chart-current.mmd)</summary>

<!-- heuristics-disable diagram-design author="Claude" reason="draft spec; TLC-generated statecharts, rendered diagram-design PNG to follow at Tier 1 review" until="2026-12-05" -->

The generated Mermaid sources live in `verify/ag-ui-approval/chart.mmd` (this design) and `verify/ag-ui-approval/chart-current.mmd` (relay on main). To regenerate them, run:

```powershell
C:\Users\soren\.claude\skills\statechart\scripts\statechart.ps1 verify/ag-ui-approval/AgUiApproval.tla --config verify/ag-ui-approval/MC.cfg --view verify/ag-ui-approval/view.mjs --out verify/ag-ui-approval/out
```

</details>

## 5. Concept mapping

| AG-UI | Sigil |
|---|---|
| `threadId` | `conversation_id` |
| `runId` | Supplied by the client in `RunAgentInput`, as AG-UI 1.0 requires. The relay echoes it in `RUN_STARTED` and the terminal event, and rejects a reused `runId` on the same thread. The Sigil task id goes in `metadata.sigil.task_id`. |
| Tool call (`toolCallId`) | The gated high-risk envelope. `toolCallId` = its `message_id`. |
| Interrupt `id` | Approval `challenge_id` |
| Interrupt `metadata.sigil.action_hash` | Envelope canonical hash (hex), as stored on the challenge |
| Interrupt `expiresAt` | Challenge `expires_at` |
| Interrupt `reason` | `confirmation` |
| `RUN_FINISHED` success | The task's `task.result` envelope is accepted |
| `RUN_ERROR` | Relay rejection codes (`APPROVAL_REQUIRED`, `APPROVAL_EXPIRED`, `MESSAGE_EXPIRED`, `CAPABILITY_DENIED`, and others) mapped to `code` |

## 6. Endpoint

`POST /v1/ag-ui/runs` on the relay HTTP server. The response is `text/event-stream`.

- **Auth:** the same endpoint bearer token or human session as the stream server, and the same origin allowlist. A caller sees only conversations its endpoint or human is a member of.
- **Input:** AG-UI `RunAgentInput`. `threadId` = `conversation_id`. `runId` is required. `forwardedProps.sigil.task_id` selects the task to attach to. `messages`, `tools`, and `context` are accepted and ignored in phase 1. A request with neither `task_id` nor `resume` returns `400`.
- **Protocol version:** the relay requires `protocolVersion` and rejects unknown versions. Pin the version before build (see section 10).

## 7. Event mapping

| Relay fact | AG-UI event |
|---|---|
| Attach accepted | `RUN_STARTED {threadId, runId}` |
| Room or conversation history at attach time | `MESSAGES_SNAPSHOT` |
| Worker progress (`room.message` from the assignee) | `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT` (whole message as one `delta`), `TEXT_MESSAGE_END` |
| Challenge created for an envelope in this task | `TOOL_CALL_START {toolCallId, toolCallName: <capability>}`, `TOOL_CALL_ARGS {delta: <envelope body JSON>}`, `TOOL_CALL_END`, then `RUN_FINISHED {outcome: {type: "interrupt", interrupts: [...]}}` |
| Gated envelope accepted | `TOOL_CALL_RESULT {messageId, toolCallId, content}` |
| Signed receipt written | `CUSTOM {name: "sigil.receipt", value: {receipt_id, signature, stream_seq, room_seq}}` |
| `task.result` accepted | `RUN_FINISHED {outcome: {type: "success"}}` |
| Rejection | `RUN_ERROR {message, code}` |

Every run ends with exactly one `RUN_FINISHED` or `RUN_ERROR`. A stream that ends without one is a truncated run, and the client must not treat it as success.

**Challenges must carry the envelope.** Today a challenge stores only the hash, so the relay cannot link it to a thread or emit `toolCallId`, `toolCallName`, or `TOOL_CALL_ARGS`. To fix this, the challenge request gains a required `envelope` field holding the signed envelope the worker intends to send. The relay then:

1. recomputes `sha256(signedBytes(envelope))` and rejects the request with `400 INVALID_ACTION` if it differs from `action_hash`;
2. verifies the envelope signature against the sender, which must equal the authenticated endpoint;
3. stores `conversation_id`, `message_id`, `capabilities`, and the canonical envelope bytes on the challenge row (new migration).

Without step 1, an AG-UI client could show the human one set of arguments while the hash binds a different envelope. The same stored envelope feeds the `/approve` page, so the human sees what they approve instead of a bare hash.

## 8. Interrupt, resume, and cancel

1. When the relay creates a challenge for an envelope in the attached task, it emits the interrupt (section 7) and ends the stream. The interrupt carries `metadata.sigil.approval_url`, built from relay config and never from worker or client input.
2. The human approves through the existing `/approve` WebAuthn ceremony. The AG-UI client may show the link but cannot complete the approval.
3. To resume, the client sends a new `POST /v1/ag-ui/runs` with the same `threadId`, a new `runId`, and `resume: [{interruptId: <challenge_id>, status, payload}]`. The relay reads challenge and decision state. Resume never consumes an approval; only the risk gate does, when the worker's envelope arrives.

| State at resume | Relay response |
|---|---|
| Challenge still pending (not yet approved) | `409 INTERRUPT_PENDING`. No run starts; the interrupt stays open. |
| Decision `approved`, envelope not yet accepted | Stream starts and waits. On acceptance it emits `TOOL_CALL_RESULT` against the original `toolCallId`. If the decision expires first, `RUN_ERROR {code: "APPROVAL_EXPIRED"}`. |
| Decision `consumed` (envelope accepted) | Stream starts and replays the stored `TOOL_CALL_RESULT` and `sigil.receipt` at once. |
| Challenge or decision expired | `RUN_ERROR {code: "APPROVAL_EXPIRED"}`; the interrupt is closed. |

4. **Cancel:** a resume entry with the cancel status (literal pending, section 10) revokes the challenge and any unused decision for that hash, in a transaction that takes the same row lock as `consumeApprovalDecision`. A later approve or envelope then fails. If the envelope was accepted first, the cancel fails and the relay replays the stored result instead.
5. A resume must cover every open interrupt of the last interrupted run. Partial coverage returns `RUN_ERROR`.
6. While an interrupt is open, a `POST` without `resume` for that thread returns `409`.
7. **Retries are idempotent.** A resume retried after a cut stream follows the same table, so a consumed decision replays the stored result. It never returns `RUN_ERROR` for an action that took effect, and it never causes a second execution.

## 9. Build order

1. **Idempotent high-risk retry in the relay (prerequisite, standalone PR).** In both the sync and transactional paths of `acceptEnvelopeAsync`, return the duplicate `202` for the same `idempotency_key` and canonical hash before `enforceCapabilityRiskGate` runs. Keep the `REPLAY_DETECTED` check ahead of it and the `DUPLICATE_MESSAGE` conflict check. Remove the `todo` flag from `accept-envelope.high-risk-retry.test.mjs` and add a Postgres live-suite twin. A teammate learning (2026-11-03) records that moving this gate once caused double consumption; keep exactly one consumption per accepted envelope.
2. **Challenge envelope binding.** Add the `envelope` field, hash recompute, signature check, and migration from section 7. Show the stored envelope on the `/approve` page.
3. **Challenge cancel.** Add a `cancelled` challenge status and a repository method that revokes it under the consume row lock.
4. **Projection module** `sigil/relay/v1/ag-ui-projection.mjs`: pure functions from relay facts to AG-UI events, unit-tested against section 7.
5. **SSE route** `POST /v1/ag-ui/runs` in `http-server.mjs`, reusing the stream server's auth and origin checks.
6. **Resume and cancel handling** per section 8.
7. **Model drift guard:** add `verify/ag-ui-approval/covered-files.txt` and a drift script like `verify/room-delivery/drift.sh`, so changes to the risk gate, challenge repository, or projection re-run TLC against `expected.md`.

## 10. Open questions

1. **Resume `status` literals.** One AG-UI docs page uses `resolved` / `cancelled`; the 1.0 spec text says answered / abandoned. Settle both literals from the 1.0 schema reference before step 6.
2. **Interrupt fields marked draft.** `RunFinished.outcome` appears under a "Draft events" heading on the AG-UI concepts page. Confirm it is in the pinned protocol version.
3. **Deny.** Sigil records only `approved` decisions; a human who does not approve just lets the challenge expire. A deny button needs a new decision status, a ceremony change, and a model update. It is out of scope here.
4. **How the worker learns the outcome.** Today the worker calls `sigil_request_approval` and waits on the localhost callback. Confirm the projection observes this flow without changing it.
5. **Scope of the model.** It covers one gated envelope and one client. Extend it before step 6 if a task can raise several challenges at once, or if two tabs can resume the same thread.
