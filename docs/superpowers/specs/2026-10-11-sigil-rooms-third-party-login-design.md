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
- Foundation: `provisionHumanTx`, `addHumanToRoomsTx`, `lookupTrustedEndpoint`, suspension, `NOTIFY`.

## Origin topology

The browser sees one origin, `--public-origin`, so cookies are same-origin and no credentialed CORS is needed. Today the relay HTTP server, the stream server (`port + 1`, path `/v1/stream`), and `sigil-rooms-web` each listen on `127.0.0.1` (`sigil.mjs:336,439`, `sigil-rooms-web.mjs:33`), and the web server rejects POST. Tailscale peers reach none of them directly.

**Required deployment:** a TLS-terminating proxy (Tailscale Serve, or equivalent) on the `--public-origin` hostname that forwards two things:

| Path | Backend |
| --- | --- |
| `/v1/*`, including the `/v1/stream` WebSocket upgrade | cookie-only listener |
| everything else | `sigil-rooms-web` static server |

The proxy is not the security boundary. Without a second listener, forwarding `/v1/*` would expose to every tailnet device what is reachable only from the local machine today: the routes that run before authentication (`/approve`, `/v1/health`, `/v1/approval-challenges/{id}/assertion`, `/v1/agentmail/webhook/*`, `/v1/federation/envelopes`, `/v1/federation/directory/*`, `http-server.mjs:149-341`) and every bearer-only route (`/v1/endpoint-tokens`, `/v1/identities`, `/v1/capability-grants`, `/v1/envelopes`). An agent `relay_token` leaked from an identity file would become usable from any device. Keeping those off with a hand-written proxy path table is a convention an operator can get wrong, and a single `/v1` mount is the natural Tailscale Serve setup. The relay therefore opens a second HTTP listener (`--public-port`, default `port ? port + 2 : 0`, bound to `127.0.0.1`) whose dispatch table **is** the allowlist, enforced in code before any handler runs:

- `POST /v1/auth/oauth/{provider}/start` and `GET /v1/auth/oauth/{provider}/callback` (`handleOAuthPublicRoute`, no credential).
- `GET /v1/auth/me` and `POST /v1/auth/logout` (`handleOAuthSessionRoute`).
- `/v1/rooms`, `/v1/rooms/*`, and `GET /v1/mentions` (`handleRoomRoute`).
- The ticket-only stream upgrade at `/v1/stream` (below).

Every other method and path returns 404 on the public listener. It matches on the parsed pathname (`new URL`, with `..` segments resolved) against exact segments, never a raw `request.url` prefix, so a path variant cannot reach a handler outside the list. Each listener has exactly one credential type: the main listener stays bearer-only as today, and the public listener authenticates cookies only and ignores `Authorization`. A cookie sent to the main port is no credential.

The stream server does not satisfy that on its own. An upgrade without a `ticket` falls through to the bearer authenticator (`stream-server.mjs:71`, built from `tokenHashes` at `sigil.mjs:327`), which accepts `Authorization: Bearer` or the `sigil-bearer.` subprotocol, and a client that sends no `Origin` skips the origin check. A leaked agent `relay_token` would open a socket through the proxy and, as the newest socket, take over that agent's `delivered`, `resend`, and `sequence_reset` frames. The public listener therefore carries a **ticket-only stream endpoint** at `/v1/stream`. The same `createStreamServer` instance attaches a second upgrade handler to the public listener, so the socket indexes and `notify*` paths are shared, but that handler has no bearer authenticator, requires `Origin` equal to `--public-origin`, and closes any upgrade without a valid `ticket` with 1008. The bearer stream server on `port + 1` stays loopback-only for agents and local clients.

`relay up --public-origin` prints the proxy table and the cookie-only listener address.

The proxy must pass `Set-Cookie` through unchanged, including `__Host-` cookies, and must forward `Origin` and `Host` unchanged, because the CSRF check below compares `Origin` and a proxy that drops it makes every cookie POST fail closed with 403. `sigil-rooms-web` itself does not proxy; the 4b-1 decision that the relay serves no static files stands. The deployment note requires a dedicated hostname, because cookies are not isolated by port (RFC 6265 §8.5).

- The relay derives its browser-origin allowlist (HTTP CORS and the stream `Origin` check) from `--public-origin`. A separate `--browser-origin` is still accepted for the Vite dev server only.
- **Mode signal.** `--public-origin` is a relay flag, and `sigil-rooms-web` is a separate process whose `config.json` carries only `relayUrl` and `streamUrl` (`serve/server.mjs:50-52`), which `loadConfig` requires (`config.ts`). The static server therefore takes `--auth-mode cookie|token` (default `token`), and `config.json` gains `authMode`. In `cookie` mode `relayUrl` and `streamUrl` are not required and are ignored. Probing a relative request cannot work as the signal: the static server answers any extensionless path, `/v1/auth/me` included, with `index.html` and status 200 (`serve/server.mjs:59-65`). `sigil-rooms-web` is started with the same mode as the relay's `--public-origin`, and the deployment note says so.
- In `cookie` mode the client uses relative URLs and builds `streamUrl` from the page as `wss://${location.host}`. `LiveSocket` appends `/v1/stream` itself (`socket.ts:62`). The static server builds its CSP `connect-src` from `relayUrl` and `streamUrl` (`serve/server.mjs:28`), which cookie mode ignores, so in cookie mode it is `connect-src 'self' wss://<host of --public-origin>`.
- Loopback keeps working: with no `--public-origin`, the relay behaves as today and the SPA offers the pasted-token form. The cookie flow is enabled only when `--public-origin` is set.
- **Dev server.** Cookie mode cannot run on the Vite dev origin: `__Host-` needs HTTPS, `credentials: 'same-origin'` sends no cookie cross-origin, and CORS allows only `authorization, content-type` and `GET, POST` (`browser-cors.mjs:21-22`). Development of the login pages uses the proxied topology (the e2e harness) or token mode.
- `__Host-` and `Secure` need HTTPS, so the e2e harness runs behind a loopback TLS certificate and the proxy table above.

### Web client contract

In `cookie` mode `createClient` (`packages/sigil-rooms-web/src/api/client.ts:37-47`) no longer requires a bearer token. It sends `credentials: 'same-origin'` and `X-Sigil-CSRF: 1` on every non-GET request. Today the SPA treats "has a token" as "is logged in" in five places: `App.tsx:82` renders `TokenGate` when `!token`, `useLive.ts:12` returns when `!token`, `AuthContext` exposes `token` as the session flag, `RoomList.tsx:41` always mounts `NewRoomForm`, and `RoomHeader.tsx:16,27` always shows Stop. `getSender()` is still sessionStorage filled on the first send (`useSend.ts:73`). In `cookie` mode:
- `AuthContext` holds a session object from `GET /v1/auth/me` (`{ human_id, endpoint_id, display_name, is_operator }`) instead of a token, and every consumer above reads "has session" from it. `endpoint_id` comes from `/v1/auth/me`, replacing `getSender()`, so `isManager` is right before the first send.
- `useLive` connects after `GET /v1/auth/me` succeeds.
- A path switch in `App.tsx` renders `/login` and `/invite` pages. `/invite` reads the token from the URL fragment and posts it to `start`.
- Create room is hidden when `is_operator` is false, and the roster hides the invocation-mode control from non-owners. The header shows **Stop room** to the operator and **Stop my runs** to everyone else. Both call `POST /v1/rooms/{id}/stop`, and the server cancels only the invocations the caller owns or started (the foundation's rule), so the label states what the button does. The server enforces all of it regardless.
- Any 401 returns the client to the login page. The token path stays for `token` mode.

`/v1/auth/me` returns `{ human_id, endpoint_id, display_name, is_operator }`. `is_operator` is true when the session's human owns the `--room-human-identity` endpoint (the foundation's definition of the operator). `display_name` is `endpoints.display_name`, which provisioning sets to the operator-chosen name (the invite's `name`, or `human add --name`). `human_attributes` rows are provenance and are never read for display. The seed writes `endpoints.display_name` for the operator's endpoint, so the plan needs no backfill.

## Components

### Provider interface

`sigil/relay/v1/oauth/providers/github.mjs` (a second file per provider later):

```
authorizeUrl({ state, nonce, codeChallenge, redirectUri }) -> string
exchangeCode({ code, codeVerifier, redirectUri }) -> { accessToken, idToken? }
resolveIdentity({ accessToken, idToken?, expectedNonce }) -> { issuer, subject, displayName?, email?, emailVerified? }
```

- Every authorize URL carries `code_challenge_method=S256`. A unit test pins the parameter, and `plain` is never offered.
- **GitHub.** No `id_token`. No scope: `GET /user` returns the public numeric `id` without one, and `read:user` would ask for more consent than the flow uses. `resolveIdentity` calls `GET /user`. `subject` is the numeric account `id` as a string, never `login`. The issuer is the fixed string `https://github.com`. Email is not fetched and not used.
- Provider configuration (endpoints, `client_id`, `client_secret` from the environment or Doppler) lives in relay configuration, not in `oidc_issuer_allowlist`. Putting GitHub in that allow-list would make `POST /v1/auth/login` attempt OIDC discovery against github.com.
- The callback uses the provider stored on the flow, not the path segment. All provider fetches use `outboundFetchOptions`. No provider URL is read from a request. The fake-IdP tests override endpoints through a test-only option guarded like `--enable-mock-oidc`.

### Flow state

`start` creates flow state `{ flow_id, state, nonce, pkceVerifier, provider, inviteId? }`, where `flow_id` is a fresh random id used only for audit, in a process-local, TTL'd (10 minutes), single-use store modeled on `ticket-store.mjs`. It is keyed by the SHA-256 of a 256-bit random value that `start` also sets as the cookie `__Host-sigil_oauth` (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`).

`callback` requires that cookie, looks up the flow by it, requires an exact `state` match, deletes the entry, and clears the cookie. This binds the flow to the browser that started it, which closes login CSRF and forced linking (RFC 6749 §10.12, RFC 9700 §2.1). A relay restart mid-login costs one retry, the same stance tickets take. There is no `oauth_flows` table.

### Routes

New file `sigil/relay/v1/oauth-routes.mjs` exporting two handlers, placed differently:

- `handleOAuthPublicRoute` (`start` and `callback`) runs **before** the authentication gate, beside the other pre-gate routes (health, the AgentMail webhook, federation). `handleRoomRoute` is the wrong model for these: it runs after `authenticateRequest`, and a missing principal is already a 401 at `http-server.mjs:344-347`, so dispatching start and callback "the way `handleRoomRoute` is" would make them unreachable.
- `handleOAuthSessionRoute` (`logout` and `me`) runs **after** the public listener's cookie authenticator, on cookie principals.

Before the gate:

- `POST /v1/auth/oauth/{provider}/start`. The invite token is **optional** in the body. With one, `start` validates it and redirects to `/login?error=invite_expired` without contacting the provider if it is unknown, expired, revoked, or consumed. Without one, the flow starts for a returning user. A form POST then `302` to the provider keeps the invite out of query strings. An unknown provider returns `404`. `start` is unauthenticated, so the cookie-CSRF rule below does not cover it, and it needs its own check: it requires `Origin` to equal `--public-origin` (a browser form POST sends `Origin`) and rejects a request whose `Sec-Fetch-Site` is present and not `same-origin`, with `403`. Without this, a hostile page could auto-submit `start` with an invite token the attacker holds, the victim's browser would receive the flow cookie and consent silently at the provider, and the callback would link the **victim's** provider identity to the attacker-chosen invite. The flow cookie stops callback injection, not that.
- `GET /v1/auth/oauth/{provider}/callback?code=&state=`, or `?error=` from the provider, which maps to `/login?error=denied` before any code exchange.

After the gate, on cookie principals:

- `POST /v1/auth/logout` revokes the session row and closes that session's stream sockets. It sends `Set-Cookie: __Host-sigil_session=; Max-Age=0; Secure; Path=/; HttpOnly; SameSite=Lax`. A `__Host-` cookie set without `Secure` and `Path=/` is ignored by browsers, and without `Path` the default path here would be `/v1/auth`, so a bare `Max-Age=0` deletes nothing. The callback clears `__Host-sigil_oauth` the same way.
- `GET /v1/auth/me` as above.

### Callback decision

After `resolveIdentity`, in this order:

1. Look up `(issuer, subject)` in `oidc_identities`, considering only rows with `verified_via = 'oauth'`. A row with `verified_via` null is **not** an identity for login purposes (below).
   - Active, human active, endpoint active: **log in** as the identity's stored `endpoint_id`. No invite is needed and any invite on the flow is ignored and not consumed. This runs in a transaction that locks the identity row (`SELECT ... FOR UPDATE`) and the human and endpoint rows (`FOR SHARE`), then re-checks identity, human, and endpoint status before it creates the session. The identity lock serializes against `identity revoke`, which updates that row. Suspension updates `humans` and `endpoints` and never touches the identity row, and the session insert's foreign-key check takes only `FOR KEY SHARE`, which does not conflict with an UPDATE's lock. Without the `FOR SHARE` locks a login could insert a session after suspension's session sweep and revive it on `unsuspend`. They conflict with suspension's UPDATE, and suspension updates `humans` first, so it either waits for the login to commit and then revokes that session, or commits first and the login reads `suspended`.
   - A flow that carries a targeted invite whose `target_human_id` differs from this row's human, in any state: `denied`, and the invite is not consumed. Otherwise an operator who opened one of their own guest invite links would be logged in silently as that guest, ignoring the `--self` target.
   - State `revoked`, and the flow carries a usable targeted invite pinned to this `(issuer, subject)` whose target is this row's human: **reactivate and log in** (the reactivation transaction below).
   - Any other state (`suspended`, `unlinked`, or `revoked` with no matching invite) or an inactive human or endpoint: `denied`. It never falls through to linking.
2. No verified row, and the flow carries an unconsumed, unexpired invite: **link and log in** (below).
3. No verified row, no usable invite: `invite_required`.

**Unproven rows.** `POST /v1/identities` accepts a claim with no proof (`http-server.mjs:571-594`), but only for allowlisted issuers (`:578`). GitHub is not in `oidc_issuer_allowlist`, so no GitHub row can be planted, and v1 has no unproven-row handling: step 1 considers only `verified_via = 'oauth'` rows, and the plan adds a startup assertion that no OAuth provider's issuer is in `oidc_issuer_allowlist`. Handling for an allowlisted provider is under Deferred: Google.

**Linking transaction.** It opens after the outbound calls finish and never spans them. It runs on one client and does, in order:

1. **Lock and read the invite.** `SELECT ... FROM room_invites WHERE invite_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now FOR UPDATE`, aborting on zero rows (`invite_expired`). The row lock serializes two redemptions of one invite, and a concurrent revoke against a redeem: the waiting statement re-evaluates its `WHERE` after the winner commits, so they cannot both win. It is the first statement because the later steps need `created_by_human_id`, the `--self` pin, and the room list (`room_invite_rooms`).
2. **Lock the creator's membership rows** for every invite room with the foundation's `lockManagerRows(client, creatorHumanId, roomIds)` (one statement, `ORDER BY m.conversation_id, m.endpoint_id`, `FOR UPDATE OF m`; one room returns several rows because the operator's agents are members too) and re-check that the creator is still a manager of each. If not, abort `invite_expired`. This removes the check-then-act race with a concurrent removal, and the total lock order keeps two redemptions with overlapping rooms from deadlocking. Membership is keyed by endpoint while the invite stores `created_by_human_id`, so the helper joins through `endpoints.owner_id`.
3. **Pin check (targeted invites).** The target is the invite's `target_endpoint_id` and `target_human_id`. Take both rows `FOR SHARE` (so a concurrent suspension serializes, as in the returning-login transaction) and require the human and endpoint to be active, `endpoints.kind = 'human'`, and `(issuer, subject)` equal to `(target_issuer, target_subject)`. A mismatch aborts with `denied` and rolls back, so nothing is consumed.
4. Targeted invite (`--self` or `--human`): skip provisioning, and call `addHumanToRoomsTx` for any `room_invite_rooms` rows (a `--self` invite has none). Otherwise call `provisionHumanTx` with `displayName` = the invite's `name` and `attributes` = the invite name (source `operator`) plus the provider's `displayName` when it returns one (source = the provider name), each `unverified`, then `addHumanToRoomsTx` once with every `room_invite_rooms` row. The invite's creator is `actorHumanId`.
5. Insert the verified `oidc_identities` row with `verified_via = 'oauth'` and the login `endpoint_id`, **on the same client**, and create the session on it. `createHumanSession` already takes a `client` (`postgres-repository.mjs:1065`). `createOidcIdentity` uses the pool today (`:1003`) and its audited variant opens its own transaction (`:1299`), so called here it would run on a different connection that cannot see the human `provisionHumanTx` just created: it would fail the foreign key, or for an existing human commit independently of the rest. The work gives `createOidcIdentity` the same `client` option and the audited wrapper delegates to it.
6. **Consume.** One `UPDATE room_invites SET consumed_at = now, consumed_by_human_id = $human WHERE invite_id = $1`, which satisfies the both-or-neither CHECK in a single statement. Setting `consumed_at` earlier would violate that CHECK, because Postgres checks it per statement and a CHECK cannot be deferred, and the human does not exist before step 4. The row is still locked from step 1.
7. Write audit events.

**Reactivation transaction.** A `revoked` identity row is reactivated only when the flow carries a targeted invite pinned to this `(issuer, subject)` whose `target_human_id` is the row's human. It runs steps 1 and 3 (lock and read the invite; pin check with `FOR SHARE` on the human and endpoint), locks the identity row `FOR UPDATE`, requires the human and endpoint to be active, sets the identity row back to active, creates the session on the same client, consumes the invite (step 6, with `consumed_by_human_id` = the row's human), and audits `oidc_identity.reactivated`. Sessions revoked by the earlier `identity revoke` stay revoked. Any other combination is `denied`.

After the transaction commits the callback sends the `302`. There is nothing to register with the relay: the browser's first post reads the new endpoint from Postgres through `lookupTrustedEndpoint`, so it cannot race a missing entry.

### Invites

- Created by the operator through the CLI (`sigil relay invite create --name <name> --room <id>:<role> ...`). v1 has no HTTP invite route and no browser "Invite person" dialog: the CLI writes Postgres directly, and the web client holds no bearer token in cookie mode. A route would be a second creation path with no caller.
- Creation validates that each `role` is `member` or `room_manager` and that the creator is a manager of every listed room. The CLI process takes `--identity` itself (see the foundation's CLI section). It needs no `--room-key-wrap-key`: `invite create` provisions nothing, and the relay provisions at redemption with its own key, which `--public-origin` requires.
- Bootstrap for the operator: `sigil relay invite create --self --provider github --login <name>` produces a 10-minute invite bound to the operator's own human and `--room-human-identity` endpoint, **and pinned to one provider identity**. Without the pin, whoever completes the flow first within 10 minutes is bound to the operator's account permanently (decision step 1 then logs them in with no invite), which grants room creation, every owner-only agent, and further invites, and a URL fragment can leak through chat, shell history, or browser history. The operator names themselves in a form they already know, and never handles a raw `sub`:
  - `--provider github --login <name>`: the CLI resolves the account's numeric `id` with `GET https://api.github.com/users/<name>` (using `outboundFetchOptions`, unauthenticated) at creation time and stores `target_issuer = https://github.com` and `target_subject = <id>`. A later rename does not matter, since the immutable id is what is pinned. A failed or ambiguous lookup aborts creation.
  - Any other identity completing the flow gets `denied`, and the invite is not consumed.
  The command exists only through the CLI, and it rejects a target endpoint that is not `kind = 'human'`. `target_endpoint_id` and `target_human_id` are tied by a composite foreign key (Data), so an invite cannot name an endpoint its target human does not own.
- **Targeted invite for an existing human:** `sigil relay invite create --human <human_id> --provider github --login <name> [--endpoint <id>] [--room <id>:<role> ...]` makes the same kind of pinned invite for a human that `human add` already provisioned, so that human can log in. The target endpoint is the human's only `kind = 'human'` endpoint, or `--endpoint` when there are several. Redemption skips provisioning, links the identity to that endpoint, and adds the human to any listed rooms with `addHumanToRoomsTx`. Expiry is 24 hours, since the pin bounds a leaked link to one GitHub account. `--self` is this form with the operator's own human and endpoint, no rooms, and a 10-minute expiry.
- The link is `<public-origin>/invite#<token>`. The fragment is never sent to a server. The page posts the token to `start`. Only the token's SHA-256 is stored. The static server sends `Referrer-Policy: same-origin` on every `index.html` response, since the SPA routes `/login` and `/invite` client-side and the relay never serves them. It is not `no-referrer`. With `no-referrer` the browser serializes the `Origin` of the `start` form POST as `null` (fetch spec, not yet confirmed in a browser), and the `start` Origin check would reject every legitimate invite. `same-origin` sends no `Referer` cross-origin, and the fragment is never in a `Referer` anyway. The plan's first browser test confirms the `Origin` the form POST carries. Expiry is 24 hours (10 minutes for `--self`).
- **Revocation.** `sigil relay invite list` shows each invite's name, rooms, expiry, and state (open, consumed, revoked, expired), and for a consumed invite the human it linked. `sigil relay invite revoke <invite_id>` runs `UPDATE ... SET revoked_at = now WHERE invite_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL` and writes `invite.revoked` (subject = the operator's human id). The linking transaction's locking `SELECT` (step 1) and `start` both reject a revoked invite, so it fails like an expired one (`invite_expired`). Revoking a consumed invite is a no-op: it does not undo the link, which is `identity revoke`'s job.
- A person who already has a linked identity logs in with no invite (decision step 1). Adding an existing person to another room is an operator action (`sigil relay human add-to-room`), not an invite.

### Browser session

- Extends `human_sessions` rather than adding a table. New columns are all **nullable**: `endpoint_id`, `last_seen_at`, `identity_issuer`, `identity_subject`. `/v1/auth/login`'s step-up insert (`createHumanSession`, `assertAssurance`) keeps working unchanged. OAuth rows set `session_id = sha256(cookie value)`, `authentication_method` of `oauth_github`, and `assurance = 'standard'`.
- No separate absolute-expiry column: `expires_at` is the absolute 7-day cap, and idle expiry (7 days) is `last_seen_at`. `last_seen_at` is written only when the stored value is more than 5 minutes old.
- The cookie authenticator accepts a row only when `endpoint_id IS NOT NULL` (step-up rows have none) and that endpoint is `kind = 'human'`, so step-up rows are never usable as cookies and the filter needs no per-provider method list.
- Cookie `__Host-sigil_session`: `HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`. The value is 256 random bits, generated the same way as the flow cookie and the ws-ticket (`ticket-store.mjs:22`), and only its SHA-256 is stored, so the cookie is as strong as the bearer it becomes.
- **Sockets follow the session, not just the human.** The ws-ticket strips session identity today and keeps only endpoint, owner, and human (`ticket-store.mjs:17`). Seven-day idle expiry, seven-day absolute expiry, logout, and identity revocation would then govern HTTP only, and an idle socket would keep receiving `room.updated` indefinitely. The cookie principal therefore carries `session_id`, `ws-ticket` copies it into the ticket (null for a bearer principal, so token mode is unchanged), and the stream server tags each browser socket `{ endpoint_id, human_id, session_id | null }`. The existing `endpoint -> sockets` maps (`clients`, `browserClients`) stay as they are, so `notifyRoom` keeps looking sockets up by endpoint and token-mode sockets are found the same way. A flat `session_id -> sockets` map serves only `closeSession(session_id, code)`. Logout calls `closeSession` and `ticketStore.revokeSession(session_id)` in-process, so an unredeemed ws ticket cannot open a socket after the session is gone. **The foundation's liveness check reads the ticket's session** (not revoked, inside `expires_at`, inside the idle window, identity not revoked), in addition to the human and endpoint status. It runs at upgrade, on `revalidate`, and in the once-a-minute pass for live browser sockets, so a ticket issued before an out-of-process revocation cannot open a socket.
- Login revokes any session the browser presented, then issues a new id.
- `oidc_identities` gains `verified_via TEXT` and `endpoint_id TEXT` (both nullable). A returning login uses the identity's stored `endpoint_id`, so a human who owns several endpoints always lands on the same one. Revoking an identity revokes every session carrying its `(identity_issuer, identity_subject)` in the same transaction.
- **Revoke path for GitHub identities.** `POST /v1/identities/revoke` rejects them (`http-server.mjs:621`) and needs the owning bearer principal, which a browser-only invitee does not have. The operator revokes through a CLI command: `sigil relay identity revoke --provider github (--login <name> | --subject <id>)` (`--login` resolves the numeric id the way `--self` does, so the operator never handles a raw id; the CLI takes `--identity` itself, as in the foundation's CLI section). In one transaction it marks the identity revoked, revokes the sessions carrying the pair that are still live (`revoked_at IS NULL AND expires_at > now()`), and sends a fixed-size `NOTIFY` `{ type: 'identity.revoked', human_id }`. The payload carries no session ids: `pg_notify` rejects payloads of 8000 bytes or more and the notify is inside the transaction, so a list of 64-hex session ids would overflow at about 110 sessions and roll back the revoke itself. Each relay instance listening clears that human's authenticator-cache entries and revalidates that human's live sockets (the foundation's primitive), which closes every socket whose session is now revoked. Tickets need no separate revocation, because the liveness check reads the session. It writes `oidc_identity.revoked` with subject `<issuer>|<subject>`, the convention of the existing audited revoke (`postgres-repository.mjs:1200`). Revocation is reversible only through a pinned targeted invite (the reactivation transaction), never silently.
- Session lookup joins `humans.status`, endpoint status, and identity status on every request, through the foundation's cache. Suspension or identity revocation ends the session.

### Credentials

Each listener has one credential type. The main listener is bearer-only and unchanged. The public listener builds a cookie authenticator (outside `createBearerAuthenticator`, which has no repository or URL) that returns `{ endpoint_id, owner_id, human_id, session_id }`, only for an endpoint with `kind = 'human'`. There is no composed authenticator, no `credential` discriminator, and no per-route cookie list beyond the dispatch table above. `isBrowserRoute` and the CORS helper are unchanged: the browser is same-origin to the public listener, so no CORS applies, and the cookie never reaches the main port. `/v1/endpoint-tokens`, `/v1/identities`, grants, and `/v1/auth/login` are bearer-only because they exist only on the main listener.

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
- `audit_events.subject_id` is NOT NULL (`001_initial.sql:165`), so every event below names one. `oauth_login.success` and `invite.redeemed` use the human id. `invite.created` and `invite.revoked` use the operator's human id. `oidc_identity.reactivated` uses `<issuer>|<subject>`. `oauth_login.denied` uses the human id when the identity matched a known human (a suspended or revoked identity, an inactive human), and otherwise `flow:<flow_id>`. A callback that arrives with no valid flow cookie has no `flow_id` and writes no audit row, since it cannot be attributed and an unauthenticated caller would otherwise write rows at will. An unknown identity's subject is not recorded: a hash of a numeric GitHub id is trivially reversible, so it would not be a pseudonym. Audit events: `oauth_login.success`, `oauth_login.denied`, `invite.created`, `invite.revoked`, `invite.redeemed`, `oidc_identity.reactivated`, plus the existing `human_session.*` events.

## Data

One migration (next free number on `main`):

- `room_invites(invite_id PRIMARY KEY, token_hash NOT NULL UNIQUE, name NOT NULL, created_by_human_id NOT NULL REFERENCES humans, target_human_id, target_endpoint_id, target_issuer, target_subject, created_at NOT NULL, expires_at NOT NULL, consumed_at, consumed_by_human_id REFERENCES humans, revoked_at)`. CHECKs: `consumed_at` and `consumed_by_human_id` are both null or both set (the linking transaction sets them in one `UPDATE`); `consumed_at` and `revoked_at` are not both set; the four `target_*` columns are all null or all set. `FOREIGN KEY (target_endpoint_id, target_human_id) REFERENCES endpoints (endpoint_id, owner_id)` (the same target as the composite keys below; null skips it), so a targeted invite can only name an endpoint its target human owns. `--self` sets `target_human_id` to the creator. On a targeted invite `target_subject` is resolved at creation and the pair pins the redeeming identity. The token is at least 128 random bits.
- `quota_usage_scope_kind_check` dropped and re-added with the eleven values from `018` plus `invite`, `oauth_provider_subject`, and `oauth_start` (see Rate limiting).
- `room_invite_rooms(invite_id REFERENCES room_invites, room_id REFERENCES rooms(conversation_id), role CHECK (role IN ('member','room_manager')), PRIMARY KEY (invite_id, room_id))`.
- `human_sessions`: `endpoint_id`, `last_seen_at`, `identity_issuer`, `identity_subject` (all nullable), with CHECKs: `identity_issuer` and `identity_subject` are both null or both set, and `endpoint_id IS NULL OR (last_seen_at IS NOT NULL AND identity_issuer IS NOT NULL)`. The CHECK keys on `endpoint_id`, not on a method string, so adding Google needs no CHECK change. **OAuth session insert contract:** `createHumanSession` (which already takes a `client`) sets all four columns, with `last_seen_at = now` at creation, so the idle window starts at login and is never null for a cookie row. No migration constrains `authentication_method` (`003_plugin_connector_auth.sql:51` is plain `TEXT NOT NULL`), so `oauth_github` needs no CHECK change.
- `oidc_identities`: `verified_via TEXT CHECK (verified_via IN ('oauth'))` and `endpoint_id` (both nullable), plus `CHECK (verified_via IS NULL OR endpoint_id IS NOT NULL)`, so a verified identity always names its login endpoint. The CHECK keeps the value from drifting.
- **Composite foreign keys.** On both `oidc_identities` and `human_sessions`, `FOREIGN KEY (endpoint_id, human_id) REFERENCES endpoints (endpoint_id, owner_id)` (the target is `UNIQUE (endpoint_id, owner_id)` in `001`). With the default `MATCH SIMPLE` a null `endpoint_id` skips the check, so step-up rows keep working. A row can then never name an endpoint its human does not own. `endpoints.owner_id` is `TEXT NOT NULL REFERENCES humans(human_id)` (`001_initial.sql:22`) and `UNIQUE (endpoint_id, owner_id)` exists (`001_initial.sql:30`), so the target is valid and needs no extra index. The migration adds `oidc_identities.endpoint_id` and `human_sessions.endpoint_id` before the keys.
- `human_sessions` gets an index on `(identity_issuer, identity_subject)` for the revoke-by-identity sweep.

OAuth login requires Postgres, like the federation routes. Without a database the routes return `501`. The memory repository has no identity storage and only undo-based transactions, so supporting it would multiply the surface for no user.

## Configuration

- `--public-origin <https url>`: redirect-URI base, cookie scope, CSRF origin, and browser-origin allowlist. Required to enable OAuth login.
- `--room-key-wrap-key <ref>`: from the foundation spec. `--public-origin` requires it.
- `--room-human-identity <path>`: from the foundation spec. `--public-origin` requires it, since without an operator there is nobody to create rooms or invites and `is_operator` is always false.
- `--public-port <n>`: the cookie-only listener the proxy forwards to (default `port ? port + 2 : 0`, `127.0.0.1`, the pattern `sigil.mjs:192` uses for the stream port; a literal `port + 2` becomes port 2 under the default `--port 0`). Used with `--public-origin`, which requires an explicit `--port`, since a proxy configuration cannot name an ephemeral port. `relay up` prints the bound port.
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
- Identity: unlinked without an invite (`invite_required`), linked without an invite (logs in, invite not consumed), a returning user after logout and after the 7-day expiry, revoked identity, suspended human, a multi-endpoint human landing on the stored endpoint. Startup fails if an OAuth provider's issuer is in `oidc_issuer_allowlist`.
- Schema: inserting an identity or session whose `endpoint_id` belongs to a different human fails the composite foreign key, and a step-up row with null `endpoint_id` inserts.
- Session: step-up rows are rejected as cookies, `/v1/auth/login` still works with the new columns, revoking an identity revokes its sessions. Logout, session expiry, and identity revocation close that session's stream sockets, and an idle socket does not outlive its session.
- CSRF and credential: wrong `Origin`, missing header, a cookie sent to the main port (no credential: 401 on every route), idle and absolute expiry, logout, login revoking the presented session.
- Suspension ends the session and closes the stream socket, for every endpoint the human owns.
- Identity revoke: `sigil relay identity revoke` revokes a GitHub identity and its sessions in one transaction, closes open sockets via the fixed-size `NOTIFY` and the revalidation primitive, and a revoked identity gets `denied` on its next login. A human with 500 live sessions revokes without overflowing the payload, and a ws ticket issued before the revoke cannot open a socket.
- `Origin` on the `start` form POST under `Referrer-Policy: same-origin` equals `--public-origin` in a real browser (Playwright), and `no-referrer` is not used on `/login` or `/invite`.
- Targeted invites: a `--self` or `--human` invite redeemed by a mismatched identity aborts `denied` before the consume `UPDATE`, and `consumed_at` stays null. `invite create --human` for a `human add` human links the identity to that human's endpoint, creates no second human, and adds the listed rooms. A human with two `kind = 'human'` endpoints requires `--endpoint`. A flow carrying a targeted invite whose target human differs from a verified row's human is `denied` and consumes nothing.
- Reactivation: after `identity revoke`, a pinned `--self` invite for the same `(issuer, subject)` reactivates the identity and logs in, sessions revoked earlier stay revoked, and `oidc_identity.reactivated` is written. The same flow with no invite, a mismatched pin, or a suspended human is `denied`. `identity revoke --login <name>` resolves the same id as `--subject`.
- Stream: `room.updated` reaches a cookie-session socket (found through the endpoint map), and still reaches a token-mode browser socket. Logout revokes an unredeemed ws ticket.
- Returning login: a concurrent `identity revoke`, human suspension, or endpoint suspension cannot yield a live session, including a suspension that commits between the login's status read and its session insert (the `FOR SHARE` locks make suspension wait, so `unsuspend` does not revive a session). A returning login with an inactive endpoint is `denied`.
- Audit: a callback with no flow cookie writes no audit row, a denied known human is audited under the human id, and no row stores a hash of the subject.
- Sessions: an OAuth `human_sessions` row missing `endpoint_id`, `last_seen_at`, or the identity pair fails the CHECK, every redemption including `--self` commits against the `consumed_at`/`consumed_by_human_id` CHECK and sets both columns, and `invite revoke` on a consumed invite changes no row.
- Public listener: sent directly to `--public-port`, every method and path outside the allowlist returns 404 before any handler runs, including `/approve`, `/v1/health`, the AgentMail webhook, `/v1/approval-challenges/{id}/assertion`, `/v1/federation/*`, `/v1/envelopes`, `/v1/endpoint-tokens`, `/v1/identities`, and `/v1/auth/login`, and path variants such as `/v1/rooms/../federation/envelopes` and encoded slashes. A bearer token (including a valid agent `relay_token`) on `/v1/rooms/*` returns 401 there and still works on the main port. A bearer WebSocket upgrade on the public listener's `/v1/stream` (the `Authorization` header or the `sigil-bearer.` subprotocol, with and without `Origin`) closes 1008, and still works on the loopback stream server.
- Proxy: a POST to `start` and a WebSocket upgrade both succeed through the web origin, `Set-Cookie` with `__Host-` survives the proxy, and `Origin` and `Host` arrive unchanged. With the proxy forwarding all of `/v1/*`, `/v1/endpoint-tokens`, `/v1/identities`, `/v1/envelopes`, `/v1/federation/*`, `/v1/health`, and `/approve` still return 404 through it.
- Web client: in `cookie` mode the SPA shows the login page with no session, loads after `GET /v1/auth/me`, hides Create room for a non-operator and shows "Stop my runs" in place of "Stop room", and never reads `getSender()`. In `token` mode nothing changes.
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
- `--self` pin: `--provider google --email <address>` stores `target_issuer` and a new `target_email` (the all-null-or-all-set CHECK on the `target_*` columns then accepts a null `target_subject` when `target_email` is set). Redemption requires `email_verified = true` and a case-insensitive match, then records the token's `sub`.
- Adds `authentication_method = 'oauth_google'`, a Google redirect URI check for the Tailscale hostname, and tests for the alias, nonce, and email pin.
- Unproven rows: if Google is in `oidc_issuer_allowlist`, `POST /v1/identities` can plant a `verified_via IS NULL` row for a victim's `sub` and lock them out, because `(issuer, subject)` is the primary key (`003_plugin_connector_auth.sql:21`) and step 1 denies every non-active state. The Google work treats `verified_via IS NULL` rows as nonexistent at login and, in the linking transaction, deletes any such row for the same pair together with the `account_links` rows that reference it (`003:78` has no `ON DELETE`), writes `oidc_identity.unproven_removed`, and adds planted-row tests.

## v1 behavior to state

- A second provider for an existing person creates a second human. There is no merge in v1.
- CLI membership and role changes reach open browser sessions through the foundation's `NOTIFY` payload (`room_ids`), which pushes roster updates.

## Module placement

New commands and repository methods go in new modules, not into `sigil.mjs` (1815 lines), `postgres-repository.mjs` (2330), or `http-server.mjs` (1126). The plan wires them in with the smallest possible edit to those files and does not refactor them.

## Open items for the plan

1. Confirm GitHub accepts the Tailscale hostname as an OAuth callback URL. If not, a domain the operator owns is the fallback.
2. Confirm `human_sessions` accepts the nullable columns without disturbing `/v1/auth/login`'s step-up rows, and that `createHumanSession` can take the extra fields.
3. Confirm `endpoints.display_name` is populated for the operator's seeded endpoint (the seed writes it), since `/v1/auth/me` falls back to it. `is_operator` is derived as "the session's human owns the `--room-human-identity` endpoint".
4. Confirm that `GET https://api.github.com/users/<name>` is reachable from the operator's machine at `invite create` time (unauthenticated calls are rate limited to 60 an hour).
