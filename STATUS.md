# Status

## Current goal
Federation #3 (inter-relay routing) — merged to `main` (`5c389e9`) and pushed to
`origin/main` on 2026-09-01. Feature branch deleted both sides. The two broken
live-DB suites are fixed (`0829eb5`, pushed 2026-09-02); **CI run 33610373355 is
green on all five jobs** (Secret-scan, Linux + Windows × Node 22/24), including
the live-PostgreSQL gate. Remaining follow-up: the parked I1 sync-forward
transaction-boundary fix (see Known limitations).

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

## Tests
- `node --test sigil/relay/v1/federation-regression.test.mjs` — 4/4 pass.
- `npm test` green (dep audit + JCS audit + full `node --test`); the pre-existing `sigil/scripts/live-ollama-worker-test.mjs` env failure is known-flaky and unrelated.
- Postgres live-DB matrix (migration + outbox methods + concurrency + `federation_hop` read-back) runs in CI.
- `pwsh -NoProfile -File C:\dev\scripts\verify-repo-context.ps1 -Path C:\dev\sigil-repo` preflight pass.
- CI run 33568029999 (push of `5c389e9`): Windows + Secret-scan green; Linux
  Node 22.x and 24.x fail at the "Run Live PostgreSQL Gate" step only. Unit &
  Contract Tests pass 757/0. `npm run test:live` fails 2 of 21 schema-resetting
  suites — both new in this branch, both broken test harness, not product code.

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
- **Sync-mode federation forward holds a DB transaction across the outbound
  HTTP call (I1, parked).** In `accept-envelope.mjs`, the `forward` branch runs
  `forwardEnvelope` → `postForward` (5s timeout) from inside
  `repository.withTransaction(...)`. Nothing is written locally on that branch,
  so the transaction is not needed for correctness, but a slow or hung peer
  ties up a Postgres connection/transaction for up to the timeout. Lifting the
  branch out safely means restructuring the shared `decideRoute` /
  replay-check ordering that the `local` path also depends on, which exceeded
  the bounded final-review fix budget and carries regression risk with no
  second review pass. **Sync mode is therefore not production-ready under slow
  peers; use queue mode (`--federation-mode queue`), which enqueues to
  `federation_outbox` and forwards from the reaper entirely outside any
  transaction and is unaffected.** Follow-up: lift the sync `forward` branch
  out of `withTransaction`.

## Next action
- Parked I1 follow-up: lift the sync `forward` branch out of `withTransaction`
  in `sigil/relay/v1/accept-envelope.mjs`. Approach sketched: run the replay
  gate (`lookupAcceptedMessageId`) + `decideRoute` in a pre-check *outside*
  `withTransaction`; when it resolves to a sync forward (`federationMode` set
  and not `'queue'`, `route.action === 'forward'`), call `forwardEnvelope`
  entirely outside any transaction and return, mapping a thrown
  `FORWARD_MISCONFIGURED` through `toResponse` exactly as the existing
  `.catch` does (extract that into a shared `auditReject` helper). `local` and
  `queue` paths fall through to the unchanged transactional body (queue's
  `enqueueForward` must stay on the txn `client`). Covering tests:
  `sigil/relay/v1/accept-envelope.federation-sync.test.mjs` already asserts the
  four sync outcomes against a fake repo whose `withTransaction` is a passthrough
  — add one that fails if `withTransaction` is entered on the sync-forward path.
- Doc debt (in the `C:\dev` repo, not sigil-repo): tick the plan checkboxes in
  `docs/superpowers/plans/2026-08-30-sigil-inter-relay-routing.md`; add
  I1-PARKED + I4 `MAX_ATTEMPTS=4` notes to
  `docs/superpowers/specs/2026-08-30-sigil-inter-relay-routing-design.md`.
- Then sub-project #4 (cross-federation directory/presence).


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
