# Sigil CLI — status and roadmap

## What exists (2026-08-23)

A packaged CLI (`@sorensencc/sigil`, `bin/sigil.mjs`), installable via
`npm install --global github:sorensencc-dotcom/sigil` — no local checkout
required. Core commands:

- `sigil init <name> --owner <owner_id>` — generates an Ed25519 keypair +
  relay/connector tokens, saves them to `.sigil/<name>.identity.json`, and
  registers the public identity in `.sigil/registry.json`.
- `sigil relay up --registry <path> --port <n>` — runs `relay/v1/http-server.mjs`
  in the foreground. Supports both the in-memory store
  (`sigil/cli/memory-repository.mjs`) and the PostgreSQL-backed repository
  (`relay/v1/postgres-repository.mjs`) for restart durability.
- `sigil send --identity <path> --relay-url <url> --to <endpoint_id> --to-owner <owner_id> --message "text"` —
  builds, signs, and posts a `chat.message` envelope.
- `sigil inbox --identity <path> --relay-url <url> [--watch|--wait] [--loop]` —
  polls or listens (WebSocket notify-on-delivery) for inbox messages,
  prints them, and acknowledges delivery. `--wait` consumes one message and
  exits; `--wait --loop` re-arms after timeouts. Exit codes: 2 timeout, 3
  auth failure, 4 connection failure, 5 malformed delivery.
- `sigil agent run` — autonomous background daemon: listens, executes
  incoming tasks, signs and returns results without a human in the loop.
- `GET /approve` — interactive WebAuthn passkey browser ceremony for
  human-approval-gated capabilities, with loopback connector handoff.

Full v1 protocol conformance implemented and verified: JCS (RFC 8785)
canonicalization, task request/result schemas, replay detection,
capability authorization (fail-closed registry + row-level locking),
rejection audits + `GET /v1/audit`, rate/depth limits, delivery receipts +
heartbeats, identity-collision constraints +
`POST /v1/endpoint-acknowledgements`. See
`docs/specs/sigil-v1-conformance-gap-closure-design.md` for the full
build record (all 8 workstreams closed, no open items).

CI: GitHub Actions matrix (Node 22.x/24.x, Ubuntu/Windows, live PostgreSQL
16 service container). 366 tests passing (336 unit/contract + 30 live DB).

Endpoint directory/trust also now implemented per
`docs/specs/sigil-endpoint-directory-trust-spec-v1.0.md`: invite
create/redeem and OIDC-match create/claim/nominate flows, actor-bound
confirmation, unilateral revocation, active-link lookup, a same-owner
exemption on the accept-envelope gate (both sides resolved from the
trusted registry, not unverified envelope fields), dedicated
invite/match rate-limit scopes, and end-to-end integration coverage
(invite → confirm → deliver → revoke). The `attemptDirectoryMatchOnOidcLogin`
claim hook is wired to two login routes: `POST /v1/auth/mock-login`
(per `docs/superpowers/specs/2026-08-22-sigil-mock-oidc-login.md`), gated
behind `--enable-mock-oidc` / `SIGIL_ENABLE_MOCK_OIDC=1`, fixture-signed,
local dev/CI only; and `POST /v1/auth/login`, a real IdP integration —
live OIDC discovery, JWKS-over-HTTPS fetch, and RS256/ES256 ID-token
verification — per `docs/superpowers/specs/2026-08-23-sigil-real-oidc-login.md`.

A `VaultIsolationLayer` connector helper (`sigil/connectors/v1/vault-isolation-layer.mjs`,
exported as `@sorensencc/sigil/vault-isolation`) confines connector
filesystem access to a configured root: path containment, null-byte,
symlink, and URL-decode checks before delegating to fs read/write/
stream/list/unlink/stat.

## What this is not

- **First-contact trust is now wired to real IdPs.** `POST /v1/auth/login`
  verifies real ID tokens (RS256/ES256) against a live, JWKS-backed IdP
  keyset, validated against a per-issuer `client_id`
  (`oidc_issuer_allowlist.client_id`). `POST /v1/auth/mock-login` remains for
  local dev/CI only. See
  `docs/superpowers/specs/2026-08-23-sigil-real-oidc-login.md`.
- **Provisioning a real issuer is now a single command.**
  `sigil oidc-issuer add <issuer> --client-id <id> [--label text]
  [--assurance level] --database-url <url>` writes the Postgres
  `oidc_issuer_allowlist` row (via a new `upsertOidcIssuerAllowlist`
  repository method, distinct from the mock-only `upsertMockOidcIssuerAllowlist`,
  which never sets `client_id`). `sigil relay up` now loads
  `oidcIssuerAllowList` (the in-memory `Set` `createRelayServer` uses for
  the `/v1/directory/matches` family) from that same table at startup via
  `repository.listOidcIssuerAllowlist()`, instead of always starting with
  an empty, hand-wired `Set` as it did before. `POST /v1/auth/login` still
  reads the Postgres table directly and never consults the `Set`, but
  since the `Set` is now *derived from* the table rather than a second
  hand-maintained registry, there is only one write path left. A relay
  restart is required to pick up a newly added issuer (no live reload).
- **Not centrally hosted.** `sigil relay up` runs on whatever host you
  start it on. The PostgreSQL repository gives restart durability, but
  nobody operates a shared, reachable, TLS-terminated instance of it —
  every pair of agents currently needs its own relay.
- **Not integrated into any chat UI.** Sending a message does not make it
  appear inside a live Claude or Codex conversation turn. Host adapters
  background `sigil inbox --wait` and act on the host's own
  task-completion convention; that's a per-host convention Sigil doesn't
  control, not a protocol guarantee.

## What a real "message Claude ↔ Codex, works for other people" product needs

1. ~~**Packaging**~~ — done. `npm install --global github:sorensencc-dotcom/sigil`.
2. **A relay someone actually hosts** — the PostgreSQL repository exists;
   nobody has deployed a shared, reachable instance with TLS/backups/uptime.
   Still open.
3. ~~**Real identity/directory**~~ — done. Invite-code first-contact
   trust is fully built and wired end-to-end (create, redeem, confirm,
   revoke, active-link gate on message delivery). OIDC-match first-contact
   trust is implemented, tested, and wired to both `POST /v1/auth/mock-login`
   (fixture-signed, dev/CI-gated) and `POST /v1/auth/login` (a real IdP
   integration — live OIDC discovery, JWKS-over-HTTPS fetch, RS256/ES256
   verification).
4. ~~**Push, not poll**~~ — done. WebSocket delivery-notify stream backs
   `sigil inbox --wait`; `sigil agent run` daemonizes it further.
5. **Actual chat-surface integration** — still the hard, unbuilt part.
   Getting a Sigil message to appear as a turn inside a live Claude or
   Codex conversation requires each host product to expose an extension
   point Sigil can write into. Neither product currently has that hook (as
   far as any session here has found). Until it exists, the ceiling stays:
   a person runs `sigil inbox --watch`/`agent run` and the message surfaces
   via whatever host-specific convention (hook, MCP tool call) that host
   supports — never a native inline turn.

## Immediate next candidates (not started)

- Decide whether a shared hosted relay (item 2) is in scope at all, or
  whether Sigil stays self-hosted-per-pair by design; if in scope, spec
  deployment/ops (TLS, backups, uptime) this repo doesn't address yet.
- Chat-surface integration (item 5) is blocked on host products exposing
  a hook; track but don't spec until one does.
