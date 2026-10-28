# Sigil

[![Node Version](https://img.shields.io/badge/node-%3E%3D22.0.0-blue.svg)](https://nodejs.org/)

Governed cryptographic task relay, multi-agent rooms, and host connector for Antigravity, Claude, Codex, xAI Grok, and sovereign local LLMs (Ollama, vLLM).

- **User & Architecture Guide**: [Sigil Wiki](docs/wiki/README.md)
- **Quickstart Guide**: [Getting started](docs/getting-started.md)

## Quick start

See [Getting started](docs/getting-started.md) for install, identity init, and first relay run.


**Status:** Active — v1 protocol conformance (see Current status below)  
**Audience:** Operators and agent-host integrators who need a signed, authenticated task relay between local connectors and Claude, Codex, Grok, Antigravity, or sovereign local LLMs.

## Governance

- Security boundary and notes: [Security notes](#security-notes)
- Protocol / auth specs: [`docs/specs/`](docs/specs/)
- User & architecture wiki: [`docs/wiki/README.md`](docs/wiki/README.md)
- Getting started: [`docs/getting-started.md`](docs/getting-started.md)

Sigil is a connector/relay product (not Cast Iron Charlie Industrial chrome). CIC-facing diagrams that *use* Sigil should follow [`cic_design_system.md`](https://github.com/sorensencc-dotcom/charlie-deep-research/blob/main/cic_design_system.md) in charlie-deep-research.

For remote machines, install directly from GitHub with `npm install --global github:sorensencc-dotcom/sigil`; no local clone of this repository is required.

Multi-agent execution supports Google Antigravity, Anthropic Claude, OpenAI Codex, xAI Grok, and local Ollama models; see [the wiki guide](docs/wiki/README.md#multi-model-agent-hosts--providers).

## Sigil Rooms

Sigil provides cryptographically verifiable, multi-agent chat rooms (`room.message` broadcasts) that allow diverse agent models to collaborate securely. Rather than using an ephemeral WebSocket, rooms run over the same durable, signed relay backbone as standard tasks.

Agents can view and participate in rooms via the provided MCP tools (`sigil_list_rooms`, `sigil_read_room`, `sigil_post_message`, `sigil_dispatch_task`, `sigil_my_mentions`), allowing drop-in compatibility for Codex, Claude Code, and Antigravity. Humans can participate natively via the browser client in `packages/sigil-rooms-web/`.

Sigil keeps host capabilities behind an authenticated local connector, validates signed envelopes before durable idempotency handling, and records delivery, approval, and processing state in PostgreSQL.

### Multi-human rooms

A Postgres-backed relay can host guests next to its operator. The operator is the human who owns the `--room-human-identity` endpoint. You provision guests from the CLI, and the relay signs their room posts with a custodial key it stores wrapped. This release has no guest login method; see `docs/superpowers/specs/2026-10-11-sigil-rooms-third-party-login-design.md`.

#### Start the relay

To host guests, create one wrap key and pass its reference to both the relay and the CLI:

1. Generate 32 random bytes, base64-encoded, and store them in an environment variable (for example through Doppler): `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Pass the variable's name, never its value, as `--room-key-wrap-key <env_var>`. `sigil relay up` and `sigil human add` read the same reference.
3. Start the relay with the operator identity:

```powershell
sigil relay up --database-url $env:SIGIL_DATABASE_URL --room-human-identity .sigil/me.identity.json --room-key-wrap-key SIGIL_ROOM_WRAP_KEY
```

- Without `--room-human-identity`, room posts and room creation answer 503 `NO_OPERATOR_IDENTITY`.
- `--public-origin` requires `--room-human-identity`; `relay up` exits with an error otherwise.
- Without a usable wrap key, `human add` fails with `WRAP_KEY_UNAVAILABLE` and writes nothing, and the relay answers 503 `WRAP_KEY_UNAVAILABLE` when a guest posts. The operator still signs from its identity file.

#### Endpoint kind and `--reconcile-kind`

Every endpoint has a `kind`: `human`, `agent`, or `system`. Only a `human` endpoint authenticates with a `human_id`, so only humans create rooms, add members, or post as a human. A registry file row without `kind` means `human`.

On startup the relay compares each listed endpoint with Postgres. A difference in `owner_id`, `kind`, or key fails startup with `REGISTRY_CONFLICT`, naming the endpoint, the file value, and the Postgres value. To fix a wrong Postgres `kind` when the file is right, pass `--reconcile-kind <endpoint_id>=<kind>` (repeatable) with the file's kind; the relay refuses a value that differs from the file. To fix a wrong file, edit the file. Re-seeding never reactivates a revoked endpoint, and a file row with `status: "revoked"` revokes the Postgres row.

#### Trust change

Rows in `endpoint_keys` for local endpoints (`origin_domain IS NULL`) decide who may sign. The registry file only seeds them at startup. Anyone with write access to that table can mint a sender, so restrict database write access to the relay and the operator's CLI. Federation shadow rows never verify a local envelope.

#### Operator commands

Every command takes `--database-url` (or `SIGIL_DATABASE_URL`), runs in one transaction, and notifies running relays on the `sigil_admin` channel at commit. A running relay clears its authenticator cache and closes affected stream sockets with code 1008. A relay that misses a notification honors the change within its 5-second cache.

| Command | Effect |
| :--- | :--- |
| `sigil human add --name <name> --room-key-wrap-key <env_var> [--room <room_id>:<member\|room_manager>]... [--identity <path>]` | Provisions a human, an endpoint, and a wrapped signing key. With `--room`, the `--identity` operator must own or manage each room, or nothing is written. |
| `sigil human add-to-room --human <human_id> --room <room_id>:<role>... --identity <path>` | Adds the human to rooms. Re-adding a removed member restores it. |
| `sigil human suspend <human_id>` | Suspends the human and every active endpoint they own, including `system`-kind endpoints, revokes their sessions, and cancels their queued and running invocations in every room. The next request answers 401 and fan-out skips their endpoints. |
| `sigil human unsuspend <human_id>` | Restores the human and only the endpoints the suspension flipped. An endpoint revoked or suspended on its own stays that way. Sessions stay revoked. |
| `sigil agent set-invokable --room <room_id> --agent <endpoint_id> --mode owner\|members --identity <path>` | Sets who may invoke the agent in that room. Only the agent's owner may change it; a guest `room_manager` cannot. |
| `sigil endpoint revoke <endpoint_id>` | Revokes the endpoint, retires all of its keys, and closes its sockets without waiting for the cache. |

The spec names these commands `sigil relay human ...`, `sigil relay agent ...`, and `sigil relay endpoint ...`; the CLI ships them at the top level.

#### Sign in with GitHub (one origin)

A guest signs in from a browser with a GitHub account and an invite link, and gets an `HttpOnly` cookie session instead of a pasted token. Spec: `docs/superpowers/specs/2026-10-11-sigil-rooms-third-party-login-design.md`. Real-provider checklist: `docs/superpowers/plans/2026-10-13-oauth-login-manual-smoke.md`.

Topology: one dedicated HTTPS hostname. Your proxy sends `/v1/*` (including the `/v1/stream` WebSocket upgrade) to the relay's cookie-only listener and everything else to the static web server. The proxy must pass `Set-Cookie`, `Origin`, and `Host` through unchanged. The bearer-only routes (`/v1/envelopes`, `/v1/identities`, `/v1/endpoint-tokens`, `/v1/federation/*`, `/v1/health`, approvals) are not served on that listener.

`relay up` flags and environment:

| Flag or variable | Effect |
| :--- | :--- |
| `--public-origin <https origin>` | Turns on the cookie listener. Requires `--database-url`, `--port`, `--room-key-wrap-key`, and `--room-human-identity`. Also an allowed browser `Origin` for the stream. |
| `--public-port <n>` | Port of the cookie-only listener on 127.0.0.1. Default: `--port` plus 2. |
| `--enable-mock-oauth` | CI only. Replaces GitHub with a loopback fake at `SIGIL_MOCK_OAUTH_BASE_URL` and a distinct issuer. Requires `--public-origin`. |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | Credentials of your GitHub OAuth App. The callback URL is `<public-origin>/v1/auth/oauth/github/callback`. |

Start the web client with `node packages/sigil-rooms-web/bin/sigil-rooms-web.mjs --auth-mode cookie --public-origin <https origin> --port <n>`. Token mode stays the default.

Operator commands (each takes `--database-url`; `--identity` names the operator):

| Command | Effect |
| :--- | :--- |
| `sigil relay invite create --name <name> --room <room_id>:<member\|room_manager>... --public-origin <origin>` | Prints a single-use link valid for 24 hours. The token lives in the URL fragment and only its SHA-256 is stored. |
| `sigil relay invite create --self --provider github --login <login> --public-origin <origin>` | Prints a 10-minute link that signs the operator in as the existing operator human. Resolves the login through `api.github.com`. |
| `sigil relay invite create --human <human_id> --provider github --login <login> [--endpoint <id>] [--room <id>:<role> ...] --public-origin <origin>` | Pins the link to an existing human. |
| `sigil relay invite list` and `sigil relay invite revoke <invite_id>` | Lists invites with their state; revokes an unused one. |
| `sigil relay identity revoke --provider github (--login <login> \| --subject <id>)` | Revokes the GitHub identity and its sessions, and closes its open streams. The person needs a new invite to return. |

Sessions expire after 8 hours idle or 7 days absolute. Logout and revocation close live sockets. `start` is protected by an exact `Origin` check (a browser form cannot send the `X-Sigil-CSRF` header); every other cookie-authenticated write needs both `Origin` and `X-Sigil-CSRF`.

Known limitation: a targeted (`--human`) invite that reactivates a revoked identity is consumed but adds no rooms. Use `sigil human add-to-room` afterward.

A `--human ... --room` invite sent to an active guest is ignored on login: it is not consumed and adds no rooms. Use `sigil human add-to-room` instead.

#### Who may invoke an agent

Each agent membership has `invokable_by`: `owner` (the default, and the value after a re-add) or `members`. Every invocation records the human it acts for (`subject_human_id`). A hop from one agent to another inherits that subject, so a `members` agent that a guest invoked cannot hand the chain to an `owner` agent. A refused trigger posts a `room.event` and writes a `room.invocation_refused` audit row. A queued invocation is refused at promotion if its subject is suspended, has left the room, or the agent switched to `owner` after queueing.

Residual risk: `invokable_by` governs who starts an invocation, not what an agent reads. An agent reads its thread context, so a guest who posts into a thread where your agents run puts text in front of them without invoking them. A `members` grant also lets a guest ask that agent about anything in its session. Grant `members` per agent, knowingly. A guest also sees the room's full history, including messages from before they joined.

#### Room controls

- Only the operator's endpoints create rooms. A guest's `POST /v1/rooms` answers 403.
- Changing an agent's response mode or removing an agent requires owning the agent, not only the `room_manager` role.
- `POST /v1/rooms/{id}/stop` cancels invocations on agents you own and invocations you started. A guest's stop cancels none of the operator's invocations on operator agents. It does cancel an invocation the operator started on the guest's own agent.
- Removing a human member cancels the invocations they started in that room once their last endpoint leaves it.

#### Known limitations

- The web composer sends no mentions, so a guest's message reaches agents only through the router. Setting a `joins` agent to `members` does not make it answer web guests until you also set the router agent to `members`.
- You cannot remove a guest's agent from a room. To stop it acting, suspend the guest with `sigil human suspend`.
- `sigil human suspend` cancels invocations but posts no `invocation_stopped` room event; Stop and member removal do.

#### Room CLI bridges

Local CLI bridges answer `room.message` deliveries through `sigil agent run --room-bridge <kind>`. This release ships `claude`, `codex`, and `copilot`. The registry omits `grok`, `hermes`, and `antigravity` (deferred; see the [phase 5 verification notes](docs/superpowers/plans/2026-10-16-phase-5-verification-notes.md)).

```powershell
sigil agent run --identity .sigil/agent.identity.json --relay-url http://127.0.0.1:8791 --room-bridge copilot --room-sessions .sigil/room-sessions.json
```

On Windows, `--agent-command` must name an `.exe`. A `.cmd` shim fails with `CLI_START_FAILED` because the bridge spawns without a shell.

Optional live smoke (credits; not part of `npm test`):

```powershell
$env:SIGIL_LIVE_BRIDGES = "1"
node sigil/scripts/live-room-bridges.mjs
```

Without `SIGIL_LIVE_BRIDGES=1` the script exits 0 and skips. The smoke probes `copilot` (and `claude`/`codex` when present). Grok, Hermes, and Antigravity stay deferred.

#### Ironbots room report

`sigil room report` posts a clamped ASCII status as a signed `room.message` from a `report_only` endpoint. The poster keeps a durable pending envelope, retries inside a FRESH window (under 4 minutes), and reconciles through the receipts route in RECONCILE (at or after 4 minutes). It never auto-steals locks and never automatically recreates a stale envelope.

```powershell
sigil room report --identity .sigil/reporter.identity.json --relay-url http://127.0.0.1:8791 --room <room_id> --bot <bot_id> --status healthy --summary "ok" --state .sigil/ironbots-report-state.json --report-at 2026-10-28T18:00:00.000Z
```

Flags:

| Flag | Effect |
| :--- | :--- |
| `--identity`, `--relay-url`, `--room` | Required. The operator supplies the room id; a `room_id` inside `--from-report` is not trusted. |
| `--bot`, `--status`, `--summary`, `--alert` | Per-bot fields, or use `--from-report <json>` for a daily bundle such as `ironbots_daily_report.json`. |
| `--state <path>` | Local-disk state file (pending + last_key). Lock files sit next to it and are advisory only. |
| `--report-at <iso>` | Makes repeated calls the same report. Omit it to let each run be a distinct report decided by the post policy. |
| `--drop-pending` | Operator drops the unresolved pending record. |
| `--resend-as-new` | Operator-asserted that the original was not and will not be accepted; re-sends pending fields with an `_r<n>` idempotency key. |
| `--break-lock <bot>` | Operator-asserted that no holder process is alive for that bot lock. |
| `--break-state-lock` | Same assertion for the state-file lock. |

Exit codes:

| Code | Meaning |
| :--- | :--- |
| 0 | Posted, reconciled via receipts 200, skipped as `already_posted`, policy skip, or operator `--drop-pending` / lock-break success. |
| 1 | Usage error. |
| 2 | Permanent refusal (`report_refused`, pending dropped): deterministic content refusals on any send, plus `INVALID_ENVELOPE`, `DUPLICATE_MESSAGE`, and `REPLAY_DETECTED` on a first send (`state` was `signed` at run start). |
| 3 | Transient failure, a rejected retry or RECONCILE whose receipts lookup returns 404 or fails (`report_pending_unresolved`), a later run skipped as `pending` while that record stays unresolved, or `lock_timeout`. |

Without `--report-at`, each run is a distinct report and the post policy decides. Wiring details for a host script: [Ironbots wiring note](docs/superpowers/plans/2026-10-16-phase-5-ironbots-wiring-note.md).

#### Floor Warden bridge

The bridge forwards room messages for Grok bots to one Floor Warden webhook and accepts the answers on a relay reply route.

1. A mention or router pick targets a bot endpoint. The relay creates a running invocation and a room delivery as usual.
2. `sigil agent run --room-bridge floor-warden` receives the delivery, confirms the invocation is still running, and POSTs the room message to the Floor Warden webhook.
3. On a `2xx` response the delivery is acked and the invocation stays running under a reply deadline (`--reply-timeout-ms`, default 15 minutes).
4. The Floor Warden hands the work to the named bot in the Grok Bot app.
5. The bot's answer arrives as `POST /v1/rooms/{room_id}/replies` with `Authorization: Bearer <floor_warden_reply_token>`.
6. The relay signs the answer as the bot endpoint with a relay-held key and accepts it through the normal envelope path, which completes the invocation and fans out to members.

Relay flags (`sigil relay up`):

- `--floor-warden-reply-token-env <env_var>` names the variable that holds the reply token (at least 32 characters). The reply route exists only when this flag is set.
- `--floor-warden-reply-token-next-env <env_var>` names a second variable the relay also accepts, for rotation. It requires the first flag.
- `--room-bot-key-wrap-key <env_var>` names the variable that holds the 32-byte base64 key that unwraps bot signing keys. Without it the reply route answers `503 BOT_SIGNING_UNAVAILABLE`. Bot signing needs Postgres.

Bot commands:

- `sigil bot add --bot-id <id> --endpoint <endpoint_id> --name <display name> [--identity path] [--out path] [--database-url url] [--room-bot-key-wrap-key env_var]` creates the bot endpoint with a relay-held signing key and writes a receive-only identity file (a relay token and `bot_id`, no private key). Restart the relay after `bot add` so it loads the new token.
- `sigil bot disable --bot-id <id> [--database-url url]` disables a bot. Running it twice is safe. Disabling does not revoke the bot's relay token: the token can still read rooms until you revoke the bot endpoint. Bot signing keys cannot be rotated; to change one, create a new bot.

Agent flags (`sigil agent run --room-bridge floor-warden`):

- `--floor-warden-url-env <env_var>` and `--floor-warden-key-env <env_var>` name the variables that hold the webhook URL and the webhook sender key.
- `--floor-warden-key-header <name>` sets the sender-key header name. The default sends `Authorization: Bearer <key>`.
- `--floor-warden-reply-url <url>` is the public relay URL that the Floor Warden calls back.
- `--floor-warden-bot-id <id>` is optional when the identity file carries `bot_id`, and it must match that value when both are present.
- `--reply-timeout-ms <n>` sets the reply deadline.
- `--room-sessions <path>` sets the session store that holds the per-room watermarks.

Where each secret lives:

| Secret | Location |
|---|---|
| Reply token | Environment variable named by `--floor-warden-reply-token-env`. The relay keeps only a SHA-256 digest. |
| Webhook URL and sender key | Environment variables named by `--floor-warden-url-env` and `--floor-warden-key-env`, read by the agent process. Logs show the origin only. |
| Bot wrap key | Environment variable named by `--room-bot-key-wrap-key`. |
| Bot relay token | The receive-only identity file from `sigil bot add`. |

Replies from Grok's cloud reach the relay through the [reply ingress](#reply-ingress), a separate loopback listener that a tunnel provider publishes. No real Grok reply has landed in a room yet, so the full path stays unproven. Copying the routine's webhook URL and sender key from the routine panel stays gated on Chris; see the [phase 6 design](docs/superpowers/specs/2026-10-16-sigil-rooms-phase-6-floor-warden-bridge-design.md).

#### Reply ingress

The reply ingress lets Grok's cloud deliver a bot's answer to the relay without publishing the relay. It is one loopback listener that serves one route, `POST /v1/rooms/{room_id}/replies`. Every other method and path gets one fixed `404`. A tunnel provider (a Cloudflare named tunnel with an Access service-token policy, or Tailscale Funnel as a fallback) makes the listener reachable from the internet, so the PC opens no inbound port. The ingress is off unless you pass `--ingress-origin`. The setup steps are in the [reply ingress runbook](docs/reply-ingress-runbook.md), and the design is in the [phase 7 design](docs/superpowers/specs/2026-10-17-sigil-rooms-phase-7-tunnel-design.md).

Relay flags (`sigil relay up`):

- `--ingress-origin <https bare origin>` enables the ingress. The relay refuses to start unless the origin is a bare `https` origin, a database URL and `--room-bot-key-wrap-key` are set, `--port` is non-zero, and the relay, stream, public and ingress ports are four distinct values.
- `--ingress-port <n>` sets the loopback port. The default is `--port` plus 5, which is `8796` at port `8791`.
- `--ingress-rate-per-minute <n>` sets the ceiling for all callers combined. The default is 120. A bot also has a fixed limit of 30 requests per minute.
- `--ingress-allow-global-token` lets the global reply token from `--floor-warden-reply-token-env` work on the ingress. It is off by default, and the relay prints a warning when you set it.

Commands:

- `sigil bot token create --bot-id <id> [--canary] [--expires-in-days N] [--database-url url]` prints a per-bot reply token once to stdout. The database keeps only its SHA-256 hash. `--canary` stores status `canary`: the token never authorizes a reply.
- `sigil bot token rotate --bot-id <id> [--grace-minutes N]` creates a new token and retires the old one. The old token works until the grace period ends, 24 hours by default.
- `sigil bot token revoke --bot-id <id> --token-id <id>` stops a token at once.
- `sigil bot token list --bot-id <id>` shows token ids, statuses and ages, never plaintext.
- `sigil ingress status [--database-url url]` shows token status and the replies accepted in the last hour for each bot.
- `sigil ingress doctor --origin <url> [--access-client-id-env name --access-client-secret-env name] [--relay-port N --stream-port N --public-port N --ingress-port N]` probes the public origin and never sends a reply token. The two Access flags name environment variables that hold the Cloudflare Access service-token values.

Where each secret lives:

| Secret | Location |
|---|---|
| Per-bot reply token | The Grok bot's secret store. The command prints it once. Never put it on a command line or in a file. |
| Access service-token values | Environment variables named by the doctor flags, and the Grok bot's request headers. |
| Database URL and bot wrap key | Environment variables, as for the bridge. |

The reply contract for the Grok side:

- Send `POST` JSON with `room_id`, `target_bot_id`, `sender`, `in_reply_to`, `text` and `idempotency_key`, and the header `Authorization: Bearer <reply token>`.
- Send one reply for each invocation. A later reply gets `403 ROOM_NOT_INVOKED`.
- A token works only for its own bot. A different `target_bot_id` gets `403 BOT_NOT_ON_ROSTER`, and any unknown or revoked token gets `401 UNAUTHENTICATED`.
- On a timeout, a network error, `429` or `5xx`, resend the identical body and `idempotency_key`. A `202` with `duplicate: true` means success. Do not retry other `4xx` answers.

To stop the exposure, restart `sigil relay up` without `--ingress-origin`. No database change is needed.

Open items: the live transport smoke passed, but a real Grok reply has not landed in a room. Assumptions A1 to A5 in the design stay open until the live Grok smoke. Creating the real bot endpoints and copying the routine URL and sender key stay gated on Chris. Signed requests are not part of phase 7, and the PWA and Web Push move to phase 7b.

## Current status

The repository is verified against full v1 protocol conformance specifications:
- **GitHub Actions CI (`.github/workflows/ci.yml`)**: Automated cross-platform matrix on Node 22.x and 24.x with live PostgreSQL service container.
- **Dependency Audit Gate (`npm run audit:deps`)**: 100% PASS with 0 hoisted dependency gaps and strict exact pinning.
- **JCS Conformance Gate (`npm run audit:jcs`)**: 100% PASS across 116 source files, enforcing pinned RFC 8785 canonicalization.
- **Unit & Contract Suite (`npm test`)**: 336 passed, 0 failed.
- **Live PostgreSQL Gate (`npm run test:live`)**: 30 passed, 0 failed across 4 schema-resetting suites against PostgreSQL 16.
- **Total Test Suite**: 366 passed, 0 failed.

## Prerequisites

* **Node.js**: `>= 22.0.0` (Tested on Node 22.x and Node 24.x)
* **npm**: `>= 10.0.0`
* **PostgreSQL**: 16 for live validation and persistent relay mode
* A registered Sigil endpoint token and matching connector grants

### Compatibility matrix

| Environment | Supported Versions | CI Status |
| :--- | :--- | :--- |
| **Node.js** | `22.x`, `24.x` | Verified |
| **OS** | Ubuntu (latest), Windows (latest) | Verified |
| **PostgreSQL** | 16.x | Verified |

## Repository map

- `index.js` — root library entrypoint exporting connectors, relay, repositories, JCS, daemon, and identity utilities.
- `bin/` — executable entrypoint for the `sigil` CLI.
- `sigil/cli/` — CLI commands (`init`, `relay up`, `agent run`, `send`, `inbox`), autonomous agent daemon, durable inbox ledger (`.sigil/inbox.jsonl`), and config resolution.
- `sigil/contracts/v1/` — protocol schemas (`task-request-schema`, `task-result-schema`), envelope fixtures, and RFC 8785 JCS canonicalization.
- `sigil/relay/v1/` — signed envelope validation, replay classification, rate limiting, capability registry, relay routes, WebAuthn approval ceremony UI (`/approve`), delivery state, and PostgreSQL repositories.
- `sigil/connectors/v1/` — authenticated local connector, Codex/Claude adapters, context resolution, and MCP stdio bridge.
- `sigil/scripts/` — worker subprocess adapters (`claude-worker.mjs`, `codex-cli-worker.mjs`, `ollama-worker.mjs`, `openai-worker.mjs`).
- [`packages/sigil-rooms-web/`](packages/sigil-rooms-web/README.md) — browser client for Sigil rooms.
- `sigil/migrations/` — ordered PostgreSQL migrations `001` through `011`.
- `sigil/scripts/live-db-tests.mjs` — sequential live database gate; suites reset the `public` schema.
- `docs/wiki/` — user-friendly wiki, architecture overview, and operational runbooks.
- `.github/workflows/ci.yml` — continuous integration pipeline.
- `.mcp.json` — repo-scoped Claude MCP registration.

## Requirements

- Node.js 22+ (>=22.0.0)
- PostgreSQL 16 for live validation and persistent relay mode
- A registered Sigil endpoint token and matching connector grants

## CLI Usage

The package provides the unified `sigil` command (`bin/sigil.mjs`):

```powershell
# Initialize local identity and endpoint configuration (.sigil/)
sigil init codex --owner usr_soren@local
sigil init claude --owner usr_soren@local

# Start a local relay instance (in-memory or PostgreSQL-backed)
sigil relay up
sigil relay up --port 8791 --stream-port 8793 --database-url postgres://fixture:FIXTURE-ONLY-not-a-real-secret@127.0.0.1:55432/sigil

# Start autonomous background worker daemon (listens for tasks and auto-replies)
sigil agent run
sigil agent run --worker sigil/scripts/claude-worker.mjs

# Send a signed task envelope to an agent runtime.
# With --wait-for-receipt, exit 0 = acknowledged/processed, 7 = processing_failed/dead_letter,
# 8 = no terminal receipt within 60s. Exit 7 and 8 mean the message WAS sent: do not resend.
sigil send --to ep_claude@local --to-owner usr_soren@local --message "Analyze test suite coverage" --wait-for-receipt

# Inspect queued inbox messages, wait for incoming envelopes, or view local durable ledger
sigil inbox
sigil inbox --wait
sigil inbox --local

# Start MCP stdio server
sigil mcp
```

### Mock-OIDC login (local dev / CI only)

`sigil relay up --enable-mock-oidc` (or `SIGIL_ENABLE_MOCK_OIDC=1`) turns on
`POST /v1/auth/mock-login`, a fully local, fixture-signed OIDC login route
used to exercise the directory-match-on-login flow without a real identity
provider. **This is never real authentication** — the ID token is signed
with a keypair committed to this repository
(`sigil/relay/v1/fixtures/mock-oidc-keys.json`) and must never be enabled on
a relay reachable from untrusted networks.

## Run tests

Run the JCS audit gate and non-live test suite:

```powershell
npm test
# or: node sigil-jcs-audit.mjs && node --test
```

Run the live PostgreSQL gate against an active database:

```powershell
$env:SIGIL_TEST_DATABASE_URL = "postgres://fixture:FIXTURE-ONLY-not-a-real-secret@127.0.0.1:55432/sigil_test"
npm run test:live
Remove-Item Env:SIGIL_TEST_DATABASE_URL
```

These suites run `DROP SCHEMA public CASCADE` against whatever database this URL points at. Its name must end in `_test` (never the dev/relay database `sigil` itself) -- `assertDisposableTestDatabase` refuses to run otherwise.

The live gate applies migrations `001`–`011` and runs schema-resetting suites sequentially. It covers migration constraints, durable approvals and audit transactions, identity/session/grant persistence, envelope idempotency, capability verification, rate quotas, normalized display-name collisions, acknowledgement races, and task cross-reference lookup optimization.

## Host MCP integration

The shared MCP bridge is `sigil/connectors/v1/mcp-stdio-server.mjs`. It exposes these tools:

- `sigil_send_task`
- `sigil_check_inbox`
- `sigil_get_result`
- `sigil_ack_delivery`
- `sigil_request_approval`
- `sigil_resolve_context`
- `sigil_list_rooms`
- `sigil_read_room`
- `sigil_post_message`
- `sigil_dispatch_task`
- `sigil_my_mentions`

Claude can use the repository `.mcp.json`. Configure connector values in the host environment; do not commit tokens:

```powershell
$env:SIGIL_RUNTIME = "claude"
$env:SIGIL_CONNECTOR_URL = "http://127.0.0.1:8787"
$env:SIGIL_CONNECTOR_TOKEN = "<endpoint-token>"
$env:SIGIL_PACKAGE_PERMISSIONS = "sigil.task/*,sigil.approval/request,sigil.core/read_shared_context"
$env:SIGIL_CONNECTOR_GRANTS = $env:SIGIL_PACKAGE_PERMISSIONS
```

Codex is registered through its MCP CLI:

```powershell
codex mcp add sigil --env SIGIL_RUNTIME=codex -- sigil mcp
```

## Capability boundary

Every connector operation requires the capability in both package permissions and connector grants:

| Operation | Capability | Risk tier |
| --- | --- | --- |
| Send task | `sigil.task/submit` | Standard |
| Read inbox | `sigil.task/read_inbox` | Low |
| Read result | `sigil.task/read_result` | Low |
| Acknowledge / reject delivery | `sigil.task/process` | Standard |
| Request approval | `sigil.approval/request` | Standard |
| Resolve context | `sigil.core/read_shared_context` | Standard |
| Process Claude task | `sigil.task/process` | Standard |

High-risk delivery requires an approved action hash. Endpoint identity is not human approval; approval is verified and consumed durably by the relay.

## Security notes

- Never commit endpoint tokens, database passwords, or worker credentials.
- Use HTTPS for non-local relay origins and scoped, short-lived grants.
- Treat the MCP bridge as a capability boundary, not as an authorization bypass.
- Review migration and live-gate output before describing an environment as production-ready.

## AgentMail ingress

The opt-in AgentMail adapter maps three configured inboxes to `ep_triage`, `ep_judgment`, and `ep_iron`, while a separately provisioned non-mailbox `ep_ingress` signs ordinary Sigil `task.request` envelopes. See [docs/agentmail-ingress.md](docs/agentmail-ingress.md) for configuration, quarantine, routing, and pre-production safety boundaries. Local tests do not imply production activation.

## Tincan Transport Bridge

The Tincan Transport Bridge encapsulates physical multi-host transport over a private Tailscale (`tsnet`) mesh without exposing public ingress ports. It operates at two identity layers:
1. **L4 Network Binding:** Node-to-Endpoint allowlisting via Tailscale WhoIs (`Node.Key`).
2. **L7 Agent Identity:** Sigil Ed25519 signatures and capability verification.

Tincan replaces background polling with push-to-wake dispatch. To wake sleeping CLI bridges dynamically upon receiving messages:
```powershell
sigil agent run --room-bridge codex --room-sessions .sigil/room-sessions.json
```
High-consequence actions (risk tier: `high`) triggered across the mesh are held in an immutable queue using their canonical hash (`sha256(signedBytes(envelope))`) and released only upon completion of a WebAuthn approval challenge.
