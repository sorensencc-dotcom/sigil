# Status

## Current goal
Path 3 (Package & Serviceize the Sigil Relay / CLI) — Steps 1 and 2 implemented. Runtime handoff is locally validated; production rollout remains blocked pending security and governance approval.

## Session update: 2026-09-09 Task 3
- Completed the FIX session-layer Task 3 refactor: migrated durable federation outbox rows to typed `relay_jobs`, with compatibility adapters preserving federation-visible states and CLI behavior.
- Added migration and shared job-type-scoped claim, finalize, retry, and terminal-state handling; federation reaper claims only `job_type = 'federation'`.
- Validation: 22/22 federation-focused test files passed against the disposable PostgreSQL database; `git diff --check` and changed-module syntax checks passed.
- Detailed handoff: `.superpowers/sdd/2026-09-09-sigil-fix-session-layer/task-3-report.md`.

## Session update: 2026-09-09 Task 3 fix round 1
- Added migration 022 to make `relay_jobs` genuinely generic: generic JSONB payload, nullable federation-only columns, job-type-scoped federation constraints, and type-leading claim indexes.
- Added a non-federation enqueue/claim/finalize/retry lifecycle test; restored federation gate remains 32/32 green.

## Session update: 2026-09-09 Task 3 fix round 2
- Defined generic relay-job idempotency: non-federation enqueue requires a nonblank `idempotencyKey`; migration 023 derives stable legacy keys and enforces a job-type-scoped unique identity.
- Added repeated generic enqueue regression coverage; generic lifecycle passes and the critical federation gate remains 32/32 green.

## Session update: 2026-09-09 Task 3 fix round 3
- Added direct generic key rejection coverage for omitted, empty, and whitespace-only keys.
- Added migration-023 invariant coverage for legacy backfill, check constraint, and partial unique index; focused tests pass 3/3 and federation gate remains 32/32 green.

## Session update: 2026-09-09 Task 4
- Implemented signed `session.resend_request` validation, membership and range authorization, quota reservation, typed `resend` job enqueue, audit, and 202 response without delivery or fan-out.
- Added retention-bounded resend lookup, stream `resend` and `sequence_reset` frames, asynchronous claim/push/reset/requeue/dead-letter worker, metrics, and relay startup wiring.
- Validation: Task 4 focused suites pass 14/14; federation regression set passes 53/53 executed, with 15 database-dependent tests skipped; syntax checks and `git diff --check` pass.

## Session update: 2026-09-09 Task 5 progress
- Added the connector stream-gap tracker with per-stream high-water persistence, bounded out-of-order buffering, debounced resend requests, reset handling, retry exhaustion release, and NULL-sequence fallback.
- Wired the tracker into optional `inbox-wait` polling and stream handling; default inbox behavior remains unchanged.
- Validation: tracker and inbox-wait tests pass 22/22; syntax checks and `git diff --check` pass.

## Session update: 2026-09-09 Task 6 progress
- Added `sigil resend --conversation --from --to --sender` with local signing and existing relay error mapping.
- Added `sigil inbox --local --gaps` output for known stream holes and updated CLI help.
- Validation: CLI syntax check, help output, and `git diff --check` pass.

## Session update: 2026-09-09 Task 6 verification
- Existing CLI regression suites covering configuration, ledger, receipt transport, relay startup, and stream sequences pass 14/14.

## Session update: 2026-09-09 Task 7 progress
- Added a dependency-free relay metrics registry and wired resend request, fulfillment, reset, latency, and dead-letter instrumentation into relay startup.
- Validation: focused observability, resend, worker, and relay-startup tests pass 11/11; syntax checks and `git diff --check` pass.
- Added session resend dashboard panels and alert thresholds under `docs/observability/`.

## Session update: 2026-09-09 Task 7 verification / Task 8 start
- Existing vertical slice passes 4/4 executable tests; one directory-trust case is skipped without PostgreSQL.
- `npm run test:live` is blocked because `SIGIL_TEST_DATABASE_URL` is not set; no live database evidence was claimed.

## Session update: 2026-09-09 Task 8
- Added rollout handoff covering migration order, one-way `relay_jobs` transition, flag rollback, mixed-fleet NULL behavior, recovery operations, metrics, and approval blockers.
- Docker PostgreSQL container `sigil_postgres` is healthy on host port 55432, and `sigil_test` accepts connections. The first discovered live suite exits successfully in 19.6 seconds; the aggregate runner discovers 28 schema-resetting suites, each reapplying 23 migrations, so the prior 60-second host command bound killed an in-progress aggregate and produced runner `EPIPE`. The database is available; aggregate live counts remain unconfirmed under the 60-second bound.
- Added `sigil/scripts/run-live-db-tests.ps1` with the explicit disposable-container URL as a Windows shortcut; it validates the `_test` suffix and clears the process environment afterward.
- Hardened the live runner with per-suite timeout attribution and broken-pipe handling; the Windows launcher accepts `-SuiteTimeoutSeconds` (default 120).
- Fixed PostgreSQL stream-sequence fixtures to avoid prepared multi-statement SQL and to seed valid canonical bytes, protocol, and unique endpoint keys; the live stream-sequence suite now passes 4/4 individually.

## Completed work
- Packaged CLI and verified local npm binary mapping (`sigil --help`).
- Applied PostgreSQL schema migrations 001 through 019 against the live container on port 55432.
- Updated `sigil/cli/sigil.mjs` to register PostgreSQL endpoints without implicitly granting capabilities.
- Updated `sigil/relay/v1/postgres-repository.mjs` to include `status` in `lookupRecipientEndpoint` queries and JSON-stringify payload structures (`body`, `context_refs`, `broadcast_scope`) for `jsonb` column binding.
- Updated supervisor script `C:\dev\scripts\run-sigil-daemon.ps1` to configure `$env:SIGIL_DATABASE_URL` and pass `--database-url` to persistent relay child processes.
- Verified persistent dispatch round-trip from `ep_grokbot` to `ep_claude` (`conv_persistence_test`), verified database records in `envelopes` and `deliveries`, interrupted and restarted daemon, and retrieved delivery from recipient mailbox using `sigil inbox`.
- Executed all 17 tasks of `docs/superpowers/plans/2026-09-03-sigil-cross-federation-directory.md` (subagent-driven-development) against spec `docs/superpowers/specs/2026-09-02-sigil-cross-federation-directory-design.md`.

## Validation evidence
- Local audits: `node sigil-dep-audit.mjs` passed; `node sigil-jcs-audit.mjs` passed.
- Local `npm test`: bounded wrapper exited 1 without child output; a direct rerun produced extensive passing output but no final summary before the host timeout. Final local total remains unconfirmed.
- Live PostgreSQL gate: `npm run test:live` passed against isolated database `sigil_codex_test` on PostgreSQL 16 — 124 passed, 0 failed, 0 skipped, 26 suites, exit 0. Migrations 001–019 applied.
- Existing end-to-end persistence evidence: daemon restart retained delivery and `sigil inbox` retrieved it; this was not rerun during this review.
- CI evidence: prior green CI run `33610373355` for commit `0829eb5`; not evidence for unpublished `d078c64`.

## Decisions
- Compound primary key scoping `(profile_id, endpoint_id, key_id)` to isolate connector profiles.
- Strict RFC 3339 / ISO 8601 UTC timestamp checking and explicit current-time expiry ($T_{local} \ge T_{expires}$).
- Ed25519-signed relay sync manifests with monotonic sequence enforcement.
- Two-tier fail-closed rejection audit logging with append-only fallback to `path.join(dataDir, 'logs', 'security-failures.log')`.

## Blockers
- `d078c64` is local only and must be handed off/pushed.
- PostgreSQL startup no longer grants capabilities implicitly. The HTTP capability-grant control plane now enforces a maximum 24-hour lifetime; explicit audited renewal remains a follow-up.
- Tier 1, privacy/compliance-owner, and counsel approval remain required before production rollout.

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
- Local full-suite final count is not independently confirmed in this review.
- Live DB proof uses disposable local PostgreSQL only; no staging, remote, rollback, or production proof.
- Cross-repository inter-relay documentation debt remains in `C:\dev`, outside this checkout.

## Next action
1. Hand off/push `d078c64` after this status correction and hook validation.
2. Capture a clean final local `npm test` summary in an environment where child-process execution completes.
3. Define and approve capability profiles and explicit audited renewal authorization for deployment tooling.
4. Track doc debt in the `C:\dev` repo, not here: tick the inter-relay plan checkboxes and add I4 `MAX_ATTEMPTS=4` notes.
5. Obtain required Tier 1, privacy/compliance-owner, and counsel approvals before production rollout.



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
