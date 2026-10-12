# Sigil rooms third-party login — design

Depends on `2026-10-11-sigil-rooms-multi-human-foundation-design.md` (`lookupTrustedEndpoint`, `provisionHumanTx`, async signing, `invokable_by`, suspension, and `LISTEN/NOTIFY`). Build that spec first.

## Problem

Rooms web authenticates with a bearer token the operator pastes into the page and keeps in `sessionStorage`. The 4a spec deferred a cookie session "until 4b needs work off localhost" (`2026-10-05-sigil-rooms-phase-4a-relay-browser-surface-design.md`). That moment arrives when other people on the operator's network use rooms.

Sigil has no path from "this person logged in with an identity provider" to "this request is from human H." `POST /v1/auth/login` (`2026-08-23-sigil-real-oidc-login.md`) requires an already-authenticated bearer principal, verifies a caller-supplied ID token, and records a 5-minute `human_sessions` row. It returns no credential, and that spec says Sigil never drives a browser redirect.

This spec adds the bootstrap: a browser login through GitHub, gated by invite for first contact, that yields a cookie session on the rooms browser routes.

## Decisions

| Question | Decision |
| --- | --- |
| Audience | The operator plus invited people, on a private network. Not public sign-up. |
| Network | Tailscale Serve first, or a Cloudflare Tunnel behind Cloudflare Access with an email allowlist. Either keeps the relay off the open internet and works from a phone: the friend installs the Tailscale app and joins the tailnet, or opens the Cloudflare Access link and passes the email check. The web client is already a plain browser page, so mobile needs no app. A fully public endpoint comes later, under a separate hardening spec. `--public-origin` makes the move configuration. |
| Admission | Invite-only for first contact. An invite links a provider identity to a Sigil human once. After that, the linked identity logs in with no invite. |
| Providers in v1 | GitHub (OAuth2 only). The provider interface stays, so Google (OIDC) is an addition, not a rewrite; its design notes are under Deferred: Google. Microsoft, X, and Meta follow the same path. |
| Architecture | Relay-native: the relay runs authorization-code + PKCE (S256) and issues the session cookie. No sidecar or broker. |
| Topology | One origin behind a required TLS proxy (below). `--public-origin` is that origin. |
| Signing | Foundation spec: relay-custodial per-human keys. |

Claude, ChatGPT, and Grok are not providers. No public "sign in with" flow is known for them. Sigil already talks to those agents as endpoints.

## Reused parts

- `oidc_identities`, `human_sessions`, the audit table, `recordAuditEvent`.
- `outboundFetchOptions` from `oidc-client.mjs` (5-second timeout, `redirect: 'error'`) for every provider fetch. It is a local function today, so v1 exports it (and `peer-discovery.mjs`, which duplicates it, switches to the export). GitHub issues no ID token, so v1 does not call `verifyRealIdToken`. The Google work (Deferred) exports that too and adds `expectedNonce` and `issuerAliases`.
- The room routes, `ws-ticket`, and `ticket-store.mjs` as the model for the flow store.
- Foundation: `provisionHumanTx`, `addHumanToRoomTx`, `lookupTrustedEndpoint`, suspension, `NOTIFY`.

## Origin topology

The browser sees one origin, `--public-origin`, so cookies are same-origin and no credentialed CORS is needed. Today the relay HTTP server, the stream server (`port + 1`, path `/v1/stream`), and `sigil-rooms-web` each listen on `127.0.0.1` (`sigil.mjs:336,439`, `sigil-rooms-web.mjs:33`), and the web server rejects POST. Tailscale peers reach none of them directly.

**Required deployment:** a TLS-terminating proxy (Tailscale Serve, or equivalent) on the `--public-origin` hostname that forwards an **allowlist** of relay paths:

| Path | Backend |
| --- | --- |
| `/v1/stream` (WebSocket upgrade) | stream server |
| `/v1/rooms`, `/v1/rooms/*` | relay HTTP |
| `/v1/auth/*` | relay HTTP |
| `/v1/mentions` | relay HTTP |
| everything else | `sigil-rooms-web` static server |

Forwarding all of `/v1/*` would expose to every tailnet device what is reachable only from the local machine today: the routes that run before authentication (`/v1/approval-challenges/{id}/assertion`, `/v1/agentmail/webhook/*`, `/v1/federation/envelopes`, `/v1/federation/directory/*`, `http-server.mjs:163-341`) and every bearer-only route (`/v1/endpoint-tokens`, `/v1/identities`, `/v1/capability-grants`, `/v1/envelopes`). An agent `relay_token` leaked from an identity file would become usable from any device. `relay up --public-origin` prints this exact table.

The proxy must pass `Set-Cookie` through unchanged, including `__Host-` cookies, and must forward `Origin` and `Host` unchanged, because the CSRF check below compares `Origin` and a proxy that drops it makes every cookie POST fail closed with 403. `sigil-rooms-web` itself does not proxy; the 4b-1 decision that the relay serves no static files stands. The deployment note requires a dedicated hostname, because cookies are not isolated by port (RFC 6265 §8.5).

- The relay derives its browser-origin allowlist (HTTP CORS and the stream `Origin` check) from `--public-origin`. A separate `--browser-origin` is still accepted for the Vite dev server only.
- **Mode signal.** `--public-origin` is a relay flag, and `sigil-rooms-web` is a separate process whose `config.json` carries only `relayUrl` and `streamUrl` (`serve/server.mjs:50-52`), which `loadConfig` requires (`config.ts`). The static server therefore takes `--auth-mode cookie|token` (default `token`), and `config.json` gains `authMode`. In `cookie` mode `relayUrl` and `streamUrl` are not required and are ignored. Probing a relative request cannot work as the signal: the static server answers any extensionless path, `/v1/auth/me` included, with `index.html` and status 200 (`serve/server.mjs:59-65`). `sigil-rooms-web` is started with the same mode as the relay's `--public-origin`, and the deployment note says so.
- In `cookie` mode the client uses relative URLs and builds the stream URL from the page: `wss://${location.host}/v1/stream`.
- Loopback keeps working: with no `--public-origin`, the relay behaves as today and the SPA offers the pasted-token form. The cookie flow is enabled only when `--public-origin` is set.
- **Dev server.** Cookie mode cannot run on the Vite dev origin: `__Host-` needs HTTPS, `credentials: 'same-origin'` sends no cookie cross-origin, and CORS allows only `authorization, content-type` and `GET, POST` (`browser-cors.mjs:21-22`). Development of the login pages uses the proxied topology (the e2e harness) or token mode.
- `__Host-` and `Secure` need HTTPS, so the e2e harness runs behind a loopback TLS certificate and the proxy table above.

### Web client contract

In `cookie` mode `createClient` (`packages/sigil-rooms-web/src/api/client.ts:37-47`) no longer requires a bearer token. It sends `credentials: 'same-origin'` and `X-Sigil-CSRF: 1` on every non-GET request. Today the SPA treats "has a token" as "is logged in" in five places: `App.tsx:82` renders `TokenGate` when `!token`, `useLive.ts:12` returns when `!token`, `AuthContext` exposes `token` as the session flag, `RoomList.tsx:41` always mounts `NewRoomForm`, and `RoomHeader.tsx:16,27` always shows Stop. `getSender()` is still sessionStorage filled on the first send (`useSend.ts:73`). In `cookie` mode:
- `AuthContext` holds a session object from `GET /v1/auth/me` (`{ human_id, endpoint_id, display_name, is_operator }`) instead of a token, and every consumer above reads "has session" from it. `endpoint_id` comes from `/v1/auth/me`, replacing `getSender()`, so `isManager` is right before the first send.
- `useLive` connects after `GET /v1/auth/me` succeeds.
- A path switch in `App.tsx` renders `/login` and `/invite` pages. `/invite` reads the token from the URL fragment and posts it to `start`.
- Create room and Stop room are hidden when `is_operator` is false, and the roster hides the invocation-mode control from non-owners. The server enforces both regardless.
- Any 401 returns the client to the login page. The token path stays for `token` mode.

`/v1/auth/me` returns `{ human_id, endpoint_id, display_name, is_operator }`. `is_operator` is true when the session's human owns the `--room-human-identity` endpoint (the foundation's definition of the operator). `display_name` falls back through: the `human_attributes` name, then `endpoints.display_name`, then the endpoint id. The seed writes no `human_attributes` row for the operator and `--self` skips provisioning, so for the operator the fallback is normally `endpoints.display_name`. The plan does not need to backfill an attribute.

## Components

### Provider interface

`sigil/relay/v1/oauth/providers/github.mjs` (a second file per provider later):

```
authorizeUrl({ state, nonce, codeChallenge, redirectUri }) -> string
exchangeCode({ code, codeVerifier, redirectUri }) -> { accessToken, idToken? }
resolveIdentity({ accessToken, idToken?, expectedNonce }) -> { issuer, subject, displayName?, email?, emailVerified? }
```

- Every authorize URL carries `code_challenge_method=S256`. A unit test pins the parameter, and `plain` is never offered.
- **GitHub.** No `id_token`. Scope `read:user`. `resolveIdentity` calls `GET /user`. `subject` is the numeric account `id` as a string, never `login`. The issuer is the fixed string `https://github.com`. Email is not fetched and not used.
- Provider configuration (endpoints, `client_id`, `client_secret` from the environment or Doppler) lives in relay configuration, not in `oidc_issuer_allowlist`. Putting GitHub in that allow-list would make `POST /v1/auth/login` attempt OIDC discovery against github.com.
- The callback uses the provider stored on the flow, not the path segment. All provider fetches use `outboundFetchOptions`. No provider URL is read from a request. The fake-IdP tests override endpoints through a test-only option guarded like `--enable-mock-oidc`.

### Flow state

`start` creates flow state `{ state, nonce, pkceVerifier, provider, inviteId? }` in a process-local, TTL'd (10 minutes), single-use store modeled on `ticket-store.mjs`. It is keyed by the SHA-256 of a 256-bit random value that `start` also sets as the cookie `__Host-sigil_oauth` (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`).

`callback` requires that cookie, looks up the flow by it, requires an exact `state` match, deletes the entry, and clears the cookie. This binds the flow to the browser that started it, which closes login CSRF and forced linking (RFC 6749 §10.12, RFC 9700 §2.1). A relay restart mid-login costs one retry, the same stance tickets take. There is no `oauth_flows` table.

### Routes

New file `sigil/relay/v1/oauth-routes.mjs` exporting two handlers, placed differently:

- `handleOAuthPublicRoute` (`start` and `callback`) runs **before** the authentication gate, beside the other pre-gate routes (health, the AgentMail webhook, federation). `handleRoomRoute` is the wrong model for these: it runs after `authenticateRequest`, and a missing principal is already a 401 at `http-server.mjs:344-347`, so dispatching start and callback "the way `handleRoomRoute` is" would make them unreachable.
- `handleOAuthSessionRoute` (`logout` and `me`) runs **after** the composed authenticator, on cookie principals.

Before the gate:

- `POST /v1/auth/oauth/{provider}/start`. The invite token is **optional** in the body. With one, `start` validates it and redirects to `/login?error=invite_expired` without contacting the provider if it is unknown or expired. Without one, the flow starts for a returning user. A form POST then `302` to the provider keeps the invite out of query strings. An unknown provider returns `404`. `start` is unauthenticated, so the cookie-CSRF rule below does not cover it, and it needs its own check: it requires `Origin` to equal `--public-origin` (a browser form POST sends `Origin`) and rejects a request whose `Sec-Fetch-Site` is present and not `same-origin`, with `403`. Without this, a hostile page could auto-submit `start` with an invite token the attacker holds, the victim's browser would receive the flow cookie and consent silently at the provider, and the callback would link the **victim's** provider identity to the attacker-chosen invite. The flow cookie stops callback injection, not that.
- `GET /v1/auth/oauth/{provider}/callback?code=&state=`, or `?error=` from the provider, which maps to `/login?error=denied` before any code exchange.

After the gate, on cookie principals:

- `POST /v1/auth/logout` revokes the session row and closes that session's stream sockets. It sends `Set-Cookie: __Host-sigil_session=; Max-Age=0; Secure; Path=/; HttpOnly; SameSite=Lax`. A `__Host-` cookie set without `Secure` and `Path=/` is ignored by browsers, and without `Path` the default path here would be `/v1/auth`, so a bare `Max-Age=0` deletes nothing. The callback clears `__Host-sigil_oauth` the same way.
- `GET /v1/auth/me` as above.

### Callback decision

After `resolveIdentity`, in this order:

1. Look up `(issuer, subject)` in `oidc_identities`, considering only rows with `verified_via = 'oauth'`. A row with `verified_via` null is **not** an identity for login purposes (below).
   - Active, human active: **log in** as the identity's stored `endpoint_id`. No invite is needed and any invite on the flow is ignored and not consumed.
   - Any other state (`suspended`, `unlinked`, `revoked`) or an inactive human: `denied`. It never falls through to linking.
2. No verified row, and the flow carries an unconsumed, unexpired invite: **link and log in** (below).
3. No verified row, no usable invite: `invite_required`.

**Unproven rows do not reserve an identity.** `POST /v1/identities` accepts a claim with no proof (`http-server.mjs:571-594`), and `(issuer, subject)` is the table's primary key (`003_plugin_connector_auth.sql:21`). A planted row for a victim's `sub` would lock that victim out of redemption, and neither marking it revoked (the key stays taken, and step 1 denies every non-active state) nor deleting it (an `account_links` row can reference it, `003:78`, and `POST /v1/account-links` accepts self-reported ceremony fields) clears it. So rows with `verified_via IS NULL` are treated as nonexistent at login, and a successful link deletes any such row for the same `(issuer, subject)`, together with the `account_links` rows that reference it, inside the linking transaction. Nothing a bearer holder plants can block a proven login. This removes the `identity clear` command, the `oidc_identity.cleared` event, and the `--self` upgrade branch, which only existed to work around planted rows. GitHub rows cannot be planted at all, since GitHub is not in `oidc_issuer_allowlist` and the route rejects other issuers (`http-server.mjs:578`).

**Linking transaction.** It opens after the outbound calls finish and never spans them. It runs on one client and does, in order:

1. Lock the creator's membership rows for every invite room in one statement ordered by `conversation_id` (`SELECT m.* FROM conversation_members m JOIN endpoints e ON e.endpoint_id = m.endpoint_id WHERE e.owner_id = $creator AND m.conversation_id = ANY($rooms) AND m.removed_at IS NULL ORDER BY m.conversation_id FOR UPDATE OF m`) and re-check that the creator is still a manager of each. If not, abort `invite_expired`. This removes the check-then-act race with a concurrent removal, and the ordering keeps two redemptions with overlapping rooms from deadlocking. Membership is keyed by endpoint while the invite stores `created_by_human_id`, so the join through `endpoints.owner_id` is the lookup.
2. Consume the invite with `UPDATE room_invites SET consumed_at = now WHERE invite_id = $1 AND consumed_at IS NULL AND expires_at > now`, aborting on zero rows. Two concurrent redemptions cannot both pass.
3. `--self` invite: skip provisioning and room membership. The target is the invite's `self_endpoint_id` and its owner human, which must be active, and the redeeming identity must match the invite's pin: `(issuer, subject)` equal to `(self_issuer, self_subject)`. Otherwise call `provisionHumanTx` (source = the provider name, verification `unverified`) and `addHumanToRoomTx` for each `room_invite_rooms` row, with the invite's creator as `actorHumanId`.
4. Delete unproven `oidc_identities` rows for this `(issuer, subject)`: first their `account_links` rows (the FK at `003_plugin_connector_auth.sql:78` has no `ON DELETE`, so the identity row cannot go first), then the `oidc_identities` rows. Then insert the verified `oidc_identities` row with `verified_via = 'oauth'` and the login `endpoint_id`, **on the same client**. Today `createOidcIdentity` uses the pool (`postgres-repository.mjs:1003`) and its audited variant opens its own transaction (`:1299`), so called here the insert would run on a different connection that cannot see the human `provisionHumanTx` just created: it would fail the foreign key, or for an existing human commit independently of the rest. The work adds `createOidcIdentityTx(client, …)`, the audited wrapper delegates to it, and session creation and revocation get the same `…Tx(client, …)` form.
5. Create the session (`createHumanSessionTx(client, …)`).
6. Write audit events.

After the transaction commits the callback sends the `302`. There is nothing to register with the relay: the browser's first post reads the new endpoint from Postgres through `lookupTrustedEndpoint`, so it cannot race a missing entry.

### Invites

- Created by the operator through the CLI (`sigil relay invite create --name <name> --room <id>:<role> ...`) or through `POST /v1/auth/invites` (bearer only, operator only). The route is not under `/v1/rooms/`, which is already the browser-cookie namespace. v1 ships no browser "Invite person" dialog, since the web client holds no bearer token in cookie mode.
- Creation validates that each `role` is `member` or `room_manager` and that the creator is a manager of every listed room. The CLI process takes `--room-key-wrap-key` and `--identity` itself (see the foundation's CLI section) and checks the wrap key locally, since a separate process cannot see the relay's configuration. The HTTP route checks the relay's own.
- Bootstrap for the operator: `sigil relay invite create --self --provider github --login <name>` produces a 10-minute invite bound to the operator's own human and `--room-human-identity` endpoint, **and pinned to one provider identity**. Without the pin, whoever completes the flow first within 10 minutes is bound to the operator's account permanently (decision step 1 then logs them in with no invite), which grants room creation, every owner-only agent, and further invites, and a URL fragment can leak through chat, shell history, or browser history. The operator names themselves in a form they already know, and never handles a raw `sub`:
  - `--provider github --login <name>`: the CLI resolves the account's numeric `id` with `GET https://api.github.com/users/<name>` (using `outboundFetchOptions`, unauthenticated) at creation time and stores `self_issuer = https://github.com` and `self_subject = <id>`. A later rename does not matter, since the immutable id is what is pinned. A failed or ambiguous lookup aborts creation.
  - Any other identity completing the flow gets `denied`, and the invite is not consumed.
  The command exists only through the CLI. There is no target parameter on the HTTP route, so a bearer holder cannot target another human's account.
- The link is `<public-origin>/invite#<token>`. The fragment is never sent to a server. The page posts the token to `start`. Only the token's SHA-256 is stored. Auth pages send `Referrer-Policy: no-referrer`. Expiry is 24 hours (10 minutes for `--self`).
- **Revocation.** `sigil relay invite list` shows each invite's name, rooms, expiry, and state (open, consumed, revoked, expired). `sigil relay invite revoke <invite_id>` sets `revoked_at`. Redemption's consume `UPDATE` adds `AND revoked_at IS NULL`, so a revoked invite fails like an expired one (`invite_expired`). Revoking a consumed invite is a no-op: it does not undo the link, which is `identity revoke`'s job.
- A person who already has a linked identity logs in with no invite (decision step 1). Adding an existing person to another room is an operator action (`sigil relay human add-to-room`), not an invite.

### Browser session

- Extends `human_sessions` rather than adding a table. New columns are all **nullable**: `endpoint_id`, `last_seen_at`, `identity_issuer`, `identity_subject`. `/v1/auth/login`'s step-up insert (`createHumanSession`, `assertAssurance`) keeps working unchanged. OAuth rows set `session_id = sha256(cookie value)`, `authentication_method` of `oauth_github`, and `assurance = 'standard'`.
- No separate absolute-expiry column: `expires_at` is the absolute 7-day cap, and idle expiry (8 hours) is `last_seen_at`. `last_seen_at` is written only when the stored value is more than 5 minutes old.
- The cookie authenticator accepts a row only when `endpoint_id IS NOT NULL` and `authentication_method` is `oauth_github`, so step-up rows are never usable as cookies.
- Cookie `__Host-sigil_session`: `HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`. The value is 256 random bits, generated the same way as the flow cookie and the ws-ticket (`ticket-store.mjs:22`), and only its SHA-256 is stored, so the cookie is as strong as the bearer it becomes.
- **Sockets follow the session, not just the human.** The ws-ticket strips session identity today and keeps only endpoint, owner, and human (`ticket-store.mjs:17`), and the stream server indexes browser sockets by endpoint (`stream-server.mjs:42`). Eight-hour idle expiry, seven-day absolute expiry, logout, and identity revocation would then govern HTTP only, and an idle socket would keep receiving `room.updated` indefinitely. The ticket carries `session_id`, the stream server indexes browser sockets by it, and `closeSession(session_id, code)` closes them. Logout, session revocation, and identity revocation call it. The stream server re-validates each live browser socket's session (expiry, idle window, identity status) on the same once-a-minute pass the foundation specifies for the human check, and closes it when the session is gone.
- Login revokes any session the browser presented, then issues a new id.
- `oidc_identities` gains `verified_via TEXT` and `endpoint_id TEXT` (both nullable). A returning login uses the identity's stored `endpoint_id`, so a human who owns several endpoints always lands on the same one. Revoking an identity revokes every session carrying its `(identity_issuer, identity_subject)` in the same transaction.
- Session lookup joins `humans.status`, endpoint status, and identity status on every request, through the foundation's cache. Suspension or identity revocation ends the session.

### Credential types and allowlist

A new authenticator composes bearer and cookie. It returns `{ endpoint_id, owner_id, human_id?, credential: 'bearer' | 'cookie' }` and is built outside `createBearerAuthenticator`, which has no repository or URL. A cookie principal is accepted only when `isBrowserRoute(path)` is true or the path is `/v1/auth/me`, `/v1/auth/logout`, or `GET /v1/mentions`. That reuses the one existing route list. `isBrowserRoute` and the CORS helper gain the two `/v1/auth/` paths. On every other route a cookie counts as no credential, so `/v1/endpoint-tokens`, `/v1/identities`, grants, and `/v1/auth/invites` stay bearer-only and return 401.

### CSRF

Cookie-authenticated non-GET requests must send `X-Sigil-CSRF: 1` and an `Origin` header exactly equal to `--public-origin`, enforced in the gate helper beside `browser-cors.mjs`. Anything else returns `403`. The WebSocket keeps the single-use ticket from 4a, issued only through these checked routes.

## Errors and abuse handling

- Callback failures redirect to `/login?error=<code>` with one of `denied`, `invite_required`, `invite_expired`, or `provider_error`. The page never reveals whether an identity is linked.
- Post-login destinations come from a fixed server-side path. No parameter selects a redirect target.
- Rate limiting reuses `reserveRateLimit`, which inserts into `quota_usage` (`postgres-repository.mjs:798-807`). `quota_usage.scope_kind` is constrained by `quota_usage_scope_kind_check`, last replaced in `018_federation_directory.sql:85-93` (the `007_rate_quota.sql:5` constraint is long dead). This spec's migration drops that constraint and re-adds it with all eleven existing values (`endpoint`, `owner`, `conversation`, `directory_invite_create`, `directory_invite_redeem`, `directory_match_create`, `directory_match_attempt`, `federation_origin`, `federation_directory_invite_create`, `federation_directory_redeem`, `federation_directory_redemption_inbound`) plus `invite`, `oauth_provider_subject`, and `oauth_start`. Listing fewer makes every federation rate-limit insert fail the CHECK. The relay listens on `127.0.0.1`, so behind the proxy every request has the same remote address, and per-IP keying would be one shared bucket any peer could exhaust. The flow cookie is not a usable key: `start` mints it, so every anonymous request arrives with a fresh one. The limits, by what an attacker cannot inflate:
  - With an invite: per `invite_id` on `start` and on the callback.
  - After the provider callback verifies an identity: per `(issuer, subject)` on login attempts.
  - A global ceiling on `start`, sized for memory bounds on the flow store (which is also capped in entries). **This ceiling is a shared bucket**: any tailnet peer can exhaust it and block every login, the operator's included. That is an accepted v1 denial-of-service on a private tailnet, stated here and not hidden. `invite create --self` flows are exempt from the ceiling so the operator can always bootstrap. A `--trusted-proxy` setting is required before keying anything on `X-Forwarded-For` or `Tailscale-User-Login`, and keying on those is the hardening step the public-tunnel spec owns.
- Provider tokens, secrets, and codes never appear in logs or audit rows.
- `audit_events.subject_id` is NOT NULL (`001_initial.sql:165`), so every event below names one. `oauth_login.success`, `invite.redeemed`, and `oidc_identity.unproven_removed` use the human id. `invite.created` uses the creating human id. `oauth_login.denied` has no matched human, so its `subject_id` is `provider:<issuer>#<sha256(subject) hex>` when the provider verified an identity, and `flow:<flow_id>` when it failed earlier. Audit events: `oauth_login.success`, `oauth_login.denied`, `invite.created`, `invite.redeemed`, `oidc_identity.unproven_removed` (an unproven row deleted by a successful link), plus the existing `human_session.*` events.

## Data

One migration (next free number on `main`):

- `room_invites(invite_id PRIMARY KEY, token_hash NOT NULL UNIQUE, name NOT NULL, created_by_human_id NOT NULL REFERENCES humans, self_endpoint_id, self_issuer, self_subject, created_at NOT NULL, expires_at NOT NULL, consumed_at, consumed_by_human_id, revoked_at)`. A CHECK requires `self_issuer`, `self_subject`, and `self_endpoint_id` to be all null or all set. On a `--self` invite `self_subject` is resolved at creation and the pair pins the redeeming identity. The token is at least 128 random bits.
- `quota_usage_scope_kind_check` dropped and re-added with the eleven values from `018` plus `invite`, `oauth_provider_subject`, and `oauth_start` (see Rate limiting).
- `room_invite_rooms(invite_id REFERENCES room_invites, room_id REFERENCES rooms(conversation_id), role CHECK (role IN ('member','room_manager')), PRIMARY KEY (invite_id, room_id))`.
- `human_sessions`: `endpoint_id`, `last_seen_at`, `identity_issuer`, `identity_subject` (all nullable).
- `oidc_identities`: `verified_via TEXT CHECK (verified_via IN ('oauth'))` and `endpoint_id` (both nullable). Step 4 and the unproven-row rule depend on the exact value, so the CHECK keeps it from drifting.
- **Composite foreign keys.** On both `oidc_identities` and `human_sessions`, `FOREIGN KEY (endpoint_id, human_id) REFERENCES endpoints (endpoint_id, owner_id)` (the target is `UNIQUE (endpoint_id, owner_id)` in `001`). With the default `MATCH SIMPLE` a null `endpoint_id` skips the check, so step-up rows keep working. A row can then never name an endpoint its human does not own. `endpoints.owner_id` is `TEXT NOT NULL REFERENCES humans(human_id)` (`001_initial.sql:22`) and `UNIQUE (endpoint_id, owner_id)` exists (`001_initial.sql:30`), so the target is valid and needs no extra index. The migration adds `oidc_identities.endpoint_id` and `human_sessions.endpoint_id` before the keys.
- `human_sessions` gets an index on `(identity_issuer, identity_subject)` for the revoke-by-identity sweep.

OAuth login requires Postgres, like the federation routes. Without a database the routes return `501`. The memory repository has no identity storage and only undo-based transactions, so supporting it would multiply the surface for no user.

## Configuration

- `--public-origin <https url>`: redirect-URI base, cookie scope, CSRF origin, and browser-origin allowlist. Required to enable OAuth login.
- `--room-key-wrap-key <ref>`: from the foundation spec. `--public-origin` requires it.
- `--room-human-identity <path>`: from the foundation spec. `--public-origin` requires it, since without an operator there is nobody to create rooms or invites and `is_operator` is always false.
- `sigil-rooms-web --auth-mode cookie|token`: set to `cookie` when the relay runs with `--public-origin`.
- Provider `client_id` and `client_secret` from the environment or Doppler, separate per provider.
- `relay up` help text documents all of these, plus the proxy table.

## Testing

- Provider unit tests against a fake IdP and a fake GitHub API on local ports, including the `S256` parameter. A flow whose `code_challenge_method` is not `S256` is never produced.
- Routing: `start` and `callback` are reachable with no credential (they run before the gate), and `me` and `logout` return 401 without one.
- `start` CSRF: a POST with a foreign `Origin`, with no `Origin`, or with `Sec-Fetch-Site: cross-site` returns 403 and sets no flow cookie.
- Flow: missing or wrong flow cookie, state mismatch, replayed code, expired flow, provider `?error=`.
- Invite: reused, expired, two concurrent redemptions (Postgres race test), a creator removed from a room mid-redemption, an invite naming several rooms with different roles, two redemptions with overlapping rooms in opposite order (no deadlock), `--self` creating no second human, a `--self` invite redeemed by an identity other than the pinned one (`denied`, invite not consumed), a GitHub login lookup that fails or returns no id, a revoked invite (`invite_expired`, a concurrent revoke and redeem cannot both win), and `invite list` states.
- First contact end to end: an invite redemption provisions the human, inserts the verified identity, and creates the session in one transaction on one client. `human_attributes` accepts the row (`verification_state = 'unverified'`), and a failure at any step leaves no human, endpoint, key, identity, or session and does not consume the invite.
- Identity: unlinked without an invite (`invite_required`), linked without an invite (logs in, invite not consumed), a returning user after logout and after the 7-day expiry, revoked identity, suspended human, a multi-endpoint human landing on the stored endpoint. **Planted rows**: a row planted through `POST /v1/identities` for a victim's `sub` does not block that victim's normal invite redemption, and the redemption deletes the planted row and its `account_links`. A planted row with an `account_links` reference does not make the delete fail.
- Schema: inserting an identity or session whose `endpoint_id` belongs to a different human fails the composite foreign key, and a step-up row with null `endpoint_id` inserts.
- Session: step-up rows are rejected as cookies, `/v1/auth/login` still works with the new columns, revoking an identity revokes its sessions. Logout, session expiry, and identity revocation close that session's stream sockets, and an idle socket does not outlive its session.
- CSRF and credential: wrong `Origin`, missing header, a cookie on `/v1/endpoint-tokens`, `/v1/identities`, and `/v1/auth/invites` (all 401), idle and absolute expiry, logout, login revoking the presented session.
- Suspension ends the session and closes the stream socket, for every endpoint the human owns.
- Proxy: a POST to `start` and a WebSocket upgrade both succeed through the web origin, `Set-Cookie` with `__Host-` survives the proxy, and `Origin` and `Host` arrive unchanged. `/v1/endpoint-tokens`, `/v1/identities`, `/v1/envelopes`, and `/v1/federation/*` are not reachable through the proxy.
- Web client: in `cookie` mode the SPA shows the login page with no session, loads after `GET /v1/auth/me`, hides Create room and Stop for a non-operator, and never reads `getSender()`. In `token` mode nothing changes.
- Rate limits: the new `scope_kind` values insert without a CHECK violation, a flow-store entry cap holds, and a `--self` flow is not blocked by an exhausted global `start` ceiling.
- End to end on Postgres, in the one-origin topology behind a loopback certificate: invite redeemed, invitee posts a signed message from the composer, owner sees it, and the router's answer from an owner-only agent is refused for the invitee.
- Real GitHub cannot be automated. A manual smoke checklist ships with the plan.

## Out of scope

- Google, X, Meta, and Microsoft providers (Google is designed below).
- Browser-held signing keys.
- Public-internet hardening for the tunnel step: bot protection, tighter limits, account recovery. A separate spec precedes that step.
- CLI and agent login.
- A browser invite dialog.
- Multi-tenant sign-up.

## Deferred: Google

Not built in v1. Notes so the addition is mechanical:

- Issuer `https://accounts.google.com`, scopes `openid email profile`. `verifyRealIdToken` is exported from `oidc-client.mjs` (`peer-discovery.mjs` switches to the export) and gains `expectedNonce` and `issuerAliases`.
- Google may emit `iss` as `accounts.google.com` without a scheme. `iss` is inside the signed payload, and `normalizeIssuer` rejects a value `new URL` cannot parse (`issuer-normalization.mjs:22-23`), so `issuerAliases` maps an accepted raw `iss` to its canonical form after signature verification. Only `{ 'accounts.google.com': 'https://accounts.google.com' }` is accepted.
- `--self` pin: `--provider google --email <address>` stores `self_issuer` and a new `self_email`. Redemption requires `email_verified = true` and a case-insensitive match, then records the token's `sub`.
- Adds `authentication_method = 'oauth_google'`, a Google redirect URI check for the Tailscale hostname, and tests for the alias, nonce, and email pin.

## v1 behavior to state

- A second provider for an existing person creates a second human. There is no merge in v1.
- CLI membership and role changes reach open browser sessions through the foundation's `NOTIFY` payload (`room_ids`), which pushes roster updates.

## Module placement

New commands and repository methods go in new modules, not into `sigil.mjs` (1815 lines), `postgres-repository.mjs` (2330), or `http-server.mjs` (1126). The plan wires them in with the smallest possible edit to those files and does not refactor them.

## Open items for the plan

1. Confirm GitHub accepts the Tailscale hostname as an OAuth callback URL. If not, a domain the operator owns is the fallback.
2. Confirm `human_sessions` accepts the nullable columns without disturbing `/v1/auth/login`'s step-up rows, and that `createHumanSession` can take the extra fields.
3. Confirm `endpoints.display_name` is populated for the operator's seeded endpoint (the seed writes it), since `/v1/auth/me` falls back to it. `is_operator` is derived as "the session's human owns the `--room-human-identity` endpoint".
4. Confirm that `GET https://api.github.com/users/<name>` is reachable from the operator's machine at `invite create` time (unauthenticated calls are rate limited to 60 an hour), and that the plan's first task confirms `createHumanSession` and the other session functions can take a client for the `…Tx` forms.
