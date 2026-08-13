# Sigil Session Handoff

**Date:** 2026-08-13
**Repository:** `sorensencc-dotcom/sigil`
**Branch:** `main`
**Checkpoint:** `2751120`

## Status

Protocol, implementation, human-approval, and decision specs are committed
under `docs/specs/`. Executable foundation is committed under `sigil/`.

Verified checkpoint: 50/50 Node tests pass, contract validator passes, and
`git diff --check` passes. Remote `origin/main` matches local checkpoint.

## Implemented

- PostgreSQL migration and repository transaction boundary with mocked-pool tests
- Envelope validation with real Ed25519 verification and idempotency handling
- Endpoint registry, HTTP intake, WebSocket delivery notifications
- Delivery state machine, retries, processing failure, dead-letter behavior
- SQLite connector store, inbox/outbox, relay client, host adapter boundary
- Approval challenge/result-token scaffold with relay-origin ceremony contract
- Codex -> relay -> Claude -> relay -> Codex in-process vertical-slice test

## Next work

1. Run migration against a real PostgreSQL instance and add integration coverage.
2. Wire HTTP routes to repository transactions and durable delivery records.
3. Complete WebSocket reconnect/poll reconciliation and authenticated transport.
4. Implement real relay-hosted WebAuthn ceremony and credential verification.
5. Build actual Codex and Claude host adapters against connector contracts.
6. Expand to all 25 conformance items, failure injection, and staging gates.

## Boundaries

- Current tests are focused/local; no production-readiness claim.
- Node 24 `node:sqlite` is experimental in current connector tests.
- PostgreSQL repository has mocked-pool coverage, not live database proof.
- Approval ceremony is a scaffold, not a browser-backed WebAuthn proof.
- Do not add Sigil files to `C:\dev`; work only in the dedicated checkout.
