# Sigil CLI — status and roadmap

## What exists (2026-08-24)

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
- **Provisioning a real issuer is now a single command, with list/remove
  and live reload.** `sigil oidc-issuer add <issuer> --client-id <id>
  [--label text] [--assurance level] --database-url <url>` writes the
  Postgres `oidc_issuer_allowlist` row (via `upsertOidcIssuerAllowlist`,
  distinct from the mock-only `upsertMockOidcIssuerAllowlist`, which never
  sets `client_id`). `sigil oidc-issuer list [--database-url url]` prints
  issuer/client_id/enabled/assurance_level per row (add
  `includeDisabled: true` to see soft-disabled entries too).
  `sigil oidc-issuer remove <issuer> [--database-url url]` soft-disables
  via `disableOidcIssuerAllowlist` (sets `enabled = FALSE`; re-adding goes
  back through `oidc-issuer add`'s upsert — no hard delete). `sigil relay
  up` loads `oidcIssuerAllowList` (the in-memory `Set` `createRelayServer`
  uses for the `/v1/directory/matches` family) from that same table at
  startup via `repository.listOidcIssuerAllowlist()`, and — when
  `--database-url` is set — now polls it on an interval (default 30s,
  `--oidc-issuer-refresh-interval-ms` to override) and mutates the Set's
  contents in place, so a newly added or removed issuer is picked up
  without a relay restart. A DB hiccup during a poll logs and keeps the
  last-known Set rather than clearing it. `POST /v1/auth/login` still
  reads the Postgres table directly and never consults the `Set`, but
  since the `Set` is now *derived from* the table rather than a second
  hand-maintained registry, there is only one write path left. Landed in
  `0618282` (feat) + `5617c39` (test fixture fix, deferred 500/503
  leak-guard coverage).
- ~~**Federated addressing: sub-project #1 (addressing)**~~ — done, landed
  2026-08-25. `sigil init <name> --owner <owner_id> [--domain <domain>]`
  and `sigil relay up [--domain <domain>]` now accept an optional `--domain`
  flag to enable federation support, making `endpoint_id` and `owner_id`
  optionally domain-qualified (e.g., `endpoint@domain.com`). A
  domain-configured relay enforces domain boundaries: rejects incoming
  messages with foreign-domain recipients (code `RECIPIENT_NOT_LOCAL`) and
  rejects malformed federated IDs (code `MALFORMED_FEDERATED_ID`) at
  envelope accept time. Per
  `docs/superpowers/specs/2026-08-24-sigil-federated-addressing.md`,
  sub-project #2 (inter-relay trust/discovery) is built end-to-end: the
  discovery consumer (`sigil peer resolve`, TOFU pinning) and the
  publisher (`sigil relay well-known generate`, which emits this relay's
  `.well-known/sigil` document from a designated endpoint identity).
  Sub-projects #3 (routing), #4 (cross-federation directory), and #5
  (operational tooling) remain unbuilt and unspec'd.
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

## Future direction: H2H / A2H / multi-agent group chats (not started, not spec'd)

Sigil today is pairwise (agent↔agent or agent↔human, one relay per pair).
Group chat — several humans and agents in one thread — is an unbuilt
protocol expansion. Raised 2026-08-24 by analogy to the
[Slack CLI](https://docs.slack.dev/tools/slack-cli/guides/running-slack-cli-commands)
command surface, which solves a structurally similar problem (many bots,
many event sources, one workspace) in a centralized SaaS. The primitives
below are candidate adaptations into Sigil's cryptographic, mailbox-based
model — none designed or scoped yet, listed here so they aren't lost:

- **`sigil trigger` (create/list/delete)** — explicit, signed subscription
  contracts instead of unconstrained listening, to stop group threads
  from causing agent reply-loops/token exhaustion. Static (@mention,
  keyword regex, direct DM), reaction/emoji (human reaction → signed
  approval envelope), and dynamic (agent subscribes to a thread,
  auto-unsubscribes when its task resolves).
- **`sigil dev` / `sigil run`** — local-first debugging: an authenticated
  outbound WebSocket from a local agent runtime to the relay, so testing
  doesn't need a public webhook or deployed relay. Plus a mock-event
  injector (`sigil emit --mock-chat`) to simulate multi-agent cascades
  offline. Distinct from the existing `sigil relay up` (which *is* the
  relay); this would be a client-side dev harness against a relay.
  Naming would need to avoid colliding with `sigil agent run`, which
  already exists as the production daemon.
- **`sigil trace` / `sigil activity`** — live terminal stream of envelope
  lineage in a group thread: JCS canonicalization/signature verification
  status, parent→child delegation chains, per-turn cost accounting (ties
  to the separate Cost Enforcement design doc), and step-up approval gate
  state (pending/approved/rejected).
- **`sigil manifest [validate]`** — declarative agent identity as a
  version-controlled file: key references, display handle/avatar,
  explicit capability grants (`chat:read_channel`, `chat:write_thread`,
  `task:delegate`, `memory:write`), and context boundaries (which
  channels/threads/memory namespaces an agent may touch). Would formalize
  what's currently spread across identity JSON + ad hoc capability checks.
- ~~**`sigil doctor`**~~ — done, landed 2026-08-24. `sigil doctor
  [--identity path] [--relay-url url]` runs the JCS conformance and
  dependency audits (now pure `runJcsAudit`/`runDepAudit` functions in
  `jcs-audit-lib.mjs`/`dep-audit-lib.mjs`, shared with the standalone
  `sigil-jcs-audit.mjs`/`sigil-dep-audit.mjs` pre-commit/CI scripts, which
  are now thin CLI-printing shells over the same logic), plus an Ed25519
  keypair sign/verify round-trip check when `--identity` is given, and a
  relay connectivity/latency check against a new unauthenticated `GET
  /v1/health` route when `--relay-url` is given. No SQLite or WebAuthn
  checks -- this repo uses Postgres/in-memory, not SQLite, and WebAuthn
  needs a real browser ceremony, not something scriptable.
- **`sigil delegate`** — manage authorized human delegates / co-operator
  keys (relevant once approval gates and group membership aren't 1:1).

None of this is scoped against Sigil's actual envelope/capability model
yet (e.g. how `sigil trigger` subscriptions interact with the existing
fail-closed capability registry, or whether group membership is a new
registry table or reuses the endpoint-directory-trust design). Treat as
raw material for a future spec pass, not a committed plan.

## Other future candidates: task-delegation hardening (not started, not spec'd)

Raised 2026-08-24 alongside the group-chat ideas above, worth keeping
even though they arrived bundled with claims about files/gaps that don't
exist in this repo (verified against `git log` + a repo-wide search —
no `whichllm`/`bfcl` files, no `watch-competitors`, no
`trm-worker-server`, no `gated-climb-repair` here; mock-OIDC login and
CLI `bin` packaging are already done, see above). The underlying ideas
are independent of those false claims and are plausible extensions of
Sigil's existing `sigil agent run` task request/result flow:

- **Adversarial cross-audit on task failure** — when a delegated task's
  execution fails, route the failure trace through an isolated "auditor"
  persona/agent for a remediation recipe before the executing agent
  regenerates and retries, instead of blind retry. Would sit inside the
  existing task request/result envelope flow, not a new subsystem.
- **Parallel delegation / merge-queue coordination** — for delegators
  fanning a task out to multiple agents concurrently (parallel worktree
  branches or equivalent), a serial merge-queue coordinator to reconcile
  results deterministically instead of racing writes.
- **Cost/quality-adjusted task routing** — a real design doc for this
  exists (linked by the user as "Cost Enforcement Design", not yet
  reviewed against this repo). Candidate shape: an operational-accounting
  table for cost/latency per task, then a shadow-mode warning phase
  (log violations of signed quality-floors/deadlines/resource limits in
  task metadata without blocking) before any hard admission gate. Ties
  into the `sigil trace`/`activity` cost-accounting field noted above.

None of these are scoped against Sigil's actual task/capability schema.
Before doing anything with the cost-routing item specifically, read the
linked Cost Enforcement Design doc and confirm it's actually about this
repo's protocol before building against it.
