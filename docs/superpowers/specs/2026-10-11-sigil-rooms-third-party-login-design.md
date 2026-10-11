# Sigil rooms third-party login — design

Depends on `2026-10-11-sigil-rooms-multi-human-foundation-design.md` (the endpoint directory, `provisionHumanTx`, async signing, `invokable_by`, suspension, and `LISTEN/NOTIFY`). Build that spec first.

## Problem

Rooms web authenticates with a bearer token the operator pastes into the page and keeps in `sessionStorage`. The 4a spec deferred a cookie session "until 4b needs work off localhost" (`2026-10-05-sigil-rooms-phase-4a-relay-browser-surface-design.md`). That moment arrives when other people on the operator's network use rooms.

Sigil has no path from "this person logged in with an identity provider" to "this request is from human H." `POST /v1/auth/login` (`2026-08-23-sigil-real-oidc-login.md`) requires an already-authenticated bearer principal, verifies a caller-supplied ID token, and records a 5-minute `human_sessions` row. It returns no credential, and that spec says Sigil never drives a browser redirect.

This spec adds the bootstrap: a browser login through Google or GitHub, gated by invite for first contact, that yields a cookie session on the rooms browser routes.

## Decisions

| Question | Decision |
| --- | --- |
| Audience | The operator plus invited people, on a private network. Not public sign-up. |
| Network | Tailscale first. A public tunnel later, for mobile, under a separate hardening spec. `--public-origin` makes the move configuration. |
| Admission | Invite-only for first contact. An invite links a provider identity to a Sigil human once. After that, the linked identity logs in with no invite. |
| Providers in v1 | Google (OIDC) and GitHub (OAuth2 only). Microsoft, X, and Meta are later additions behind the provider interface. |
| Architecture | Relay-native: the relay runs authorization-code + PKCE (S256) and issues the session cookie. No sidecar or broker. |
| Topology | One origin behind a required TLS proxy (below). `--public-origin` is that origin. |
| Signing | Foundation spec: relay-custodial per-human keys. |

Claude, ChatGPT, and Grok are not providers. No public "sign in with" flow is known for them. Sigil already talks to those agents as endpoints.

## Reused parts

- `oidc_identities`, `human_sessions`, the audit table, `recordAuditEvent`.
- `verifyRealIdToken`, the discovery cache, the JWKS cache, and `outboundFetchOptions` from `oidc-client.mjs` (5-second timeout, `redirect: 'error'`). It is a local function today, so this work exports it. `peer-discovery.mjs` already duplicates it and switches to the export.
- The room routes, `ws-ticket`, and `ticket-store.mjs` as the model for the flow store.
- Foundation: `provisionHumanTx`, `addHumanToRoomTx`, the endpoint directory, suspension, `NOTIFY`.

## Origin topology

The browser sees one origin, `--public-origin`, so cookies are same-origin and no credentialed CORS is needed. Today the relay HTTP server, the stream server (`port + 1`, path `/v1/stream`), and `sigil-rooms-web` each listen on `127.0.0.1` (`sigil.mjs:336,439`, `sigil-rooms-web.mjs:33`), and the web server rejects POST. Tailscale peers reach none of them directly.

**Required deployment:** a TLS-terminating proxy (Tailscale Serve, or equivalent) on the `--public-origin` hostname that forwards:

| Path | Backend |
| --- | --- |
| `/v1/stream` (WebSocket upgrade) | stream server |
| `/v1/*` | relay HTTP |
| everything else | `sigil-rooms-web` static server |

The proxy must pass `Set-Cookie` through unchanged, including `__Host-` cookies. `sigil-rooms-web` itself does not proxy; the 4b-1 decision that the relay serves no static files stands. The deployment note requires a dedicated hostname, because cookies are not isolated by port (RFC 6265 §8.5).

- The relay derives its browser-origin allowlist (HTTP CORS and the stream `Origin` check) from `--public-origin`. A separate `--browser-origin` is still accepted for the Vite dev server only.
- The web client stops reading `relayUrl` and `streamUrl` from `config.json` and uses relative URLs in this mode.
- Loopback keeps working: with no `--public-origin`, the relay behaves as today and the SPA offers the pasted-token form. The cookie flow is enabled only when `--public-origin` is set.
- `__Host-` and `Secure` need HTTPS, so the e2e harness runs behind a loopback TLS certificate and the proxy table above.

### Web client contract

In `--public-origin` mode `createClient` (`packages/sigil-rooms-web/src/api/client.ts:37-47`) no longer requires a bearer token. It sends `credentials: 'same-origin'` and `X-Sigil-CSRF: 1` on every non-GET request. `useLive` connects after `GET /v1/auth/me` succeeds instead of gating on a stored token. `AuthContext` drops the token in this mode and takes `endpoint_id` from `/v1/auth/me`, so `isManager` works before the first send. Any 401 returns the client to the login page. The token path stays for loopback.

`/v1/auth/me` returns `{ human_id, endpoint_id, display_name, is_operator }`. The client hides Create room and Stop room for non-operators, matching the server rules in the foundation spec. The server enforces them regardless.

## Components

### Provider interface

`sigil/relay/v1/oauth/providers/{google,github}.mjs`:

```
authorizeUrl({ state, nonce, codeChallenge, redirectUri }) -> string
exchangeCode({ code, codeVerifier, redirectUri }) -> { accessToken, idToken? }
resolveIdentity({ accessToken, idToken?, expectedNonce }) -> { issuer, subject, displayName? }
```

- Every authorize URL carries `code_challenge_method=S256`. A unit test pins the parameter, and `plain` is never offered.
- **Google.** Issuer `https://accounts.google.com`. Scopes `openid email profile`, because `verifyRealIdToken` requires the `email` and `email_verified` claims. `verifyRealIdToken` gains an `expectedNonce` option and rejects a mismatch. Google may emit `iss` as `accounts.google.com` without a scheme, which `normalizeIssuer` rejects, so the provider normalizes that one documented variant before verification.
- **GitHub.** No `id_token`. Scope `read:user`. `resolveIdentity` calls `GET /user`. `subject` is the numeric account `id` as a string, never `login`. The issuer is the fixed string `https://github.com`. Email is not fetched and not used.
- Provider configuration (endpoints, `client_id`, `client_secret` from the environment or Doppler) lives in relay configuration, not in `oidc_issuer_allowlist`. Putting GitHub in that allow-list would make `POST /v1/auth/login` attempt OIDC discovery against github.com.
- The callback uses the provider stored on the flow, not the path segment. All provider fetches use `outboundFetchOptions`. No provider URL is read from a request. The fake-IdP tests override endpoints through a test-only option guarded like `--enable-mock-oidc`.

### Flow state

`start` creates flow state `{ state, nonce, pkceVerifier, provider, inviteId? }` in a process-local, TTL'd (10 minutes), single-use store modeled on `ticket-store.mjs`. It is keyed by the SHA-256 of a 256-bit random value that `start` also sets as the cookie `__Host-sigil_oauth` (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`).

`callback` requires that cookie, looks up the flow by it, requires an exact `state` match, deletes the entry, and clears the cookie. This binds the flow to the browser that started it, which closes login CSRF and forced linking (RFC 6749 §10.12, RFC 9700 §2.1). A relay restart mid-login costs one retry, the same stance tickets take. There is no `oauth_flows` table.

### Routes

New file `sigil/relay/v1/oauth-routes.mjs` with `handleOAuthRoute`, dispatched the way `handleRoomRoute` is.

Before the bearer gate:

- `POST /v1/auth/oauth/{provider}/start`. The invite token is **optional** in the body. With one, `start` validates it and redirects to `/login?error=invite_expired` without contacting the provider if it is unknown or expired. Without one, the flow starts for a returning user. A form POST then `302` to the provider keeps the invite out of query strings. An unknown provider returns `404`.
- `GET /v1/auth/oauth/{provider}/callback?code=&state=`, or `?error=` from the provider, which maps to `/login?error=denied` before any code exchange.

After the gate, on cookie principals:

- `POST /v1/auth/logout` revokes the session row and sends `Set-Cookie: __Host-sigil_session=; Max-Age=0`.
- `GET /v1/auth/me` as above.

### Callback decision

After `resolveIdentity`, in this order:

1. Look up `(issuer, subject)` in `oidc_identities`.
   - Active, `verified_via = 'oauth'`, human active: **log in** as the identity's stored `endpoint_id`. No invite is needed and any invite on the flow is ignored and not consumed.
   - A row with `verified_via` null (planted through `POST /v1/identities`, which accepts a claim with no proof): if the flow carries a `--self` invite whose target human is that row's `human_id`, **upgrade** it (`verified_via = 'oauth'`, set `endpoint_id`) and log in. Otherwise `denied`.
   - Any other state (`suspended`, `unlinked`, `revoked`) or an inactive human: `denied`. It never falls through to linking.
2. No row, and the flow carries an unconsumed, unexpired invite: **link and log in** (below).
3. No row, no usable invite: `invite_required`.

A planted row for a victim's `sub` would otherwise lock that victim out of redemption. The operator clears it with `sigil relay identity clear <issuer> <subject>`, which writes `oidc_identity.cleared`. `--self` upgrade covers the operator's own previously bound identity.

**Linking transaction.** It opens after the outbound calls finish and never spans them. It runs on one client and does, in order:

1. Lock the creator's `conversation_members` rows for every invite room (`SELECT ... FOR UPDATE`) and re-check that the creator is still a manager of each. If not, abort `invite_expired`. This removes the check-then-act race with a concurrent removal.
2. Consume the invite with `UPDATE room_invites SET consumed_at = now WHERE invite_id = $1 AND consumed_at IS NULL AND expires_at > now`, aborting on zero rows. Two concurrent redemptions cannot both pass.
3. `--self` invite: skip provisioning and room membership. The target is the invite's `self_endpoint_id` and its owner human, which must be active. Otherwise call `provisionHumanTx` (source = the provider name, verification `provider_asserted`) and `addHumanToRoomTx` for each `room_invite_rooms` row.
4. Insert `oidc_identities` with `verified_via = 'oauth'` and the login `endpoint_id`.
5. Create the session.
6. Write audit events.

After the transaction commits, and before the `302`, the callback calls `directory.add` for a new endpoint. If `add` fails it logs and continues, because the directory's `resolve` load-through repairs the miss on the first request, so the browser's first post cannot race a missing entry.

### Invites

- Created by the operator through the CLI (`sigil relay invite create --name <name> --room <id>:<role> ...`) or through `POST /v1/auth/invites` (bearer only, operator only). The route is not under `/v1/rooms/`, which is already the browser-cookie namespace. v1 ships no browser "Invite person" dialog, since the web client holds no bearer token in cookie mode.
- Creation validates that each `role` is `member` or `room_manager`, that the creator is a manager of every listed room, and that a wrap key is configured.
- Bootstrap for the operator: `sigil relay invite create --self` produces a 10-minute invite bound to the operator's own human and `--room-human-identity` endpoint. It exists only through the CLI. There is no target parameter on the HTTP route, so a bearer holder cannot target another human's account.
- The link is `<public-origin>/invite#<token>`. The fragment is never sent to a server. The page posts the token to `start`. Only the token's SHA-256 is stored. Auth pages send `Referrer-Policy: no-referrer`. Expiry is 24 hours (10 minutes for `--self`).
- A person who already has a linked identity logs in with no invite (decision step 1). Adding an existing person to another room is an operator action (`sigil relay human add-to-room`), not an invite.

### Browser session

- Extends `human_sessions` rather than adding a table. New columns are all **nullable**: `endpoint_id`, `last_seen_at`, `identity_issuer`, `identity_subject`. `/v1/auth/login`'s step-up insert (`createHumanSession`, `assertAssurance`) keeps working unchanged. OAuth rows set `session_id = sha256(cookie value)`, `authentication_method` of `oauth_google` or `oauth_github`, and `assurance = 'standard'`.
- No separate absolute-expiry column: `expires_at` is the absolute 7-day cap, and idle expiry (8 hours) is `last_seen_at`. `last_seen_at` is written only when the stored value is more than 5 minutes old.
- The cookie authenticator accepts a row only when `endpoint_id IS NOT NULL` and `authentication_method` is `oauth_google` or `oauth_github`, so step-up rows are never usable as cookies.
- Cookie `__Host-sigil_session`: `HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`.
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
- Rate limiting reuses `reserveRateLimit`. The relay listens on `127.0.0.1`, so behind the proxy every request has the same remote address, and per-IP keying would be one shared bucket any peer could exhaust. Limits key on values an attacker cannot inflate (the invite id, the flow cookie) plus a global ceiling on `start`. A `--trusted-proxy` setting is required before keying on `X-Forwarded-For`.
- Provider tokens, secrets, and codes never appear in logs or audit rows.
- Audit events: `oauth_login.success`, `oauth_login.denied`, `invite.created`, `invite.redeemed`, `oidc_identity.cleared`, plus the existing `human_session.*` events.

## Data

One migration (next free number on `main`):

- `room_invites(invite_id, token_hash, name, created_by_human_id, self_endpoint_id, created_at, expires_at, consumed_at, consumed_by_human_id)`.
- `room_invite_rooms(invite_id REFERENCES room_invites, room_id, role CHECK (role IN ('member','room_manager')), PRIMARY KEY (invite_id, room_id))`.
- `human_sessions`: `endpoint_id`, `last_seen_at`, `identity_issuer`, `identity_subject` (all nullable).
- `oidc_identities`: `verified_via`, `endpoint_id` (both nullable).

OAuth login requires Postgres, like the federation routes. Without a database the routes return `501`. The memory repository has no identity storage and only undo-based transactions, so supporting it would multiply the surface for no user.

## Configuration

- `--public-origin <https url>`: redirect-URI base, cookie scope, CSRF origin, and browser-origin allowlist. Required to enable OAuth login.
- `--room-key-wrap-key <ref>`: from the foundation spec. `--public-origin` requires it.
- Provider `client_id` and `client_secret` from the environment or Doppler, separate per provider.
- `relay up` help text documents all of these, plus the proxy table.

## Testing

- Provider unit tests against a fake IdP and a fake GitHub API on local ports, including the `S256` parameter and Google's scheme-less `iss`.
- Flow: missing or wrong flow cookie, state mismatch, replayed code, expired flow, nonce mismatch, provider `?error=`.
- Invite: reused, expired, two concurrent redemptions (Postgres race test), a creator removed from a room mid-redemption, an invite naming several rooms with different roles, `--self` creating no second human.
- Identity: unlinked without an invite (`invite_required`), linked without an invite (logs in, invite not consumed), a returning user after logout and after the 7-day expiry, revoked identity, suspended human, a planted `POST /v1/identities` row (denied for others, upgraded for `--self`), `identity clear`, a multi-endpoint human landing on the stored endpoint.
- Session: step-up rows are rejected as cookies, `/v1/auth/login` still works with the new columns, revoking an identity revokes its sessions.
- CSRF and credential: wrong `Origin`, missing header, a cookie on `/v1/endpoint-tokens`, `/v1/identities`, and `/v1/auth/invites` (all 401), idle and absolute expiry, logout, login revoking the presented session.
- Suspension ends the session and closes the stream socket.
- Proxy: a POST to `start` and a WebSocket upgrade both succeed through the web origin, and `Set-Cookie` with `__Host-` survives the proxy.
- End to end on Postgres, in the one-origin topology behind a loopback certificate: invite redeemed, invitee posts a signed message from the composer, owner sees it, and the router's answer from an owner-only agent is refused for the invitee.
- Real Google and GitHub cannot be automated. A manual smoke checklist ships with the plan.

## Out of scope

- X, Meta, and Microsoft providers.
- Browser-held signing keys.
- Public-internet hardening for the tunnel step: bot protection, tighter limits, account recovery. A separate spec precedes that step.
- CLI and agent login.
- A browser invite dialog.
- Multi-tenant sign-up.

## Open items for the plan

1. Confirm the Tailscale hostname is accepted as a Google redirect URI. If not, a domain the operator owns is the fallback.
2. Confirm `human_sessions` accepts the nullable columns without disturbing `/v1/auth/login`'s step-up rows, and that `createHumanSession` can take the extra fields.
3. Confirm `GET /v1/auth/me`'s `display_name` source (`human_attributes`) is populated for the operator's existing human, and that `is_operator` can be derived as "endpoint equals the `--room-human-identity` endpoint".
