# Changelog

All notable changes to the Sigil governed task relay and connector are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Reply-token canaries.** `sigil bot token create --bot-id <id> --canary` plants an `fwr_` token with status `canary`. A canary never authorizes a reply: the ingress answers `401 UNAUTHENTICATED` with the same body as an unknown or revoked token, writes `ingress.canary_used` with `token_id` and `bot_id` only, and does not run the accept path. Migration `040_reply_token_canary.sql`. Closes #80.
- **Reply ingress for Floor Warden bots (phase 7, the tunnel).** `sigil relay up --ingress-origin <https bare origin>` starts a loopback listener (`--ingress-port`, default `--port` plus 5) that serves only `POST /v1/rooms/{room_id}/replies`, so a tunnel provider can publish one route to Grok's cloud. Limits fail closed: `--ingress-rate-per-minute` (default 120) for all callers and 30 per minute for each bot. The global reply token works on the ingress only with `--ingress-allow-global-token`. New commands: `sigil bot token create|rotate|revoke|list` for per-bot reply tokens (stored as SHA-256 hashes, printed once) and `sigil ingress status|doctor`. Migration `039_reply_ingress.sql`. Operator guide: README "Reply ingress" and `docs/reply-ingress-runbook.md`. The phase 7 PRs are #89, #91, #92, #93, #94, #95 and #96.
- **Reply ingress live transport smoke.** On 2026-10-20 a request path through a Cloudflare named tunnel and an Access service-token policy reached the ingress. The smoke's authenticated calls went through Cloudflare's edge from the operator PC, and the no-Access-header refusal case ran from a separate Linux host. A real Grok reply has not landed in a room yet. Notes: `docs/superpowers/plans/2026-10-17-reply-ingress-smoke-notes.md`.
- **Sign in with GitHub for browser guests.** `sigil relay up --public-origin <https origin>` adds a cookie-only listener (`--public-port`, default `--port` plus 2) with GitHub OAuth (`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`; `--enable-mock-oauth` for CI) behind one dedicated hostname. Operator commands: `sigil relay invite create|list|revoke` (guest links, `--self`, `--human`) and `sigil relay identity revoke`. The web client gained `--auth-mode cookie`. Sessions are `__Host-` cookies with idle and absolute expiry; logout and revocation close live sockets. Migration `034_oauth_login.sql`. Operator guide: README "Sign in with GitHub (one origin)"; real-provider checklist: `docs/superpowers/plans/2026-10-13-oauth-login-manual-smoke.md`.
- **Multi-human rooms foundation.** A Postgres-backed relay hosts guests next to its operator (the owner of the `--room-human-identity` endpoint). New CLI commands: `sigil human add` (relay-custodial signing key wrapped with AES-256-GCM under `--room-key-wrap-key <env_var>`), `sigil human add-to-room`, `sigil human suspend|unsuspend`, `sigil agent set-invokable`, and `sigil endpoint revoke`. Each command notifies running relays on the `sigil_admin` channel at commit; relays clear their 5-second authenticator cache and close affected stream sockets with 1008. Per-agent `invokable_by` (`owner` or `members`) decides who may start an invocation; every invocation records `subject_human_id`, hops inherit it, and refusals post a `room.event` and a `room.invocation_refused` audit row. Room rosters show endpoint display names, and the web roster lets an agent's owner set who may invoke it. Migration `033_multi_human_foundation.sql`. Operator guide: README "Multi-human rooms".
- `sigil relay up --reconcile-kind <endpoint_id>=<kind>` repairs a Postgres endpoint `kind` that differs from the registry file after a `REGISTRY_CONFLICT`.

### Changed
- `sigil agent run --room-bridge floor-warden` now refuses an `http` `--floor-warden-reply-url` unless the host is loopback (`127.0.0.1`, `localhost` or `[::1]`). Use an `https` URL for any other host.
- Browser WebSocket tickets issued through the cookie listener now carry the session id, so logout closes the stream. The cookie listener passes a `Date`, not a function, as `now` to room routes.
- Rows in `endpoint_keys` for local endpoints now decide who may sign; the registry file only seeds them at startup. Endpoints carry multiple keys (`active`, `retiring`, `retired`) selected by `key_id`, and a federated sender's new key retires its previous shadow key.
- Every endpoint row has a `kind` (`human`, `agent`, or `system`); only `human` endpoints authenticate with a `human_id`. Startup fails with `REGISTRY_CONFLICT` when the registry file and Postgres disagree on owner, kind, or key, and re-seeding never reactivates a revoked endpoint.
- `--public-origin` now requires `--room-human-identity`. Without an operator identity, room posts and room creation answer 503 `NO_OPERATOR_IDENTITY`.
- Only the operator's endpoints create rooms. Changing an agent's response mode, removing an agent, or changing who may invoke it requires owning the agent. `POST /v1/rooms/{id}/stop` cancels invocations on agents the caller owns plus invocations the caller started.
- Added `packages/sigil-rooms-web` (`@sorensencc/sigil-rooms-web`), a browser client for Sigil rooms with paste-token login, room list, timeline, send, ack, and live updates through `room.updated`. Start it with `node packages/sigil-rooms-web/bin/sigil-rooms-web.mjs`. Threads, Stop, and roster modes are phase 4b-2. Root `npm run test:web` runs its typecheck, tests, and build.
- Added `GET /v1/messages/{message_id}/receipts`, a sender-only read of every recipient's receipt state, so a sender can find out after disconnecting.
- `delivery.receipt` frames now carry `recipient_endpoint_id` and `mapped_state`. A room message sends one frame per recipient with that recipient's real delivery ID.
- On Postgres the accept-time frame now says `queued` and a `delivered` frame follows when the recipient polls. The frame previously said `delivered` immediately.
- Added libp2p transport driver (`sigil/relay/v1/transport-libp2p/`) as an
  opt-in peer-to-peer alternative to the HTTP/WebSocket relay transport,
  enabled via `sigil relay up --p2p` (`--p2p-identity`, `--p2p-listen`).
  Kademlia DHT discovery (`enableDht`) is wired but not yet functional —
  see STATUS.md and TODOS.md.
- **Federation sub-project #3 — inter-relay routing.** Opt-in `sigil relay up --federation-mode sync|queue --federation-identity <path>` forwards foreign-domain envelopes to TOFU-pinned peer relays over `POST /v1/federation/envelopes`, signed with the origin relay's `.well-known/sigil` key. `queue` mode persists to a new `federation_outbox` table drained by a 60s reaper (300s lease, `FOR UPDATE SKIP LOCKED` + `claim_token` guard). Receiver enforces mutual pinning, canonicalize-after-parse relay-signature verification, end-to-end sender-key verification, and a relay-signed `sender_owner_id` same-owner exemption; every accepted federated envelope is stored `federation_hop = true` (one hop, structural). New: `sigil init --federation-owner`, `sigil route test`, `sigil federation outbox list|show|retry`. Migration `017_federation_outbox.sql`.
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
