# Status

## Current goal
Federation #3 (inter-relay routing) — merged to `main` (`5c389e9`) and pushed to
`origin/main` on 2026-09-01. Feature branch deleted both sides. The two broken
live-DB suites are fixed (`0829eb5`, pushed 2026-09-02); **CI run 33610373355 is
green on all five jobs** (Secret-scan, Linux + Windows × Node 22/24), including
the live-PostgreSQL gate. I1 sync-forward transaction-boundary fix shipped (see
Completed work).

## Completed work
- Executed all 19 tasks of `docs/superpowers/plans/2026-08-30-sigil-inter-relay-routing.md` (subagent-driven-development, six batches) against spec `docs/superpowers/specs/2026-08-30-sigil-inter-relay-routing-design.md`.
- Prerequisite amendment: `sigil init --federation-owner` for cross-domain owner ids (Task 1).
- `federation_hop` column + `decideRoute` hard-stop on a truthy stored hop (Task 2); migration `017_federation_outbox.sql`.
- `federation-router.mjs`: `decideRoute` / `buildForwardRequest` / `signForwardRequest` / `postForward` / `verifyRelaySignature` (Tasks 4–7).
- Receiving side: `acceptFederatedEnvelope` checks 1–10 and the `POST /v1/federation/envelopes` route, mutual pinning, canonicalize-after-parse relay-signature verification, same-owner exemption, `federation_hop = true` persistence (Tasks 8–10).
- Origin `sync` mode: 202 forwarded / 502 `FORWARD_REJECTED` / 504 `FORWARD_UNAVAILABLE` / 500 `FORWARD_MISCONFIGURED`, nothing written locally (Task 11); CLI `--federation-mode` / `--federation-identity` validation (Task 12).
- Queue mode: `federation_outbox` repo methods, idempotent enqueue, 60s reaper (claim→commit→forward→ownership-guarded finalize, 1m/5m/30m backoff, dead-letter after 3 / on expiry, `federation.*` audit events), wired into `sigil relay up` for `queue` (Tasks 13–16).
- CLI: `sigil federation outbox list|show|retry` (no bodies, expired-retry refusal) and `sigil route test` (read-only, advisory same-owner line, sends nothing) (Tasks 17–18).
- Task 19: regression sweep (`sigil/relay/v1/federation-regression.test.mjs`), CHANGELOG + STATUS, plan close-out; plus a bounded close-out cleanup pass (reaper poison-row dead-letter guard + 6 CLI/test tidy items).
- **I1 fix** (`8fdd1fb`, pushed `origin/main`): sync forward lifted off the accept transaction (`accept-envelope.mjs`). `decideRoute` + the sync forward path now run before `withTransaction`; queue forward and local accept still open a transaction. Replay check preserved on the sync path via non-transactional pool lookup. Phase 1 has its own `try/catch → toResponse`. Sync-test `fakeRepo` updated with `withTransactionCallCount` spy; all four forward-outcome tests assert count = 0; new REPLAY_DETECTED test added. Queue-test: rollback-atomicity sub-test added (spies on `enqueueFederationForward`, asserts real txn client, verifies INSERT is rolled back on post-enqueue error).
- **I1 review follow-ups** (all pushed `origin/main`):
  - `7d14e4a` — Phase 1 catch mirrors the Phase 2 `withTransaction` `.catch`: an `AUDITED_REJECTION_CODES` rejection (`REPLAY_DETECTED`) on the sync-forward path now emits its `envelope.rejected.replay_detected` audit event, matching the local and queue paths. Sync test asserts the audit event.
  - `e8bf8b7` (S1) — sync-forward path no longer calls `repository.lookupRecipientEndpoint(id, null)` when the sender is absent from `options.registered`; the real Postgres repo hard-throws a codeless `Error` without a txn client, which mapped to `400 INVALID_ENVELOPE` instead of `500 FORWARD_MISCONFIGURED`. Test locks the 500 + asserts `lookupRecipientEndpoint` is not invoked.
  - `fabb4fe` — a direct `decideRoute` throw (not a returned `{action:'reject'}`) now routes through the Phase 1 `try/catch → toResponse` instead of escaping unhandled.

## Tests
- `node --test sigil/relay/v1/federation-regression.test.mjs` — 4/4 pass.
- `npm test` green (dep audit + JCS audit + full `node --test`); the pre-existing `sigil/scripts/live-ollama-worker-test.mjs` env failure is known-flaky and unrelated.
- Postgres live-DB matrix (migration + outbox methods + concurrency + `federation_hop` read-back) runs in CI.
- `pwsh -NoProfile -File C:\dev\scripts\verify-repo-context.ps1 -Path C:\dev\sigil-repo` preflight pass.
- CI run 33568029999 (push of `5c389e9`): Windows + Secret-scan green; Linux
  Node 22.x and 24.x fail at the "Run Live PostgreSQL Gate" step only. Unit &
  Contract Tests pass 757/0. `npm run test:live` fails 2 of 21 schema-resetting
  suites — both new in this branch, both broken test harness, not product code.
  Those two suites were fixed in `0829eb5`; CI run 33610373355 green on all five jobs.
- CI run 33683013747 (push of `fabb4fe`, I1 + follow-ups): all four test-matrix
  jobs green (Linux + Windows × Node 22/24). Only red = the **Secret-scan /
  gitleaks "missing license"** step — repo-wide infra issue (needs a
  `GITLEAKS_LICENSE` GitHub secret), unrelated to this work.

## Decisions
- Compound primary key scoping `(profile_id, endpoint_id, key_id)` to isolate connector profiles.
- Strict RFC 3339 / ISO 8601 UTC timestamp checking and explicit current-time expiry ($T_{local} \ge T_{expires}$).
- Ed25519-signed relay sync manifests with monotonic sequence enforcement.
- Two-tier fail-closed rejection audit logging with append-only fallback to `path.join(dataDir, 'logs', 'security-failures.log')`.

## Blockers
- None. The CI live-DB gate is green as of `0829eb5`.

## Resolved
- **CI live-DB gate red (2 broken new test suites)** — fixed in `0829eb5`
  (2026-09-02), test-only, no product-code change. CI run 33610373355 green.
  1. `sigil/cli/sigil-federation-outbox.test.mjs` raw-applied migrations without
     seeding `_sigil_schema_migrations`, so the CLI's
     `withRepository(..., { migrate: true })` replayed `014`'s bare
     `ADD COLUMN client_id` and exited 1. Fixed by replacing the raw apply with
     `applyMigrations(connectionString, { reset: true })` (the same helper the
     CLI runs), which seeds the ledger.
  2. `sigil/relay/v1/accept-envelope.federation-queue.test.mjs`: (a) `upsertPeer`
     used `trustMode: 'pinned'`, violating `peer_relays_trust_mode_check`
     (`016` allows only `tofu`/`static`) → now `'static'`; (b) the row
     assertions read snake_case keys but `listFederationOutbox` returns
     camelCase records → switched to `row.messageId` etc.; (c) teardown called
     `pool.end()` twice (`t.after` + a `finally repository.close()`) → single
     `t.after(() => repository.close())`, `try/finally` removed.

## Known limitations
- None.

## Next action
- Doc debt (in the `C:\dev` repo, not sigil-repo): tick the plan checkboxes in
  `docs/superpowers/plans/2026-08-30-sigil-inter-relay-routing.md`; add
  I4 `MAX_ATTEMPTS=4` notes to
  `docs/superpowers/specs/2026-08-30-sigil-inter-relay-routing-design.md`.
- Sub-project #4 (cross-federation directory/presence).



## Production packaging and host adapters (2026-08-27)

### Completed work
- Added `sigil/cli/package.json` with the global `sigil` binary mapping to `./sigil.mjs`.
- Added Windows PowerShell, macOS/Linux shell, and callback guidance for one-shot inbox waits and safe re-arm behavior.

### Tests
- Package metadata validation passed.
- Focused daemon test requires child-process execution; the restricted sandbox returned `spawn EPERM`.

### Next action
- Re-run the focused test outside the restricted sandbox or in CI.

## Policy parameters (2026-08-27)

### Completed work
- Defined endpoint, owner, conversation, and recipient inbox limits.
- Defined bounded dead-letter retry and reaper behavior.
- Defined PII, audit, credential, log, and backup retention periods with legal-hold controls.
- Closed the deferred items in `docs/specs/sigil-implementation-decisions-v1.0.md`.

### Tests
- `git diff --check` passed.

### Blockers
- Tier 1, privacy/compliance-owner, and counsel approval remain required before production rollout.
