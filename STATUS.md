# Status

## Current goal
Federation #4 (cross-federation directory / presence) — completed Task 17 (final live-DB matrix, full-suite regression sweep, deferred-minor fold-ins, and CI verification). All live-DB and unit/contract test suites passing locally. Ready for human-supervised whole-branch review and final landing.

## Completed work
- Executed all 17 tasks of `docs/superpowers/plans/2026-09-03-sigil-cross-federation-directory.md` (subagent-driven-development) against spec `docs/superpowers/specs/2026-09-02-sigil-cross-federation-directory-design.md`.
- Migration `018_federation_directory.sql`: `federation_directory_invites`, `federation_directory_links`, `federation_outbox.kind` / `directory_payload`, and quota usage scopes (`federation_directory_invite_create`, `federation_directory_redeem`, `federation_directory_redemption_inbound`).
- Repository methods & state machines for directory invites and links across Postgres and memory repositories.
- Inbound relay authentication and verification (`verifyInboundRelayRequest`): relay-to-relay requests carry a `nonce` + `signed_at`; verification enforces a configurable freshness window (`relayRequestFreshnessMs`, default 300 s) and the 22-char base64url nonce format, and each handler consumes the nonce inside its own transaction against `federation_relay_nonces`; redeemer and issuer owner-id domains are pinned on both sides.
- Directory request signing, transmission, and client routing (`postDirectory`, `signRelayRequest`, `buildDirectoryRedemptionRequest`, etc.).
- Handlers for directory invite redemption, link confirmation, and revocation with 202/403/404/409 semantics and fail-closed audit logging.
- HTTP server wiring for directory routes with 501 capability gating on unconfigured / non-Postgres relays.
- Reaper support for directory outbox processing with backoff (1m/5m/30m): the reaper rebuilds the directory confirmation and revocation requests each pass with a fresh `nonce` + `signed_at`. Invite redemption writes no outbox row and has no durable retry — on transport failure the operator re-runs the redeem command manually.
- Step 8 federated envelope delivery checks enforcing active cross-federation directory links between distinct domains.
- CLI commands: `sigil federation invite create|list|show|revoke|redeem`, `sigil federation link list|show|confirm|revoke`, and route test advisory indicators.
- Rate limiting and quota reservation for directory invitations and redemption endpoints.
- Task 17: Live-DB test matrix in `postgres-repository.directory-federation.test.mjs`, comprehensive regression sweep, and deferred-minor fold-in.

## Tests
- Full test suite: `npm test` — 812 pass, 0 fail, 103 skipped across all suites.
- Live PostgreSQL gate: `npm run test:live` — 112 pass, 0 fail across 23 schema-resetting suites run sequentially.
- Targeted Step 3 Live-DB matrix: 36 pass, 0 fail across directory federation, peer repo, CLI directory, CLI route-test, and HTTP server directory suites.
- Targeted Step 4 Regressions: 79 pass, 0 fail across sync mode 501 gates, trust mode, and inter-relay routing suites.
- Preflight verified via `pwsh -NoProfile -File C:\dev\scripts\verify-repo-context.ps1 -Path C:\dev\sigil-repo`.
- CI live-DB runner (`sigil/scripts/live-db-tests.mjs`) automatically discovers any suite referencing `SIGIL_TEST_DATABASE_URL`, fully covering all directory DB suites.

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
