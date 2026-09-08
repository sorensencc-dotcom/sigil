# Status

## Current goal
Path 3 (Package & Serviceize the Sigil Relay / CLI) — completed Step 1 (CLI Distribution & Scoped Binary Mapping) and Step 2 (PostgreSQL durable relay wiring & supervisor persistence). Full test suite and end-to-end persistence dispatch verification passing.

## Completed work
- Packaged CLI and verified local npm binary mapping (`sigil --help`).
- Applied PostgreSQL schema migrations 001 through 019 against the live container on port 55432.
- Updated `sigil/cli/sigil.mjs` to auto-seed default capability grants for registered endpoints when persisting to PostgreSQL.
- Updated `sigil/relay/v1/postgres-repository.mjs` to include `status` in `lookupRecipientEndpoint` queries and JSON-stringify payload structures (`body`, `context_refs`, `broadcast_scope`) for `jsonb` column binding.
- Updated supervisor script `C:\dev\scripts\run-sigil-daemon.ps1` to configure `$env:SIGIL_DATABASE_URL` and pass `--database-url` to persistent relay child processes.
- Verified persistent dispatch round-trip from `ep_grokbot` to `ep_claude` (`conv_persistence_test`), verified database records in `envelopes` and `deliveries`, interrupted and restarted daemon, and retrieved delivery from recipient mailbox using `sigil inbox`.
- Executed all 17 tasks of `docs/superpowers/plans/2026-09-03-sigil-cross-federation-directory.md` (subagent-driven-development) against spec `docs/superpowers/specs/2026-09-02-sigil-cross-federation-directory-design.md`.

## Tests
- Full test suite: `npm test` — 336 pass, 0 fail (unit/contract/audit suite) and 841 pass, 0 fail across live worker suites.
- Verified end-to-end task persistence across daemon cycle: `sigil inbox` confirmed delivery retention.
- Preflight verified via `pwsh -NoProfile -File C:\dev\scripts\verify-repo-context.ps1 -Path C:\dev\sigil-repo`.

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
