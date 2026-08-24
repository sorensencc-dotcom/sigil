# Changelog

All notable changes to the Sigil governed task relay and connector are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Added `POST /v1/auth/login`: production OIDC login backed by live IdP
  discovery and JWKS fetch (RS256/ES256, aud/azp validation, JWKS caching
  with rotation refetch). Closes the "real IdP integration" roadmap item.

## [0.2.1] - 2026-08-21

### Added
- **Standing PostgreSQL startup auto-migrations**: Automated execution of all schema migrations on relay startup before endpoint provisioning in `cmdRelayUp`.
- **Database migration CLI script**: Added `npm run db:migrate` via `sigil/scripts/apply-migrations.mjs`.
- **Empty-database integration test**: Added `sigil/cli/sigil-relay-postgres-startup.integration.test.mjs` to verify automated schema initialization and endpoint registration.
- **Explicit Ollama fallback gating & unit tests**: Added `SIGIL_OLLAMA_FALLBACK` requirement to prevent false-positive offline test passes, and added `sigil/scripts/ollama-worker-fallback.test.mjs`.
- **Scoped npm publishing workflow**: Added GitHub Actions workflow `.github/workflows/release.yml` for tag-triggered npm releases with OpenID Connect (OIDC) provenance.

### Fixed
- **PostgreSQL conversation foreign key constraints**: Auto-created conversation and conversation member rows on envelope intake.
- **Relay inbox query parameter typing**: Added explicit timestamp casting (`$2::timestamptz`) in `PostgresRepository.listInbox`.
- **Delivery state lifecycle progression**: Transitioned unread messages from `queued` to `delivered` during inbox inspection so subsequent acknowledgments succeed.
- **CLI command routing in binary entry point**: Corrected asynchronous module execution and command branch fallthrough in `bin/sigil.mjs`.

## [0.2.0] - 2026-08-20

### Added
- **RFC 8785 JSON Canonicalization Scheme (JCS)**: Integrated canonicalization pinned to `canonicalize@2.0.0` with repository audit gate `sigil-jcs-audit.mjs` verifying 100% compliance across all 116 source files.
- **Contract schema validation**: Added strict JSON schemas for `task.request` and `task.result` envelopes in `sigil/contracts/v1/`, enforcing cross-reference checks and `envelopes_task_request_lookup_idx` partial expression index queries.
- **Fail-closed capability authorization**: Implemented hierarchical path matching in `sigil/core/v1/scope.mjs`, automatic target scope derivation for shared contexts, and row-level `SELECT ... FOR UPDATE` lock escalation on active grants.
- **Two-tier audit durability**: Added non-blocking rejection auditing in `sigil/relay/v1/rejection-audit.mjs` with dedicated connection checkout, 250ms retry timers, and local file fallback logging.
- **Scoped replay attack protection**: Added composite `(sender_endpoint_id, message_id)` uniqueness indexes and early rejection evaluations in `acceptEnvelopeAsync`.
- **Real-time WebSocket receipts & liveness**: Added streaming `delivery.receipt` events (`delivered` and `acknowledged`), application-level JSON heartbeat framing (`type: "ping"` / `type: "pong"`), and reconnection recovery.
- **Viewer-scoped identity verification**: Added `POST /v1/endpoint-acknowledgements` authenticated endpoint and normalized stored column indexes (`endpoints_owner_display_name_idx`) to prevent display-name collision spoofing.
- **WebAuthn biometric approval ceremony**: Implemented browser ceremony UI in `sigil/relay/v1/approval-ui.mjs` with script-injection escaping, sliding-window attempt throttling, and server-enforced relay origin verification.
- **Autonomous agent daemon**: Added `sigil/cli/agent-daemon.mjs` for background task listening and autonomous cryptographic response execution.
- **Dependency audit gate**: Added `sigil-dep-audit.mjs` to block undeclared dependency hoisting from parent directories.

### Changed
- **Node.js runtime support**: Raised minimum supported engine baseline to Node.js `>=22.0.0`.
- **Database transaction boundaries**: Standardized on transactional connection checkout (`withTransaction`) across all relay intake paths.
- **Rate and quota tracking**: Decoupled monotonic rolling rate limits (`quota_usage` table) from dynamic decrementing recipient inbox depth bounds.
- **Delivery outcome routing**: Routed `processed` target states through dedicated `/v1/deliveries/:id/processing` handlers.
- **Audit query endpoint**: Updated `GET /v1/audit` to restrict log access strictly to active conversation participants.

### Security
- Resolved XSS surface in WebAuthn approval rendering via `safeJsonForScript()`.
- Prevented credential enumeration oracles on assertion endpoints by validating challenge tokens before credential lookups.
- Enforced strict origin matching for browser ceremonies, permitting `http://localhost` in development while requiring `https://` for remote hosts.

## [0.1.1] - 2026-08-15

### Fixed
- Applied corrective patches to relay receipt dispatching and connection lifecycle handlers.
- Synchronized unit tests with live PostgreSQL container test fixtures.

## [0.1.0] - 2026-08-10

### Added
- Initial release of Sigil governed relay, client SDK, and CLI tools.
