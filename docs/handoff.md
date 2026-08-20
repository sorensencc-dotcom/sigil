# Sigil Session Handoff

**Date:** 2026-08-19
**Repository:** `sorensencc-dotcom/sigil`
**Branch:** `main`
**Checkpoint:** `12d1bb4`

## Status

Protocol, implementation, human-approval, decision specs, and all 8 conformance gap closure workstreams (`D → F → B → A → C → E → H → G`) are implemented and committed.

Verified current worktree:
- **JCS Conformance Gate (`npm run audit:jcs`)**: 100% PASS across all 109 source files.
- **Unit & Contract Suite (`npm test`)**: 311 passed, 0 failed.
- **Live PostgreSQL Gate (`npm run test:live`)**: 30 passed, 0 failed, 0 skipped across 4 schema-resetting suites.
- **Total test coverage**: 341 tests passed, 0 failed, 0 skipped.

## Implemented

- **Task D (JCS Canonicalization)**: RFC 8785 canonicalization pinned to `canonicalize: "2.0.0"`; standalone `sigil-jcs-audit.mjs` pre-commit gate.
- **Task F (Task Body Schemas)**: `task-request-schema.mjs` and `task-result-schema.mjs` contract schemas with cross-reference integrity checks.
- **Task B (Replay Detection)**: Scoped `(sender_endpoint_id, message_id)` duplicate detection distinguishing first-time expiry, duplicate retries, and replay attacks.
- **Task A (Capability Authorization)**: Fail-closed capability registry, hierarchy resolution via `scope.mjs`, and row-level locked grants (`FOR UPDATE`).
- **Task C (Rejection Audits & Audit Query)**: `rejection-audit.mjs` two-tier bounded retry with fallback log, `conversation_id` column binding, and `GET /v1/audit`.
- **Task E (Rate & Depth Limits)**: Multi-scope rolling-window rate limits and recipient open-inbox depth limits.
- **Task H (Receipts & Heartbeats)**: Sender-side `delivery.receipt` WebSocket notifications, application-level JSON ping/pong heartbeats, and stress testing.
- **Task G (Identity Integrity)**: Display-name collision constraints and `POST /v1/endpoint-acknowledgements` viewer-scoped acknowledgements.
- **Connectors & MCP**: `sigil_ack_delivery` wired end-to-end with outcome/reason forwarding and `sigil.task/process` capability boundary.

## Evidence checklist

- [x] JCS RFC 8785 audit gate scan across all repository files
- [x] Live PostgreSQL migration/repository test (`npm run test:live`, 30/30 passed)
- [x] PostgreSQL restart recovery followed by full live suite
- [x] HTTP repository persistence path
- [x] HTTP duplicate idempotency retry path
- [x] HTTP conflicting idempotency retry rejection
- [x] Authenticated WebSocket and reconnect reconciliation
- [x] WebAuthn credential/assertion verification
- [x] Connector HTTP client/server round trip
- [x] End-to-end `sigil_ack_delivery` MCP tool with real Codex and Claude host runtimes
- [x] Real Claude and Codex host runtimes wired through connector client/server
- [x] Contract fixture validator
- [x] Relay-side envelope and acknowledgement idempotency focused tests

## Boundaries

- Node 24 `node:sqlite` is experimental in current connector tests.
- Live PostgreSQL proof uses an isolated local PostgreSQL 16 container.
- WebAuthn ceremony is relay-verification proof with test assertions, not a deployed browser UX.
- Work is strictly confined to `C:\dev\sigil-repo`.

