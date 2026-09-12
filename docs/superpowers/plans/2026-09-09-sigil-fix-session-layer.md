# Sigil FIX session layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add relay-assigned per-sender conversation sequencing, asynchronous FIX-style resend recovery, connector gap tracking, CLI controls, and operational evidence without blocking normal delivery.

**Architecture:** Add nullable `stream_seq` assignment inside the existing accept transaction, then expose it on inbox and stream frames. Generalize the federation outbox into a typed `relay_jobs` queue before adding resend jobs and a worker. Keep resend fulfilment asynchronous, signed-request based, membership-authorized, retention-bounded, and fail-closed with `sequence_reset` or connector `unrecoverable_gap` events.

**Tech Stack:** Node.js ESM, PostgreSQL migrations, colocated `node:test` suites, existing relay config, audit, quota, stream, and CLI abstractions.

**Spec:** `docs/superpowers/specs/2026-09-08-sigil-fix-session-layer-design.md`

## Global Constraints

- Sequence scope is `(sender_endpoint_id, conversation_id)` and relay-assigned.
- `stream_seq.enabled` defaults to false; federated inbound envelopes remain NULL.
- Normal delivery remains non-blocking; gap detection requests recovery without strict in-order relay delivery.
- `session.resend_request` creates no delivery and performs no fan-out on the accept transaction.
- Resend serves only unexpired envelopes within the existing 24-hour retention bound.
- `end_seq: 0` means current high-water; requested ranges over 500 are `INVALID_ENVELOPE`.
- Closed requester sockets re-queue with backoff; the first miss never dead-letters.
- The federation suite is the critical regression gate after queue extraction.
- Do not implement `business.reject`, federated sequencing/checkpoints, retention changes, or `sigil session-status`.

### Task 1: Add migration and repository sequence primitives

**Files:**
- Create: `sigil/migrations/020_stream_sequence.sql`
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Test: `sigil/relay/v1/postgres-repository.stream-sequence.test.mjs`

**Interfaces:**
- Produce `assignStreamSequence(client, senderEndpointId, conversationId)` returning the assigned bigint, and repository projections exposing `streamSeq`.
- Preserve existing repository method names and camelCase result shape.

- [ ] **Step 1: Write failing migration/repository tests** covering migration application, first sequence `1`, concurrent contiguous values, rollback not consuming a value, NULL when disabled, and `listInbox` returning `streamSeq`.
- [ ] **Step 2: Run `node --test sigil/relay/v1/postgres-repository.stream-sequence.test.mjs` and verify failure because migration and method are absent.**
- [ ] **Step 3: Add migration:** create `stream_sequences`, add nullable `envelopes.stream_seq`, and create the partial unique index exactly as specified in S1.
- [ ] **Step 4: Implement the transaction-participating upsert:**

```js
INSERT INTO stream_sequences (sender_endpoint_id, conversation_id, next_seq, updated_at)
VALUES ($1, $2, 2, now())
ON CONFLICT (sender_endpoint_id, conversation_id)
DO UPDATE SET next_seq = stream_sequences.next_seq + 1, updated_at = now()
RETURNING next_seq - 1 AS assigned_seq
```

- [ ] **Step 5: Add `e.stream_seq AS "streamSeq"` to inbox projection and map NULL unchanged.**
- [ ] **Step 6: Run focused tests, migration tests, and `git diff --check`; commit `feat: add relay stream sequence persistence`.**

### Task 2: Stamp and expose stream sequences

**Files:**
- Modify: `sigil/relay/v1/accept-envelope.mjs`
- Modify: `sigil/relay/v1/accept-federated-envelope.mjs`
- Modify: `sigil/relay/v1/relay-config.mjs`
- Modify: `sigil/relay/v1/stream-server.mjs`
- Test: `sigil/relay/v1/accept-envelope.stream-sequence.test.mjs`
- Test: `sigil/relay/v1/stream-server.stream-sequence.test.mjs`

**Interfaces:**
- Consume `assignStreamSequence` and `stream_seq.enabled`.
- Produce `streamSeq` on `delivered` and `delivery.receipt` payloads; add frame types `resend` and `sequence_reset` without changing the socket channel.

- [ ] **Step 1: Add failing tests** for flag-off NULL, local normal-message stamping, broadcast stamping, federated NULL, and both existing push payloads.
- [ ] **Step 2: Run focused tests and confirm failure.**
- [ ] **Step 3: Read the resolved relay config using the same path as quota and heartbeat settings; default `stream_seq.enabled` to false.**
- [ ] **Step 4: After validation and recipient checks, call the sequence upsert in the existing transaction only for local normal conversational messages; assign the returned value to the envelope insert.**
- [ ] **Step 5: Keep `accept-federated-envelope.mjs` from assigning any sequence.**
- [ ] **Step 6: Include `stream_seq` in receipt and delivered frames, preserving NULL compatibility.**
- [ ] **Step 7: Run focused tests and `git diff --check`; commit `feat: stamp and expose relay stream sequences`.**

### Task 3: Extract federation into typed relay jobs

**Files:**
- Create: `sigil/migrations/021_relay_jobs.sql`
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Modify: `sigil/relay/v1/federation-reaper.mjs`
- Modify: federation queue/outbox call sites identified by `graft callers` and existing federation tests
- Test: `sigil/relay/v1/federation-reaper.test.mjs`
- Test: `sigil/relay/v1/postgres-repository.federation-outbox.test.mjs`
- Test: `sigil/cli/sigil-federation-outbox.test.mjs`

**Interfaces:**
- Produce shared claim, retry, terminal-state, and dead-letter helpers keyed by `jobType`.
- Map federation `forwarded`/`forward_rejected` behavior to `done`/`rejected` while preserving public federation results.

- [ ] **Step 1: Add migration test** asserting existing federation rows become `job_type = 'federation'`, typed states exist, and federation-specific data remains readable.
- [ ] **Step 2: Run the complete federation-focused command set and record the pre-refactor baseline.**
- [ ] **Step 3: Rename/generalize the table with nullable federation fields or payload preservation; add `job_type`, generalized states, and timestamps without dropping data.**
- [ ] **Step 4: Extract one shared claim/retry/dead-letter implementation and route only `job_type = 'federation'` through it.**
- [ ] **Step 5: Run all federation tests, including `sigil/cli/sigil-federation-outbox.test.mjs`; this task cannot land if the critical regression gate fails.**
- [ ] **Step 6: Commit `refactor: move federation delivery onto relay jobs`.**

### Task 4: Implement signed resend requests and asynchronous worker

**Files:**
- Create: `sigil/contracts/v1/session-resend-request-schema.mjs`
- Modify: `sigil/contracts/v1/validate-contracts.mjs` (or the current `validateEnvelope` module)
- Modify: `sigil/relay/v1/accept-envelope.mjs`
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Create: `sigil/relay/v1/resend-worker.mjs`
- Modify: `sigil/relay/v1/stream-server.mjs`
- Test: `sigil/contracts/v1/session-resend-request-schema.test.mjs`
- Test: `sigil/relay/v1/accept-envelope.resend.test.mjs`
- Test: `sigil/relay/v1/resend-worker.test.mjs`

**Interfaces:**
- Request body: `{ target_sender_endpoint_id, conversation_id, begin_seq, end_seq }`; `end_seq = 0` resolves to current high-water.
- Resend job payload: `{ requester_endpoint_id, target_sender_endpoint_id, conversation_id, begin_seq, end_seq }`.
- Worker emits `{ type: "resend", stream_seq, envelope }` or one `sequence_reset` control frame.

- [ ] **Step 1: Write failing contract and accept tests** for schema, signature validation, active membership, quota accounting, 500-range cap, 202 response, no delivery, no fan-out, audit event, and one typed queue row.
- [ ] **Step 2: Run focused tests and confirm failure.**
- [ ] **Step 3: Add the contract schema and validator dispatch for `session.resend_request`; retain normal envelope signature verification.**
- [ ] **Step 4: In the accept transaction, authorize active membership, enforce range cap, record quota/audit, enqueue one `resend` job, and return 202.**
- [ ] **Step 5: Add repository lookup ordered by `stream_seq`, excluding expired rows at fulfilment time.**
- [ ] **Step 6: Implement worker claim/complete/requeue behavior; push original signed envelopes, collapse missing/expired ranges into `sequence_reset`, and dead-letter only after retry max.**
- [ ] **Step 7: Add `session.resend_fulfilled` audit and resend metrics/logs at accept, push, reset, and dead-letter points.**
- [ ] **Step 8: Run resend tests plus the complete federation suite; commit `feat: add asynchronous session resend jobs`.**

### Task 5: Build connector gap tracker

**Files:**
- Create: `sigil/connectors/v1/stream-gap-tracker.mjs`
- Modify: `sigil/cli/inbox-wait.mjs`
- Modify: host adapter integration points under `sigil/connectors/v1/`
- Test: `sigil/connectors/v1/stream-gap-tracker.test.mjs`

**Interfaces:**
- Export `createStreamGapTracker({ loadHighWater, saveHighWater, sendResendRequest, onEnvelope, onEvent, now, config })`.
- Accept delivered/resend frames and `sequence_reset`; expose buffered gaps and missing ranges for CLI/adapters.

- [ ] **Step 1: Write failing tests** for contiguous advance, one debounced request, duplicate drop, reset flush, restart reload, reissue of one outstanding request, bounded buffer, retry exhaustion, and NULL sequencing fallback.
- [ ] **Step 2: Run the focused tracker test and confirm failure.**
- [ ] **Step 3: Implement per-stream state keyed by conversation and sender, with `last_contiguous_seq`, bounded buffer 200, and one outstanding range.**
- [ ] **Step 4: Reuse heartbeat-style backoff/max constants from `relay-config.mjs`; persist and reload high-water through injected storage.**
- [ ] **Step 5: On reset set cursor to `new_seq - 1`, flush ordered buffer, and emit the permanent-loss event; on exhausted recovery release buffered messages and emit exactly one `unrecoverable_gap`.**
- [ ] **Step 6: Wire `inbox-wait.mjs` ledger storage and adapter stores without changing NULL/federated behavior.**
- [ ] **Step 7: Run connector tests and `git diff --check`; commit `feat: add connector stream gap recovery`.**

### Task 6: Add inbox and resend CLI commands

**Files:**
- Modify: `sigil/cli/sigil.mjs`
- Modify: `sigil/cli/inbox-wait.mjs`
- Create or modify: existing CLI command module selected by current command dispatch
- Test: `sigil/cli/sigil-inbox-gaps.test.mjs`
- Test: `sigil/cli/sigil-resend.test.mjs`

**Interfaces:**
- `sigil inbox` remains contiguous per stream and falls back to queued order for NULL sequences.
- `sigil inbox --gaps` prints stream missing ranges and buffered envelopes.
- `sigil resend --conversation C --from N --to M --sender ep_X` emits one signed request.

- [ ] **Step 1: Add failing parser/output tests** for both commands, invalid ranges, and missing required flags.
- [ ] **Step 2: Run focused tests and confirm failure.**
- [ ] **Step 3: Route inbox output through the tracker and implement `--gaps` from tracker state.**
- [ ] **Step 4: Build and sign one `session.resend_request` from the CLI flags, preserving sender identity and existing transport error mapping.**
- [ ] **Step 5: Run CLI tests and `sigil --help`; commit `feat: add session gap CLI controls`.**

### Task 7: Add observability and end-to-end coverage

**Files:**
- Modify: existing relay metrics registry module used by quota metrics
- Modify: existing structured logger integration
- Create: dashboard panel specification under the repository’s existing observability docs location
- Modify: `sigil/integration/vertical-slice.test.mjs`
- Test: relevant relay/worker/connector tests

**Interfaces:**
- Metrics: `sigil_resend_request_total`, `sigil_resend_fulfilled_total`, `sigil_resend_latency_seconds`, `sigil_sequence_reset_total`, `sigil_relay_jobs_depth`, and `sigil_relay_jobs_oldest_age_seconds`.
- Events/log fields include conversation, sender, requester, range, reason, job type, and attempt count without envelope bodies or private keys.

- [ ] **Step 1: Add failing metric assertions** for accepted resend and sequence reset, plus structured log field assertions.
- [ ] **Step 2: Implement six metric families and dashboard/alert definitions for resend age and reset spikes.**
- [ ] **Step 3: Extend the vertical slice to drop message 3 of 5, assert request `[3,3]`, assert resend push, and assert app delivery `1..5`; add observability assertions.**
- [ ] **Step 4: Run the vertical slice with a hard timeout and the focused relay/connector suites; commit `test: cover session recovery and observability`.**

### Task 8: Run rollout validation and handoff

**Files:**
- Modify: `STATUS.md`
- Modify: deployment/runbook location selected by existing Sigil documentation conventions

- [ ] **Step 1: Apply migrations 020 and 021 to an isolated disposable PostgreSQL database and verify migration ledger entries.**
- [ ] **Step 2: Run the complete federation suite after queue refactor, all focused session suites, and `npm run test:live` with a hard timeout wrapper.**
- [ ] **Step 3: Run `git diff --check`, inspect staged scope, and confirm `stream_seq.enabled` remains false by default.**
- [ ] **Step 4: Document staging rollout order, one-way `relay_jobs` migration, flag rollback, mixed-fleet NULL behavior, metrics, and unresolved production approvals.**
- [ ] **Step 5: Update `STATUS.md` with exact commands, counts, commit IDs, and any local/CI/live evidence; commit `docs: add session layer rollout handoff`.**

## Self-review checklist

- S1–S9 map to Tasks 1–8; all 22 design test cases have explicit coverage.
- The federation rename lands before resend jobs and has a dedicated critical regression gate.
- No task relies on undefined symbols: the tracker factory, sequence helper, schema body, job payload, and stream frame names are defined above.
- No retention, federated sequencing, NAK, or deferred session-status work is included.

