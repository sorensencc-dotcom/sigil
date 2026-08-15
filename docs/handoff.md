# Sigil Session Handoff

**Date:** 2026-08-14
**Repository:** `sorensencc-dotcom/sigil`
**Branch:** `main`
**Checkpoint:** `d44c527`

## Status

Protocol, implementation, human-approval, and decision specs are committed
under `docs/specs/`. Executable foundation is committed under `sigil/`.

Verified current worktree: 104 tests pass with the local PostgreSQL container
enabled. Without `SIGIL_TEST_DATABASE_URL`, the live-PostgreSQL test is the
only expected skip. `git diff --check` passes.

## Implemented

- PostgreSQL migration and repository transaction boundary with mocked-pool tests
- Envelope validation with real Ed25519 verification and idempotency handling
- Endpoint registry, HTTP intake, WebSocket delivery notifications
- Delivery state machine, retries, processing failure, dead-letter behavior
- SQLite connector store, inbox/outbox, relay client, host adapter boundary
- Approval challenge/result-token scaffold with relay-origin ceremony contract
- Codex -> relay -> Claude -> relay -> Codex in-process vertical-slice test

## Next work

1. [x] Run migration against a real PostgreSQL instance and add integration coverage.
2. [x] Wire HTTP routes to repository transactions and durable delivery records.
3. [x] Complete WebSocket reconnect/poll reconciliation and authenticated transport.
4. [x] Implement relay-hosted WebAuthn ceremony and credential verification.
5. [~] Build actual Codex and Claude host adapters against connector contracts.
   Connector server/client and authenticated round-trip proof exist; real host
   runtime integrations remain.
6. [ ] Expand to all 25 conformance items, failure injection, and staging gates.
7. [ ] Implement approved plugin/connector/auth schema conformance migration.
   Migration `001_initial.sql` does not yet represent the approved §9 objects
   and fields: OIDC identities, human attributes/sessions, account links,
   endpoint tokens, approval decisions, complete capability grants, audit
   events, idempotency records, and recovery attempts. Design a forward-only
   migration, repository boundary, rollback/recovery procedure, and adversarial
   tests before claiming schema conformance. Treat this as a separate Tier
   1-scale implementation action, not cleanup of migration 001.

## Evidence checklist

- [x] Live PostgreSQL migration/repository test
- [x] PostgreSQL restart recovery followed by full live suite
- [x] HTTP repository persistence path
- [x] HTTP duplicate idempotency retry path
- [x] HTTP conflicting idempotency retry rejection
- [x] Authenticated WebSocket and reconnect reconciliation
- [x] WebAuthn credential/assertion verification
- [x] Connector HTTP client/server round trip
- [x] Codex/Claude host-runtime bootstrap with explicit Claude local processor
- [x] Contract fixture validator
- [x] Relay-side envelope and acknowledgement idempotency focused tests
- [ ] Migration 002 deployment validation
- [ ] Real Codex host runtime
- [ ] Real Claude host runtime
- [ ] Full conformance, failure injection, staging, and Tier 1 approval

## Boundaries

- Current tests prove the bounded executable slice; no production-readiness claim.
- Node 24 `node:sqlite` is experimental in current connector tests.
- Live PostgreSQL proof uses an isolated local PostgreSQL 16 container.
- WebAuthn ceremony is relay-verification proof with test assertions, not a deployed browser UX.
- Do not add Sigil files to `C:\dev`; work only in the dedicated checkout.
