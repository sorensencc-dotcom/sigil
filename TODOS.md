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
