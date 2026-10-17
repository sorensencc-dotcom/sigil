# Sigil rooms phase 7: reply ingress tunnel design

Status: draft for review, 2026-10-17.
Parent spec: `docs/superpowers/specs/2026-10-02-sigil-rooms-design.md` ("Grok bots through the Floor Warden", "Reply route", delivery phase 7).
Builds on: the phase 6 Floor Warden bridge (`docs/superpowers/specs/2026-10-16-sigil-rooms-phase-6-floor-warden-bridge-design.md`, PR #59), phase 5 more bridges (`docs/superpowers/specs/2026-10-16-sigil-rooms-phase-5-more-bridges-design.md`), the third-party login design (`docs/superpowers/specs/2026-10-11-sigil-rooms-third-party-login-design.md`), and the hybrid rooms and direct messages design (`docs/superpowers/specs/2026-10-16-sigil-hybrid-rooms-direct-messages-design.md`).
Companion plan: `docs/superpowers/plans/2026-10-17-sigil-rooms-phase-7-tunnel.md`.

Labels used below. **V** means verified in the repo at `origin/main` b4e5812 (PR #65). **PUB** means public vendor documentation, with the URL given. Everything else is an assumption and is named as one.

## Goal

A person in a room can @mention Chief or Helix CI Triage and see the bot's answer in the thread, even though the bot runs in Grok's cloud. Today the answer cannot get back to Sigil. Phase 7 gives Grok's cloud one narrow, authenticated way to deliver that answer to the reply route.

In this design, "tunnel" means an outbound-initiated path that makes exactly one Sigil route reachable from Grok's cloud. It does not publish the relay.

Phase 7 does not do the following.

- It does not publish the relay, the stream listener, the cookie-only public listener, or any room route other than the reply route.
- It does not wake a local process, start a session, or carry direct messages.
- It does not add the PWA or Web Push. Those are phase 7b.
- It does not create the real bot endpoints or touch the Grok routine. Chris's go-ahead gates that step (see Rollout).

## The problem

Grok's cloud computers can make outbound HTTP and HTTPS requests with curl (PUB, https://docs.x.ai/grok-bot/security). They cannot reach `127.0.0.1` on Chris's Windows PC, which sits behind NAT. The parent spec says the same at line 147: a call from Grok's cloud "waits on the phase 7 tunnel, because Grok cannot reach localhost."

The repo facts that make the reply route unreachable today are all verified in the repo.

- **Loopback binds.** `sigil relay up` binds the relay on `127.0.0.1:<--port>`, the stream listener on `127.0.0.1:<--stream-port>` (default port plus 1), and the optional cookie-only public listener on `127.0.0.1:<--public-port>` (default port plus 2, only when `--public-origin` is set). Nothing binds `0.0.0.0`.
- **The 404 gate.** In `sigil/relay/v1/http-server.mjs` (lines 253-296), `POST /v1/rooms/{room_id}/replies` sits before the generic bearer gate. When `floorWardenReplies?.tokens` is absent, it answers `404 NOT_FOUND` as if the route did not exist.
- **The cookie-only listener.** `relay/v1/oauth/public-listener.mjs` matches `/v1/auth/*`, any `GET` or `POST` under `/v1/rooms/...`, and `GET /v1/mentions`. Every room route there runs behind `authenticateCookie` and a cookie CSRF check. A bearer-only `POST` to the reply path through that listener reaches the cookie gate and answers `401`. This is verified by reading the code. The plan proves it with a test.
- **The bridge accepts an http reply URL.** `sigil agent run --room-bridge floor-warden` accepts `http` or `https` for `--floor-warden-reply-url` and for the webhook URL. It builds `reply.url` as `<replyUrl>/v1/rooms/<room_id>/replies` (`bridges/v1/floor-warden-bridge.mjs`, line 322).
- **No pre-auth rate limit.** The repo has no limit on requests that fail the token check, no per-token limit, and no trusted-proxy handling. A search for `x-forwarded` and `trusted.proxy` finds nothing outside the tincan whois code. The accept path scopes bound accepted replies: `endpoint` (default 100 per minute), `owner` (500) and `conversation` (200). Nothing counts the `401` and `403` gate refusals.
- **One global token.** `loadReplyTokens` in `relay/v1/floor-warden-token.mjs` loads one token, plus an optional "next" token for rotation. Any holder can name any bot.
- **The effect.** The bridge forwards to Grok from the PC, because outbound works. The reply cannot return. The invocation ends in `REPLY_TIMEOUT` after 15 minutes (phase 6's starting value).

**Roadmap wording.** The parent spec's phase 7 is "Mobile. PWA, tunnel, and push." Chris's 2026-10-17 instruction is that phase 7 is "the tunnel". This design covers the tunnel only. The PWA and Web Push parts become phase 7b with their own design. Q1 asks Chris to confirm the split.

The third-party login design says a public-internet hardening spec must precede a public endpoint, and that a `--trusted-proxy` setting must exist before anything keys on `X-Forwarded-For`. This design is that spec for the reply ingress only. It never reads forwarded headers, so it needs no trusted-proxy setting.

## Scope

In scope:

- A dedicated loopback listener, the reply ingress, that serves one route.
- A shared gate module that the ingress and the existing main relay route both use.
- Per-bot reply credentials in Postgres, with `sigil bot token` commands.
- Layered limits that fail closed.
- `sigil ingress status` and `sigil ingress doctor`.
- A tightened https rule for the bridge reply URL.
- A provider runbook outline (no secrets) and a reply contract for the Grok side.
- Migration `039_reply_ingress.sql`, tests, and a staged rollout.

Out of scope, with the reason:

- **Phase 7b, PWA and Web Push.** They are separate work with a separate threat model. The web client needs no change for this phase.
- **Phase 8, the rooms MCP plugin.** The parent spec says Grok bot replies do not use it. This design does not pull it forward.
- **A signed request mode.** It needs Grok-side HMAC support, which is unverified. Q3 asks whether to build it later.
- **Direct messages and sessions over the ingress.** A cloud bot cannot hold a stream socket or heartbeat. See "Interaction with hybrid sessions and direct-message tiers".
- **Creating `ep_chief` and `ep_helix_ci`.** Chris declined endpoint setup in phase 6. Rollout stage 5 asks again.
- **Resolving the stream port drift.** See Failure modes.
- **Exporting metrics.** The counters stay in memory (see Observability).

## Threat model

**Assets.**

- The ability to post as Chief or Helix CI Triage into rooms.
- The relay itself.
- The bot signing keys, wrapped under `--room-bot-key-wrap-key`.
- Postgres.
- The Windows PC.

**Actors.**

- Internet scanners that find the public hostname.
- A holder of a leaked reply token.
- A prompt-injected Grok bot that leaks its own token. Room text is untrusted, and the token must live on the Grok side.
- A compromised or malicious room member who tries to steer the bot.
- The tunnel provider, which terminates TLS and can read and replay bodies.
- A confused deputy, where the ingress also exposes room routes. The one-route allowlist removes this case.

| Threat | Control | Residual risk |
|---|---|---|
| A scanner probes the hostname | Listener serves one route. Every other method and path gets one fixed `404`. No health route, CORS, WebSocket upgrade, `OPTIONS` or cookies. | The one route answers `401` to anyone, which proves it exists. |
| Request flood on the public hostname | Ingress-wide ceiling (120 per minute) answered `429` before any body read or database call. Provider WAF rate rule. | The ceiling is a shared bucket. A flood can deny service to the real caller. The edge rule is the real mitigation. |
| Token guessing | Tokens are 32 random bytes with prefix `fwr_`. Only SHA-256 hashes are stored. The lookup is by hash. | None worth naming at 256 bits of entropy. |
| Token leaked from the bot's context | Per-bot token bound to `bot_id`. Revoke and rotate commands. Retired tokens expire. | The holder can post one reply per running invocation of that bot with the right trigger id. A stolen token can post different text before the legitimate reply. |
| One bot's token used to speak as another bot | The handler requires `target_bot_id` to equal the token's `bot_id`, else `403 BOT_NOT_ON_ROSTER`. | None for this case. |
| Replay of a captured request | Existing step 7 idempotency returns the first result. Later replays hit `403 ROOM_NOT_INVOKED`. | A replay never writes twice. It can still cost one request. |
| A caller forges or replays a signed envelope | The ingress accepts no envelope. The route takes six plain string fields. The relay signs the `room.message` with the bot's relay-held key under the wrap key (existing phase 6 behavior), so Grok's cloud never holds an Ed25519 key and cannot mint a signature. | The reply credential is a bearer token, not a signature (see the signed request mode in Q3). |
| Room text steers the bot into a bad post | Steps 3 to 10 are unchanged. `in_reply_to` must equal the running trigger, `mentions` stay empty, and completion is single-shot. | The bot can still post wrong text in its own thread. |
| The provider reads or alters traffic | https end to end to the provider. The provider-to-listener hop is loopback inside the PC. | The provider sees tokens and bodies. This design trusts the provider with them. |
| Misconfiguration exposes more | Startup checks refuse to start. The ingress refuses the global token by default. `sigil ingress doctor` probes the public origin. | The operator can still point the provider at the wrong port. Doctor catches this. |
| Plain http reply URL | `sigil agent run` refuses an http reply URL unless the host is loopback. | A loopback http URL is allowed by design. |
| Ingress takes the relay down | Same-process listener, but only one route and a body cap of 96 KiB. | A bug in the shared gate affects both routes. The shared module has one test suite for both. |

**What this does not protect against.**

- A malicious or compromised tunnel provider.
- A token that leaves through the bot's own output. The token is a bearer credential, not a signature.
- A flood large enough to exhaust the provider's or the PC's bandwidth. The local ceiling cannot help with bytes the edge already accepted.
- Grok-side behavior that this design cannot see, such as whether the bot retries (assumption A3).
- A compromised PC. The relay, the wrapped keys and Postgres all live there.

## Options considered

| Option | How it works | Fit with Sigil | Verdict |
|---|---|---|---|
| A. Outbound-initiated relay or ingress mailbox | A public Sigil-hosted mailbox receives the reply. The PC pulls it by long-poll or WebSocket. | Needs a new public service to host and secure. | Not chosen. Revisit if no provider works. |
| B. Third-party tunnel to a narrow listener | cloudflared or Tailscale Funnel forwards one hostname to a loopback ingress listener. | Fits the 404-when-unconfigured pattern. No inbound port on the PC. | Chosen. |
| C. Webhook receiver on a public host | Router port forward, or a small VPS reverse proxy. | Exposes the home IP or adds a host to operate. | Rejected. |
| D. Tunnel the cookie-only listener or the main relay port | Point the provider at an existing listener. | Cookie listener answers `401`. The main port exposes every route. | Rejected. |
| E. Reply through another channel, such as the AgentMail ingress | Grok mails the reply instead of calling the route. | The brief gives no evidence the Grok side can do this. | Not evaluated. |

**A. Outbound-initiated relay or ingress mailbox.** The PC dials out, so no inbound port opens on the PC. That is the appeal. The long-poll and WebSocket pull variants differ only in how the PC fetches. Both need a public host that receives Grok's POST first. That host must check credentials, rate limit, and store replies, which repeats the work of this design on a new machine. The repo facts reviewed describe no hosted Sigil component. Option B gets the same outbound-only property from a provider and keeps the existing reply handler.

**B. Third-party tunnel to a narrow listener.** Cloudflare Tunnel makes outbound-only connections on port 7844 to Cloudflare and needs no inbound ports. Public hostnames map to local services, and Cloudflare Access can protect the hostname. A Service Auth policy with a service token (Client ID and Client Secret headers) authorizes machine callers. An email allowlist policy blocks machines. Access cannot enforce on a non-standard port in the URL (https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/, https://developers.cloudflare.com/cloudflare-one/access-controls/policies/, https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/). Tailscale Funnel limits public ports to 443, 8443 and 10000, serves only names under the tailnet's `ts.net` domain, requires TLS, and applies bandwidth limits that cannot be configured and have no published number (https://tailscale.com/docs/features/tailscale-funnel). Anyone with the URL can reach a Funnel. Tailscale Serve is tailnet-only, and private-network routing needs Grok's cloud to join the network. Both work only if Enterprise Team Setup applies, which is unverified for Chris's account (https://docs.x.ai/grok-bot/private-networks).

**C. Webhook receiver on a public host.** A router port forward exposes the home IP, depends on the ISP, and breaks when the address changes. A small VPS reverse proxy must still reach the PC, which returns to option A or B. This is design reasoning, not a repo fact.

**D. Pointing a tunnel at an existing listener.** The cookie-only public listener does not serve the reply route and answers `401` to a bearer-only call (V by reading). The main relay port serves every route and the `/v1/stream` single-use tickets, and the relay help text warns against logging those URLs behind a proxy. The repo has no pre-auth rate limit and no trusted-proxy handling. Publishing the main port would expose all of that to the internet.

**E. Another channel.** The AgentMail ingress verifies svix-signed webhooks for mail (`ingress/v1/agentmail-provider.mjs`). It is a precedent for a route mounted only when configured. The brief has no fact showing that a Grok bot can send mail as its reply path or that mail would map onto the reply route's six fields. This option is not evaluated.

### Recommendation

Build the reply ingress as a dedicated loopback listener with one route, and expose it through a provider tunnel. Use Cloudflare Tunnel with a Cloudflare Access service-token policy and a WAF rate rule as the first choice. Use Tailscale Funnel as the fallback when no Cloudflare-managed domain exists.

Why this choice:

- The PC makes only outbound connections, and the existing reply handler runs unchanged after the gate.
- The listener adds a per-bot credential and layered limits that the repo lacks.
- The provider adds an authenticated edge layer and edge rate limiting as defense in depth. Sigil does not depend on them.
- Provider choice is configuration, so switching to the fallback needs no code change.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| D1. Listener | New loopback listener, the reply ingress, enabled only by `--ingress-origin <https bare origin>`. Default port is `--port` plus 3, override with `--ingress-port`. Exactly one route, `POST /v1/rooms/{room_id}/replies`. Everything else answers one fixed `404`. | A narrow listener cannot leak room routes. An unconfigured relay exposes nothing new, as with the AgentMail and federation routes. |
| D1 (startup checks) | The relay exits non-zero and starts nothing unless the origin is a bare https origin, `--database-url` and `--room-bot-key-wrap-key` are set, `--port` is non-zero, and the relay, stream, public and ingress ports are four distinct values. Bind `127.0.0.1` only. | Per-bot tokens need Postgres. Distinct ports stop a silent collision. |
| D1 (request limits) | Body cap 96 KiB (`REPLY_BODY_MAX_BYTES`), request timeout 10 s, short keep-alive. `Content-Type` must be `application/json` or the answer is `415`. Oversize chunked bodies stop at the existing `readBody` cap. No `X-Forwarded-For` or provider identity header is read. | Small limits bound what a stranger can cost. Ignoring forwarded headers avoids a trusted-proxy setting. |
| D2. Shared gate | Move the token check, the unconfigured `404`, the handler call and error mapping from `http-server.mjs` into `relay/v1/floor-warden-gate.mjs`. The main route and the ingress both call it. A gate option `distinguishEndpointPrincipal` (true for the main route, false for the ingress) controls the one intended difference. With it true, the gate keeps today's `401`/`403` split. With it false, the gate never calls the endpoint authenticator and answers `401 UNAUTHENTICATED` for every token that does not match. Steps 3-10 in `floor-warden-replies.mjs` do not change. | One module cannot drift between the two entry points. The phase 6 tests keep passing. The `403` split would tell an internet caller that a bearer is a valid endpoint token, and it would cost a database lookup before any limit. |
| D3. Per-bot credentials | Table `floor_warden_reply_tokens`. Token format is `fwr_` plus 32 random bytes in base64url. Only the SHA-256 hash is stored. The handler requires `target_bot_id` to equal the token's `bot_id`, else `403 BOT_NOT_ON_ROSTER`. | A leaked token names one bot. Reusing the code adds no new probe signal. The prefix lets secret scanners match it. |
| D3 (lifecycle) | Statuses are `active`, `retired` and `revoked`. A retired token works until `expires_at` (default 24 h after rotate). A revoked token never works. `last_used_at` updates at most once per 60 s per token. `sigil bot disable` already kills a bot's tokens through step 4. | Overlap allows rotation without downtime. Throttled writes avoid a write per request. |
| D3 (global token) | The phase 6 global env token still works on the main relay route. The ingress refuses it unless `--ingress-allow-global-token` is set (default off). When the flag is on, the relay prints a warning at startup. | The tunnel path always carries a bot-bound credential. Q4 asks Chris to confirm. |
| D4. Layered limits | (a) An in-memory ingress ceiling of 120 requests per minute for all callers, answered `429 RATE_LIMITED` with `Retry-After` before any body read or database call (`--ingress-rate-per-minute`). (b) Per-bot limit of 30 per minute after the token matches, through `reserveRateLimit` with scope kind `floor_warden_reply`. (c) The accept path scopes still apply. | Layers catch different failures. The shared ceiling is an accepted v1 denial of service, with the same reasoning as the login `start` ceiling. |
| D4 (fail closed) | If the limiter throws, or the repository has no `reserveRateLimit`, the ingress answers `503` and writes nothing. | The directory limiter at `http-server.mjs` line ~142 returns `{allowed:true}` in that case. The ingress does not copy that. |
| D5. https only | `--ingress-origin` must be https. `sigil agent run --room-bridge floor-warden` refuses an http reply URL unless the host is `127.0.0.1`, `localhost` or `[::1]`. | Today's check accepts http for any host. The bearer token would cross the internet in clear text. |
| D6. Provider | Provider choice is configuration. Recommended is Cloudflare Tunnel with Access (Service Auth) and a WAF rate rule. Fallback is Tailscale Funnel. Access with an identity or email policy must not be used on this path. | Cloudflare adds edge auth and edge rate limits that Sigil lacks. An email policy blocks a non-interactive caller. |
| D6 (rejected) | Tailscale Serve, router port forward, and free tunnels with random hostnames. Free tunnels such as ngrok are not evaluated. | Serve is tailnet-only. A port forward exposes the home IP. |
| D7. No wake path | The ingress carries replies only. It starts no process, writes no delivery for a local agent, does not touch `BRIDGES` in `wake-dispatcher.mjs`, and adds no route for sessions, heartbeats or direct messages. | A reply is data for an invocation that already exists. |
| D8. Reply contract | The Grok side sends the six fields with `Authorization: Bearer fwr_...`. On timeout, network error, `429` or `5xx` it resends the identical body and `idempotency_key` with backoff. It treats `202` with `duplicate: true` as success and does not retry other `4xx`. | Idempotency makes a retry safe even when the first attempt committed behind a provider `502` or `524`. |
| D9. Observability | Aggregated auth-failure log lines, in-memory counters, three new audit event types, `sigil ingress status` and `sigil ingress doctor`. | The operator needs to see a flood and a broken tunnel without a metrics server. |
| D10. Fit with phases 5 and 6 | The ingress reuses `handleFloorWardenReply` and so `acceptEnvelopeAsync`, invocation completion, fan-out and `room.updated`. Nothing about completion, idempotency keys or `room_seq` changes. | There is no second code path to keep correct. |
| D11. Hybrid tiers | The ingress carries no direct messages in v1. Any future session for a Floor Warden bot is registered and heartbeated by the local bridge process, never by Grok's cloud. | A cloud bot cannot hold a socket or a 30 s heartbeat. |
| D12. Failure handling | Failures have a named symptom and a recovery step. The kill switch is restarting the relay without `--ingress-origin`. | The operator can stop the exposure without a database change. |

## Components

### Reply ingress listener

`relay up` starts a fourth `127.0.0.1` listener when `--ingress-origin` is set. It lives in the relay process and restarts with it. A table-driven route test covers many method and path pairs, including `%2f`, a trailing slash, a double slash, `HEAD`, `OPTIONS` and an upgrade request. Only `POST /v1/rooms/{room_id}/replies` reaches the gate. The room id decodes as it does on the main route, and a decode failure answers `400 INVALID_REQUEST`.

The fixed `404` body uses the standard error shape `{request_id, code, message, details?}` with code `NOT_FOUND`. It is identical for every unmatched request, so the listener does not reveal which paths exist. The ingress sets no CORS headers and does not read query strings.

The ingress runs its checks in this order.

1. Method and path match, otherwise the fixed `404`.
2. The ingress-wide ceiling, answered `429` before any body read or database call.
3. The bearer token check, answered `401`.
4. `Content-Type` must be `application/json`, otherwise `415`.
5. The body read with the 96 KiB cap and the 10 s request timeout, answered `400` or `413` as the existing `readBody` and handler answer.
6. The per-bot limit, answered `429`.
7. The handler steps 3 to 10, unchanged.

Step 4 runs after authentication on purpose. An unauthenticated caller only ever sees `404`, `429` or `401`.

### Shared gate

`relay/v1/floor-warden-gate.mjs` holds the reply gate now in `http-server.mjs`. It checks the token, answers `404` when the reply handler is unconfigured, answers `503 FLOOR_WARDEN_UNAVAILABLE` when there is no handler, and maps a thrown handler error to `503 DATABASE_UNAVAILABLE` with a `floor_warden_reply_failed` log line that carries only the request id and code. The main route passes a token matcher built from the env token. The ingress passes a matcher built from the token table, plus the global matcher only when the flag is set.

The two entry points behave the same except in one respect, set by the gate option `distinguishEndpointPrincipal`.

- On the main relay route the option is true. The gate keeps today's split. A bearer that authenticates as a normal endpoint principal gets `403 ROUTE_NOT_AUTHORIZED`, and anything else gets `401 UNAUTHENTICATED`.
- On the ingress the option is false. The gate never calls the endpoint authenticator and answers `401 UNAUTHENTICATED` for every token that does not match. The `403` split would tell an internet caller that a bearer is a valid endpoint token, and it would cost a database lookup before any limit.

A test runs one request table through both entry points and expects equal answers everywhere except that one documented difference.

### Per-bot reply credentials

The ingress hashes the presented bearer with SHA-256 and looks it up by hash, the same pattern as `room_invites.token_hash`. A hit yields `token_id` and `bot_id`. The status check follows.

- `active`, accepted.
- `retired`, accepted only while `expires_at` is in the future.
- `revoked`, never accepted. It answers `401 UNAUTHENTICATED`, the same answer as an unknown token.

`sigil bot token create` prints the plaintext once to stdout. It stores nothing but the hash, and no token passes through argv. A revoked or unknown token writes no audit row at the gate, matching phase 6's rule for unauthenticated refusals.

The ingress accepts no signed envelope. The route takes six plain string fields, and the relay signs the `room.message` with the bot's relay-held key, so Grok's cloud never holds an Ed25519 key.

### Limits and fail-closed behavior

The ingress ceiling is a token bucket in memory, checked first. After a token matches, the per-bot limit reserves a `quota_usage` row with scope kind `floor_warden_reply` and the bot id as scope id, in minute buckets (`Math.floor(ms/60000)`). Each failure answers with the standard error shape.

- A limit hit answers `429 RATE_LIMITED`.
- A limiter or database fault answers `503` and writes nothing.
- A missing signing key answers `503 BOT_SIGNING_UNAVAILABLE`.

### Provider layer (runbook outline, not secrets)

The plan ships a runbook document. The outline for Cloudflare Tunnel follows.

1. Pick a dedicated hostname under a Cloudflare-managed domain.
2. Run cloudflared as a Windows service with one ingress rule from the hostname to `http://127.0.0.1:<ingress port>`.
3. Add a WAF rate-limiting rule on the hostname.
4. Add an Access application on the hostname with a Service Auth policy. Give the service token to the Grok bot only if the bot can send the two headers (assumption A5).

With Access in front, Access answers an unauthenticated probe from outside and Sigil does not. Only a probe that carries the service-token headers reaches the Sigil gate.

For Tailscale Funnel, run `tailscale funnel` on port 443 against the ingress port. The runbook states that Funnel has no edge auth and no edge rate limit. No secret, token or hostname value goes into the repo.

### Reply contract for the Grok side

This contract is documented and not enforced beyond the route itself.

- `POST` JSON with `room_id`, `target_bot_id`, `sender`, `in_reply_to`, `text` and `idempotency_key`. The bridge payload already carries these values.
- Send `Authorization: Bearer fwr_...`.
- Send one reply per invocation. A second reply under a new key gets `403 ROOM_NOT_INVOKED`.
- Retry only on timeout, network error, `429` and `5xx`, with the identical body.

Whether a Grok bot retries is unverified (assumption A3). The 15-minute `REPLY_TIMEOUT` stays the backstop and posts a visible `invocation_failed` event.

### Observability

See the Observability section below. The ingress writes log lines through the existing `relayLogger`, counters through `createRelayMetrics`, and audit rows to `audit_events`.

### Fit with the bridge model

The ingress adds nothing to `BRIDGES` (`claude`, `codex`, `router`). `floor-warden` is not in that set and phase 7 does not add it, because the tunnel never wakes a local process. The bridge process `sigil agent run --room-bridge floor-warden` keeps forwarding outbound from the PC. The ingress feeds `handleFloorWardenReply`, which calls `acceptEnvelopeAsync` with `expectedTriggerMessageId`. That call completes the invocation, promotes the next queued one, fans out to human members and sends `room.updated`. Delivery receipts for those fan-out deliveries and the idempotency keys from phases 5 and 6 behave as before.

Phase 5's report-only path (the Ironbots reporter posting from a host) does not use the ingress. It stays on the authenticated relay route. Phase 5's reconcile-before-resend rule covers a poster that cannot see the result of a send. The Grok reply caller gets equivalent safety from the idempotency replay, by resending identical bytes, instead of a receipts lookup.

### Interaction with hybrid sessions and direct-message tiers

Version 1 of the ingress carries no direct messages. Under the hybrid design, a session heartbeats every 30 s and expires 90 s after its last beat. A Grok cloud bot cannot hold a stream socket or heartbeat, so it cannot be an agent session. The hybrid example listing shows a `grokbot` runtime. If a Floor Warden bot appears in the live session directory, the local bridge process must register and heartbeat it. Its tier then describes the bridge process.

- `live-idle` or `live-busy` means the bridge is up.
- `stored` means the bridge is down.
- The cloud bot's own busy state stays invisible.

A future `direct.message` reply route must be a separate route name in the ingress allowlist, with its own per-bot token scope and its own quota scope kind. It needs hybrid migrations 037 and 038 first.

The hybrid design keeps the old listener until phase 7 is proven on the Windows mesh. The "proven" bar is in Rollout.

## Data

Migration `039_reply_ingress.sql`. The executor re-checks the number against `main` first.

- Table `floor_warden_reply_tokens(token_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES floor_warden_bots(bot_id), token_sha256 BYTEA NOT NULL UNIQUE, status TEXT NOT NULL CHECK (status IN ('active','retired','revoked')), created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ)`.
- A drop and re-add of the `quota_usage` scope kind constraint. The rate-limit table is `quota_usage(scope_kind, scope_id, window_start, count)` with primary key `(scope_kind, scope_id, window_start)` from migration 007. Migrations 012, 017, 018 and 034 each drop and re-add the check. The latest list in 034 is `endpoint`, `owner`, `conversation`, `directory_invite_create`, `directory_invite_redeem`, `directory_match_create`, `directory_match_attempt`, `federation_origin`, `federation_directory_invite_create`, `federation_directory_redeem`, `federation_directory_redemption_inbound`, `invite`, `oauth_provider_subject`, `oauth_start`. Migration 039 repeats that full list and adds `floor_warden_reply`.
- The executor must re-read the live constraint at execution time, because 036 to 038 might also extend it (assumption A12).

**Memory repository parity.** Both `relay/v1/postgres-repository.mjs` and `cli/memory-repository.mjs` get every new method. The new methods are token create, lookup by hash, rotate, revoke, retire expiry and the `last_used_at` throttle. `reserveRateLimit(scopeKind, scopeId, windowStart, limit, client)` already exists in both files (about line 893 and line 204) and needs only the new scope kind.

**Numbering rule.** On `main`, migrations 001 to 035 exist and 035 is `035_floor_warden_bridge.sql`. Number 036 (`report_only_mode`) is reserved for phase 5. Numbers 037 (`agent_sessions`) and 038 (`direct_message_delivery`) are reserved for hybrid. None of the three is built. At execution time the executor runs `ls sigil/migrations | tail -3` and uses the maximum existing number plus 1. The result must never be lower than 039 while 036 to 038 are unmerged, and 035 to 038 are never reused.

**Out-of-order analysis.** `apply-migrations.mjs` applies `*.sql` files in filename sort order and records filenames in `_sigil_schema_migrations`. A gap is harmless. If 039 lands before 036 to 038, those files apply later in their own order. Their object sets are disjoint from 039's. The one shared object is the `quota_usage` check. If a later migration drops and re-adds it from a stale list, it would remove `floor_warden_reply`. The migration test applies stub 036 to 038 files after 035 and checks that each re-add includes every earlier kind.

## CLI and relay flags

New `sigil relay up` flags:

- `--ingress-origin <https bare origin>`. Enables the ingress.
- `--ingress-port <n>`. Default is `--port` plus 3.
- `--ingress-rate-per-minute <n>`. Default 120.
- `--ingress-allow-global-token`. Default off.

New commands:

- `sigil bot token create --bot-id <id> [--expires-in-days n]`. Prints the plaintext once to stdout.
- `sigil bot token rotate --bot-id <id> [--grace-minutes n]`. Creates a new token and retires the old one (default 24 h overlap).
- `sigil bot token revoke --token-id <id>`.
- `sigil bot token list --bot-id <id>`. Shows ids, statuses and ages, never plaintext.
- `sigil ingress status`. Reads Postgres.
- `sigil ingress doctor --origin <url> [--access-client-id-env <name>] [--access-client-secret-env <name>] [--relay-port <n>] [--stream-port <n>] [--public-port <n>] [--ingress-port <n>]`. Probes the public origin. The two Access flags name environment variables and never carry a value on argv. When given, doctor sends the two Cloudflare Access service-token headers on its probes. The four port flags are optional and feed the port overlap checks. Doctor never sends a reply token.

Changed behavior: `sigil agent run --room-bridge floor-warden` refuses an http reply URL unless the host is loopback (one new test). The per-bot limit (30 per minute) is a constant in v1 and can move to a flag later (Q7).

## Failure modes and operator recovery

| Failure | What the user or operator sees | Recovery |
|---|---|---|
| Tunnel provider process down | Grok's curl fails (provider `530` or `502`). The invocation ends `REPLY_TIMEOUT` with a visible `invocation_failed` event. | `Restart-Service cloudflared`, then `sigil ingress doctor`. The bot's retry decides whether the reply still lands. |
| PC asleep or relay down | Same symptoms. The bridge is also down, so no new forwards happen. | Wake the PC or restart the relay. |
| DNS or certificate problem | Grok's curl fails at connect. Doctor reports the certificate check failed. | Fix the hostname or certificate at the provider. |
| Postgres down | `503 DATABASE_UNAVAILABLE`. | Restore Postgres. A retry with the same `idempotency_key` then succeeds. |
| Signing key or wrap key missing | `503 BOT_SIGNING_UNAVAILABLE`. | Set `--room-bot-key-wrap-key` or fix the key row. |
| Token leaked | An attacker can post one reply per running invocation of that bot. | `sigil bot token revoke --token-id <id>` at once, then `create`. Revoked tokens answer `401 UNAUTHENTICATED`. |
| Token rotation | The old token works for 24 h or `--grace-minutes`. | `sigil bot token rotate --bot-id <id>`. Update the Grok side within the grace period. |
| Request flood | `429 RATE_LIMITED`, log lines aggregated to one per 10 s. | Use the edge WAF rule, lower `--ingress-rate-per-minute`, or use the kill switch. |
| Kill switch | The ingress listener disappears and the hostname answers `502` from the provider. | Restart the relay without `--ingress-origin`. No database change is needed. |
| Two listeners on one port | The relay refuses to start and prints the ports. | Set distinct ports. |
| Late reply after Stop or `REPLY_TIMEOUT` | `403 ROOM_NOT_INVOKED`, nothing is posted. This is by design. | None. |
| Duplicate delivery | `202` with `duplicate: true`. | None. |
| Relay restarts with the ingress up | cloudflared stays up and answers `502` during the gap. | Wait for the relay. The caller's retry applies. |
| Disabled bot | Step 4 answers `403 BOT_NOT_ON_ROSTER`. | `sigil bot disable` is the intended control. |

**Stream port drift.** The stream port is 8792 in `C:\dev\scripts\run-sigil-daemon.ps1` and 8793 in the mesh skill. With relay port 8791, the cookie-only public listener defaults to port plus 2, which is 8793 and collides with the skill's stream port (derived from code defaults). This design does not resolve the drift. The ingress default of port plus 3 is 8794, and the startup check requires four distinct ports.

## Observability

- **Logs.** The ingress writes `ingress_request` lines through `relayLogger` with `request_id`, status, route result, and `bot_id` when known. A line never carries a token, query string, body or text. Auth-failure lines aggregate to at most one line per 10 s with a count, so a flood cannot fill the disk.
- **Counters.** `createRelayMetrics` provides in-memory counters `sigil_ingress_requests_total{result}`, `sigil_ingress_auth_failed_total` and `sigil_ingress_rate_limited_total{scope}`. The repo has no metrics export route (V), so only tests and logs read these counters. An export route is a non-goal.
- **Audit.** The existing `room.floor_warden_reply` rows continue. New event types `ingress.token_created`, `ingress.token_rotated` and `ingress.token_revoked` carry `bot_id` and `token_id` only.
- **`sigil ingress status`.** It reads Postgres and prints tokens per bot with status, age and `last_used_at`, plus replies accepted in the last hour per bot from audit rows.
- **`sigil ingress doctor --origin <url>`.** It runs these checks from the PC and never sends a reply token. It accepts optional `--access-client-id-env` and `--access-client-secret-env`, which name environment variables and never carry a value on argv. When given, doctor sends the two Cloudflare Access service-token headers on its probes. Without them, when the edge answers a probe and Sigil does not, doctor reports "blocked at the edge, the Sigil gate was not reached" and does not claim a pass. It tells the two apart by the standard Sigil error shape in the response body. Doctor also accepts optional `--relay-port`, `--stream-port`, `--public-port` and `--ingress-port`, used only by checks 5 and 6. Doctor is a separate command and cannot see the flags of the running relay process. The relay, not doctor, prints the warning about `--ingress-allow-global-token` at startup (D3).
  1. An unauthenticated `POST` to a fake room path expects `401 UNAUTHENTICATED` from Sigil. This proves the route and auth gate are reachable through the tunnel without a reply token. Behind Access, this check needs the service-token headers to reach the Sigil gate.
  2. `GET /` expects `404`.
  3. `GET /v1/rooms` expects `404`.
  4. The certificate is valid.
  5. When the operator passes --relay-port (and optionally --stream-port, --public-port, --ingress-port), doctor computes the four ports with the same defaults as relay up and reports any two that are equal.
  6. When two ports overlap, doctor prints the 8792/8793 and port-plus-2 collision hint.

`sigil doctor` today checks one `--relay-url` (`cli/doctor.mjs`). The ingress doctor is a separate command.

## Testing

Layers, from cheapest up:

1. **Unit.** Gate refactor equivalence. One request table runs through both entry points and expects equal answers everywhere except the documented difference (a normal endpoint bearer gets `403 ROUTE_NOT_AUTHORIZED` on the main route and `401 UNAUTHENTICATED` on the ingress, set by `distinguishEndpointPrincipal`). Token store. Rate buckets. Config validation. The route allowlist table test. The order of checks on the ingress. Content type (`415`). Chunked oversize.
2. **Repository parity.** Memory and Postgres for token create, lookup, rotate, revoke, the `last_used_at` throttle, and the new `reserveRateLimit` scope.
3. **Migration 039.** Tables, a constraint that includes every earlier kind, and apply order with stub 036 to 038 after 035.
4. **Postgres evidence.** Real HTTP to the ingress on a disposable database.
   - Happy path and duplicate.
   - Wrong-bot token, expecting `403 BOT_NOT_ON_ROSTER`.
   - Revoked token, expecting `401`.
   - A normal endpoint bearer on the ingress, expecting `401` and no endpoint lookup.
   - Retired token inside grace (`202`) and after expiry (`401`).
   - Per-bot `429` and recovery in the next minute.
   - Ingress ceiling `429`.
   - Limiter failure `503`.
   - Database down `503`, then recovery with the same idempotency key.
   - Stale `in_reply_to` `403`.
   - Stop then a late reply `403`.
   - No secrets in logs or audit rows.
   - The cookie listener still answers `401` for the reply path.
5. **End to end.** Extend `relay/v1/floor-warden-e2e.pg.test.mjs` so the fake Floor Warden calls the reply URL through `integration/fixtures/loopback-tls-proxy.mjs` on the ingress origin.
6. **Config tests.** `cli/relay-up-flags.test.mjs` style tests for every fail-closed startup rule, the bridge https-only rule, and the port collision rule.

**The Postgres evidence rule.** Postgres tests read `SIGIL_TEST_DATABASE_URL`, skip without it, call `assertDisposableTestDatabase` (the name must end in `_test`) and run `applyMigrations(url, { reset: true })`. "Evidence" means the named pg test files ran with `SIGIL_TEST_DATABASE_URL` set, and their pass counts and skip counts are pasted into the PR. A skipped pg test is not evidence. Only one `node --test` process runs at a time, because overlapping runs deadlock the shared database. The docs-only PR for this design runs no Postgres test.

**Live transport smoke.** After the provider is set up, curl drives a fixture bot (`ep_test_bot`) in a disposable room on a disposable database from outside the LAN. A phone hotspot or the Linux box works. It expects `401` without a token and `202` with a valid token against a running fixture invocation. When Access is in front, the curl calls carry the service-token headers, and a call without them is expected to get its answer from Access and not from Sigil. No real Grok routine is called in tests.

## Rollout

| Stage | What happens | Who acts |
|---|---|---|
| 0 | This docs PR. | An agent, Chris reviews. |
| 1 | Migration 039, token store, and `sigil bot token` commands behind flags that default off. | An agent. |
| 2 | Gate refactor, ingress listener and limits, tested locally with the loopback TLS proxy fixture and the fake Floor Warden. | An agent. |
| 3 | Provider setup from the runbook. | Chris. Needs Chris's approval (account, hostname, spend). |
| 4 | Transport smoke from outside the LAN with a fixture bot and a disposable database. | An agent, with the hostname Chris sets up. |
| 5 | Create the real bot endpoints, copy the routine URL and sender key (both still open), then run the live Grok smoke. | Chris decides. Needs Chris's approval. |
| 6 | Observe for 7 days. Then update `README.md` and `STATUS.md` and mark the hybrid old-listener retirement as unblocked. | Chris and an agent. |

**The "proven" bar.** Phase 7 counts as proven when three things hold. The transport smoke passes from outside the LAN. The real Grok smoke posts a reply into a room. Seven days pass without an ingress incident. Q6 asks Chris to confirm the bar.

**Out-of-repo follow-ups.** This work does not do them.

- Add a cloudflared (or `tailscale funnel`) service beside the `SigilMeshDaemon` scheduled task.
- Move the inline database setting in `run-sigil-daemon.ps1` to the environment (hybrid Q10).
- Reconcile stream port 8792 against 8793.

Global constraints from earlier plans carry into the companion plan. Work happens on a worktree branched off `origin/main`. Secrets arrive by environment variable name and never by argv. No test, log line, error or audit row contains a token, key or webhook URL. Nothing in `.sigil/*.json` is read or committed. The plan never creates `ep_chief` or `ep_helix_ci`, and never runs `sigil bot add` against a real database.

The companion plan splits the work into these tasks.

- **Task 1.** Settle unverified facts (cookie listener 401 characterization test, live quota constraint, port defaults, notes file).
- **Task 2.** Migration 039.
- **Task 3.** Repository token methods and parity.
- **Task 4.** Reply token module (format, hash, status rules, last-used throttle).
- **Task 5.** `sigil bot token` commands and audit events.
- **Task 6.** Shared gate refactor.
- **Task 7.** Reply ingress listener.
- **Task 8.** Limits and metrics.
- **Task 9.** `relay up` flags, startup validation, ports, kill switch.
- **Task 10.** Bridge https-only reply URL.
- **Task 11.** `sigil ingress status` and `sigil ingress doctor`.
- **Task 12.** Postgres evidence tests over real HTTP.
- **Task 13.** End-to-end through the loopback TLS proxy.
- **Task 14.** Provider runbook `docs/reply-ingress-runbook.md`.
- **Task 15.** Live transport smoke procedure (runs only after Chris approves provider setup).
- **Task 16.** Docs, status and full verification.

## Assumptions

All of these are unverified unless a label says otherwise.

- **A1.** The Grok bot posts the reply with a curl step from its cloud computer. curl itself works (PUB, https://docs.x.ai/grok-bot/security). The instruction step is UNVERIFIED. Closes at the live Grok smoke (stage 5).
- **A2.** A Grok bot can store the reply token somewhere it can read. UNVERIFIED. Team Secrets are Enterprise only per the security FAQ. Closes at stage 5.
- **A3.** The bot retries a failed POST. UNVERIFIED. Closes at stage 5 by forcing a failure. The 15-minute `REPLY_TIMEOUT` stays the backstop.
- **A4.** Chris owns a Cloudflare-managed domain. UNVERIFIED. Closes at stage 3. Without it, the fallback applies.
- **A5.** The bot can send Cloudflare Access service-token headers. UNVERIFIED, though curl can send headers. Closes at stage 5. If false, the hostname relies on D1 to D4 and the WAF rule.
- **A6.** Hosted Grok computers egress through shared static IP ranges, so an IP allowlist identifies Grok Bot traffic and not Chris alone (PUB, https://docs.x.ai/grok-bot/security). This design does not rely on an IP allowlist.
- **A7.** cloudflared or tailscaled can run as a Windows service on the PC. UNVERIFIED here. The runbook in plan Task 14 records the operator step. Closes in plan Task 14 and stage 3.
- **A8.** The cookie-only listener answers `401` to a bearer-only reply POST. Verified in the repo by reading. A test in plan Task 1 proves it.
- **A9.** Relay `--port` plus 3 is free on the mesh. Derived. The relay startup check enforces distinct ports and sigil ingress doctor reports overlaps when given the ports. Closes in plan Tasks 9 and 11.
- **A10.** Migration 039 does not clash with 036 to 038. Closes in plan Tasks 1 and 2 and the out-of-order migration test.
- **A11.** One process serving four loopback listeners adds no thread-safety issue. Node runs on a single thread, and the quota writes are Postgres upserts. Closes in plan Task 12.
- **A12.** The `quota_usage` check list at execution time still equals the 034 list plus any 036 to 038 additions. Closes when the executor re-reads the live constraint in plan Tasks 1 and 2.

Two further notes carry PUB labels. Grok Bot routines with a webhook trigger accept a POST with `Authorization: Bearer <key>` and answer HTTP 200 for accepted, not finished. A failed run is not retried automatically (https://cursor.com/help/grok-bot/routines). A separate xAI document describes Standard Webhooks HMAC-SHA256 signing, 202 Accepted, a 1 MiB body limit and a 5-minute timestamp window (https://docs.x.ai/grok/automations/webhooks). The two documents describe different schemes. Which one applies to the "Sigil rooms" routine is UNVERIFIED. This affects the outbound bridge and not the tunnel, and phase 6 assumption 1 already covers the sender key header.

## Open questions

- **Q1. Needs Chris's decision.** Should phase 7 cover the tunnel only, with the PWA and Web Push split into a later 7b design? Recommended yes.
- **Q2. Needs Chris's decision.** Which provider? Cloudflare Tunnel with an Access service token needs a Cloudflare-managed domain, which is unverified. Tailscale Funnel needs no domain but has no edge auth. Recommended Cloudflare when a domain exists, and Funnel to unblock the first smoke.
- **Q3. Needs Chris's decision.** Should a signed request mode (HMAC, timestamp, nonce) be built later? Recommended not in phase 7. Revisit after the live smoke shows what the Grok side can do.
- **Q4. Needs Chris's decision.** Should per-bot tokens be the only credential on the tunnel path, with the global token refused unless a flag is set? Recommended yes.
- **Q5. Needs Chris's decision.** Should the real bot endpoints, routine URL and sender key be set up now, or should the transport smoke stay on fixtures until Chris says go? Chris declined endpoint setup as a diversion in phase 6.
- **Q6. Needs Chris's decision.** Is the "proven on the Windows mesh" bar right for retiring the old listener (transport smoke, real Grok smoke, 7 days quiet)? Recommended yes.
- **Q7. Needs Chris's decision.** Are the rate defaults acceptable, 120 per minute for the ingress and 30 per minute per bot? Recommended yes, with tuning after the live smoke.
- **Q8. Investigation.** Does a Grok Bot hold a secret and send extra headers in its curl step, does it retry, and which webhook auth scheme (Bearer or Standard Webhooks) applies to the Sigil rooms routine? Closes against the real routine during the live smoke.
- **Q9. Needs Chris's decision.** Who owns the `run-sigil-daemon.ps1` follow-ups (a service for cloudflared, the inline database credential, and 8792 against 8793)? This is the same question as hybrid Q10.
- **Q10. Investigation.** Can the Grok Bot computer reach the PC privately, through member desktop routing or Enterprise Team Setup with Tailscale? That would remove public exposure. It matters only if Chris's account has those features (https://docs.x.ai/grok-bot/private-networks).
