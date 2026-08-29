# Status

## Current goal
Implement Local Revocation Interval Cache & Key Registry in Sigil connectors for decentralized offline verification (`docs/superpowers/plans/2026-08-28-sigil-local-revocation-cache.md`).

## Completed work
- Brainstormed and finalized design specification `docs/superpowers/specs/2026-08-28-sigil-local-revocation-cache-design.md`.
- Executed `/plan-eng-review` with Codex outside-voice analysis, incorporating authenticated key registry cache, strict ISO 8601 UTC regex, anchored fallback logging, and signed relay revocation sync manifests.
- Authored comprehensive implementation plan `docs/superpowers/plans/2026-08-28-sigil-local-revocation-cache.md` covering Tasks 1–4 with full 12-case test matrix (`TEST-REV-01` through `TEST-REV-12`).
- Implemented Task 1: SQLite schema extension with `endpoint_keys_cache`, `endpoint_revocation_intervals`, and `audit_events` tables; prepared statements and transaction-isolated batch/lookup methods on `ConnectorDatabase`.
- Implemented Task 2: Signed relay revocation sync manifest processor (`revocation-sync.mjs`) with Ed25519 signature verification, sequence monotonicity checks, and atomic batch interval storage.
- Implemented Task 3: Fail-closed offline envelope validator (`connector-validator.mjs`) with two-tier rejection audit logging, clock skew enforcement, strict ISO 8601 UTC regex checks, JCS canonicalization, and active registry/revocation checks.
- Implemented Task 4: Complete connector test suite execution (90 tests passing) and JCS / dependency audit verification.

## Tests
- `node --test sigil/connectors/v1/*.test.mjs` (90/90 passing across all suites including all 12 `TEST-REV-01` through `TEST-REV-12` cases).
- `npm run audit:deps` and `npm run audit:jcs` clean with zero dependency or canonicalization drift.
- `pwsh -NoProfile -File C:\dev\scripts\verify-repo-context.ps1 -Path C:\dev\sigil-repo` preflight pass.

## Decisions
- Compound primary key scoping `(profile_id, endpoint_id, key_id)` to isolate connector profiles.
- Strict RFC 3339 / ISO 8601 UTC timestamp checking and explicit current-time expiry ($T_{local} \ge T_{expires}$).
- Ed25519-signed relay sync manifests with monotonic sequence enforcement.
- Two-tier fail-closed rejection audit logging with append-only fallback to `path.join(dataDir, 'logs', 'security-failures.log')`.

## Blockers
- None.

## Next action
- Prepare release notes and coordinate downstream connector integration.


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
