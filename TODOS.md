# TODOS

## Wrap mutation + audit-event writes in a transaction (repo-wide)

**What:** Wrap each `repository.<mutate>(...)` + `repository.recordAuditEvent(...)` pair in `postgres-repository.mjs` in a single Postgres transaction, so a failure writing the audit event can't leave a mutation applied with no audit trail (or vice versa).

**Why:** `postgres-repository.mjs` has zero `BEGIN`/`COMMIT` usage anywhere — every mutating method (`upsertOidcIssuerAllowlist`, and after the 2026-08-25 plan lands, `upsertPeer`) calls its audit event as a separate, independently-awaited write. If the audit insert fails after the mutation succeeds, trust/config state changes with no audit record of it happening.

**Pros:** Audit trail integrity guaranteed on partial failure — currently the audit log can silently under-report real state changes.

**Cons:** Touches every mutating method across the file, not just the peer-relay ones added by the 2026-08-25 plan — a bigger, more mechanical refactor than fixing it piecemeal for just the new methods (which was considered and rejected as inconsistent — half the mutations getting the safety net and half not, for no principled reason).

**Context:** Surfaced by Codex outside-voice during `/plan-eng-review` of `docs/superpowers/plans/2026-08-25-sigil-inter-relay-trust-discovery.md`. Pre-existing pattern across the whole repository, not something the 2026-08-25 plan introduces — that plan just adds two more instances of it.

**Depends on:** Nothing — can be done independently, any time.

---

## Optimistic concurrency (CAS) on `resolvePeer`/peer-relay upserts

**What:** Add compare-and-swap semantics (e.g. compare `updatedAt` on write, reject/retry on mismatch) to `upsertPeer` in both `createMemoryRepository` and `PostgresRepository`, so two concurrent `resolvePeer`/`rotatePeer` calls for the same domain can't silently last-write-win.

**Why:** `resolvePeer` is a plain read → fetch → write with no lock. Two concurrent invocations for the same domain (e.g. an operator running two terminal commands, or a future automated caller) could interleave and have the second write clobber the first without either side knowing.

**Pros:** Correctness under concurrent invocation; a real correctness guarantee instead of "probably fine because nobody does that."

**Cons:** Complicates the simplest CRUD method in the peer-relay repository surface, for a race that has no current trigger — `resolvePeer` only runs from manual CLI invocation today (no background poller, no hot-path caller, per the 2026-08-25 plan's Global Constraints).

**Context:** Surfaced by Codex outside-voice during `/plan-eng-review` of `docs/superpowers/plans/2026-08-25-sigil-inter-relay-trust-discovery.md`. Low priority today; revisit if a future sub-project (#3 routing, or an automated peer-refresh poller) adds a caller where concurrent resolves become realistic.

**Depends on:** Nothing blocking — but most valuable once something other than a human at a terminal calls `resolvePeer`.

---

## `sigil doctor` health-ping for pinned peer relays

**What:** Extend `sigil doctor` to iterate `repository.listPeers()` and hit each pinned peer's `relayUrl` `/v1/health` (the same unauthenticated health route `sigil doctor --relay-url` already checks for one relay), reporting per-domain reachable/unreachable.

**Why:** The 2026-08-25 inter-relay trust/discovery sub-project adds a durable peer directory with no background poller (by design). `sigil doctor` today only checks a single `--relay-url` the operator explicitly passes — there's no observability into whether a *pinned* peer is still reachable without manually running `sigil peer resolve <domain>` per domain.

**Pros:** Extends observability to the trust layer the 2026-08-25 plan adds; reuses the existing `/v1/health` route and `sigil doctor` connectivity-check pattern.

**Cons:** Multi-target, partial-failure reporting is a different feature shape than `sigil doctor`'s current single-target check — deserves its own small design pass rather than a bolt-on inside the trust/discovery plan's CLI task.

**Context:** Surfaced during `/plan-ceo-review` (SELECTIVE EXPANSION cherry-pick) of `docs/superpowers/plans/2026-08-25-sigil-inter-relay-trust-discovery.md`. Deferred, not cut — the value is real once there's more than 0-1 pinned peers to check.

**Depends on:** The 2026-08-25 plan landing first (needs `listPeers()`).

---

## Federated `stream_seq` + signed per-stream checkpoint

**What:** Design a relay-signed, monotonic per-`(sender_endpoint_id, conversation_id)` checkpoint that a receiving relay can cryptographically verify (Ed25519 over `{conversation_id, sender_endpoint_id, seq, prev_hash, count}` or similar), then extend FIX-style gap detection and `session.resend_request` fulfilment across the federation hop.

**Why:** The FIX session layer (Plan 1) assigns `stream_seq` for **local conversations only**. Federated envelopes get no `stream_seq`, so a receiver behind a different relay has no gap detection or resend recovery for cross-relay conversations. The reason it is deferred: a relay-assigned sequence number sits outside the sender's envelope signature, so a receiving relay currently has no way to verify that the assigning relay's numbering is gap-free and monotonic. A buggy or hostile relay could induce spurious `session.resend_request` traffic, or silently drop a message and paper over it with a `sequence_reset` frame the receiver cannot authenticate. `sigil/migrations/016`–`017` and the `relay/v1/` module list confirm no such signed per-stream manifest exists today (federation is `peer_relays` trust pins + `federation_outbox` queue jobs + `federation-reaper`).

**Pros:** Closes the one real integrity gap in the FIX session layer; makes reliable ordered agent messaging work across relays, not just within one.

**Cons:** New signing surface that needs its own security review; the verification path and key management add real complexity. Only matters once federation is actually carrying conversation traffic in production.

**Context:** Surfaced as finding A1 during `/plan-eng-review` of the FIX session layer design (Approach A). The user chose "scope Plan 1 to single-relay" over building the checkpoint inside Plan 1. Prior learning `tofu-rotation-grace-public-key-not-proof` (2026-08-25) applies: relay-assigned data a receiver cannot verify is a trust gap, not a detail.

**Depends on:** Plan 1 (local `stream_seq` + async resend) shipped; federation carrying real conversation traffic.

---

## `business.reject` NAK envelope (FIX session layer, Plan 2)

**What:** New `business.reject` (a.k.a. `session.reject`) envelope type carrying `ref_message_id`, `ref_message_type`, `ref_stream_seq`, a fixed `reason_code` enum (`UNSUPPORTED_MSG_TYPE`, `UNKNOWN_REF`, `INVALID_BODY`, `PRECONDITION_FAILED`, `NOT_AUTHORIZED`, `OTHER`), and free-text `reason_text`. Relay validates the rejecter actually received `ref_message_id` (repository-backed cross-reference, same pattern as the `task.result` check in `accept-envelope.mjs`), delivers it into the conversation addressed to the original sender, drives the referenced delivery to `delivery_rejected` (state already exists, migration 001), and pushes a `delivery.receipt` carrying the `reason_code`.

**Why:** Completes the FIX session layer. Today a recipient that deterministically refuses a message has no structured way to say so — `processing_failed` means "tried and crashed, retryable"; `business.reject` means "refused deterministically, fix the message, do not retry." Split out of Plan 1 (decision D1) because it shares nothing with the sequence-recovery machinery except the audit-event pattern, and bolting it on doubled the new-message-type surface of Plan 1.

**Pros:** ~3 files, additive, low risk. Gives senders a clear deterministic-refusal signal distinct from transient failure. Mirrors FIX `BusinessMessageReject`.

**Cons:** Another spec + plan + review cycle instead of one.

**Context:** §4 of the FIX session layer design (Approach A). Full design text drafted in the 2026-09-08 brainstorming session. Deferred to Plan 2 during `/plan-eng-review` (D1: split seq-recovery from NAK).

**Depends on:** Plan 1 — needs the receipt-channel `stream_seq` plumbing and the generalized `relay_jobs` queue in place first.

---

## `sigil session-status <conversation>` operator CLI

**What:** A read-only CLI command that reports, for one conversation: each sender's `stream_seq` high-water mark, any known unrecovered gaps, outstanding `session.resend_request` entries, and `relay_jobs` rows scoped to that conversation.

**Why:** Plan 1 adds per-`(sender, conversation)` sequencing, gap detection, and an async resend queue. When a specific conversation misbehaves, an operator currently has to hand-write SQL against `envelopes`, `stream_sequences`, and `relay_jobs` to see its session state. A single command makes the session layer inspectable.

**Pros:** Turns per-conversation debugging from a SQL exercise into one command; complements the fleet-level observability metrics (which answer "is it working overall" but not "what is wrong with conversation X").

**Cons:** One more CLI subcommand and repository query to maintain; not needed to ship Plan 1, and low value until the session layer is in real use.

**Context:** Surfaced as a SELECTIVE EXPANSION cherry-pick candidate during `/plan-ceo-review` of the FIX session layer design. Deferred (option B) — the fleet-level observability surface was accepted into Plan 1 scope and covers the "is it working" question; this is the per-conversation drill-down, wanted once real traffic makes that a recurring need.

**Effort:** S (human ~half day / CC ~20min). **Priority:** P3.

**Depends on:** Plan 1 shipped (needs `stream_sequences`, `relay_jobs`, and the resend-request records to query).
