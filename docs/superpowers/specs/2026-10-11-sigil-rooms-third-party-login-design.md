# Sigil rooms third-party login — design

Depends on `2026-10-11-sigil-rooms-multi-human-foundation-design.md` (the endpoint directory, `provisionHuman`, async signing, `invokable_by`, and suspension). Build that spec first.

## Problem

Rooms web authenticates with a bearer token the operator pastes into the page and keeps in `sessionStorage`. The 4a spec deferred a cookie session "until 4b needs work off localhost" (`2026-10-05-sigil-rooms-phase-4a-relay-browser-surface-design.md`). That moment arrives when other people on the operator's network use rooms.

Sigil has no path from "this person logged in with an identity provider" to "this request is from human H." `POST /v1/auth/login` (`2026-08-23-sigil-real-oidc-login.md`) requires an already-authenticated bearer principal, verifies a caller-supplied ID token, and records a 5-minute `human_sessions` row. It returns no credential, and that spec says Sigil never drives a browser redirect.

This spec adds the bootstrap: a browser login through Google or GitHub, gated by invite, that yields a cookie session on the rooms browser routes.

## Decisions

| Question | Decision |
| --- | --- |
| Audience | The operator plus invited people, on a private network. Not public sign-up. |
| Network | Tailscale first. A public tunnel later, for mobile, under a separate hardening spec. `--public-origin` makes the move configuration. |
| Admission | Invite-only. An invite links a provider identity to a Sigil human on first login. Unlinked identities without an invite get nothing. |
| Providers in v1 | Google (OIDC) and GitHub (OAuth2 only). Microsoft, X, and Meta are later additions behind the provider interface. |
| Architecture | Relay-native: the relay runs authorization-code + PKCE and issues the session cookie. No sidecar or broker. |
| Topology | One origin. The `sigil-rooms-web` server serves the SPA and reverse-proxies `/v1/*` and `/v1/stream` to the relay. `--public-origin` is that origin. |
| Signing | Foundation spec: relay-custodial per-human keys. |

Claude, ChatGPT, and Grok are not providers. No public "sign in with" flow is known for them. Sigil already talks to those agents as endpoints.

## Reused parts

- `oidc_identities` (`(issuer, subject) -> human_id`), `human_sessions`, the audit table, `recordAuditEvent`.
- `verifyRealIdToken`, the discovery cache, the JWKS cache, and `outboundFetchOptions` (5-second timeout, `redirect: 'error'`) from `oidc-client.mjs`.
- The room routes, `ws-ticket`, and `ticket-store.mjs` as the model for the flow store.
- Foundation: `provisionHuman`, `addHumanToRoom`, the endpoint directory, suspension.

## Origin topology

The browser sees one origin, `--public-origin`, so cookies are same-origin and no credentialed CORS is needed.

- `packages/sigil-rooms-web/serve/server.mjs` proxies `/v1/*` and the WebSocket at `/v1/stream` to the relay. This is consistent with the 4b-1 decision that the relay serves no static files.
- The relay derives its browser-origin allowlist (HTTP CORS and the stream `Origin` check) from `--public-origin`. A separate `--browser-origin` is still accepted for the Vite dev server only.
- The web client stops reading `relayUrl` and `streamUrl` from `config.json` and uses relative URLs. It sends `credentials: 'same-origin'` and `X-Sigil-CSRF: 1` on every non-GET request. `useLive` no longer gates on a stored token and connects after `GET /v1/auth/me` succeeds.
- Cookies are not isolated by port (RFC 6265 §8.5). The deployment note requires a dedicated hostname for the rooms origin.
- Loopback keeps working: with no `--public-origin`, the relay behaves as today and the SPA offers the pasted-token form. The cookie flow is enabled only when `--public-origin` is set. `__Host-` and `Secure` need HTTPS, so the e2e harness runs behind a loopback TLS certificate.

## Components

### Provider interface

`sigil/relay/v1/oauth/providers/{google,github}.mjs`:

```
authorizeUrl({ state, nonce, codeChallenge, redirectUri }) -> string
exchangeCode({ code, codeVerifier, redirectUri }) -> { accessToken, idToken? }
resolveIdentity({ accessToken, idToken?, expectedNonce }) -> { issuer, subject, displayName? }
```

- **Google.** Issuer `https://accounts.google.com`. The authorize URL requests `openid email profile`, since `verifyRealIdToken` requires the `email` and `email_verified` claims. `verifyRealIdToken` gains an `expectedNonce` option and rejects a mismatch, instead of the provider decoding the payload a second time. Google may emit `iss` as `accounts.google.com` without a scheme, which `normalizeIssuer` rejects, so the provider normalizes that one documented variant before verification.
- **GitHub.** No `id_token`. The authorize URL requests `read:user`. `resolveIdentity` calls `GET /user`. `subject` is the numeric account `id` as a string, never `login`. The issuer is the fixed string `https://github.com`. Email is not fetched and not used.
- Provider configuration (endpoints, `client_id`, `client_secret` from the environment or Doppler) lives in relay configuration, not in `oidc_issuer_allowlist`. Putting GitHub in that allow-list would make `POST /v1/auth/login` attempt OIDC discovery against github.com.
- The callback uses the provider stored on the flow, not the path segment.
- All provider fetches use `outboundFetchOptions`. No provider URL is read from a request. The fake-IdP tests override endpoints through a test-only option with the same guard as `--enable-mock-oidc`.

### Flow state

`start` creates flow state `{ state, nonce, pkceVerifier, provider, inviteId }` in a process-local, TTL'd (10 minutes), single-use store modeled on `ticket-store.mjs`. It is keyed by the SHA-256 of a 256-bit random value that `start` also sets as the cookie `__Host-sigil_oauth` (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`).

`callback` requires that cookie, looks up the flow by it, requires an exact `state` match, deletes the entry, and clears the cookie. This binds the flow to the browser that started it, which closes login CSRF and forced linking (RFC 6749 §10.12, RFC 9700 §2.1). A relay restart mid-login costs one retry, the same stance tickets take. There is no `oauth_flows` table.

### Routes

New file `sigil/relay/v1/oauth-routes.mjs` with `handleOAuthRoute`, dispatched the way `handleRoomRoute` is.

Before the bearer gate:

- `POST /v1/auth/oauth/{provider}/start` with the invite token in the body (form POST, then `302` to the provider). An unknown provider returns `404`. An unknown or expired invite redirects to `/login?error=invite_expired` without contacting the provider. A POST keeps the invite out of query strings.
- `GET /v1/auth/oauth/{provider}/callback?code=&state=`, or `?error=` from the provider, which maps to `/login?error=denied` before any code exchange.

After the gate, on cookie principals:

- `POST /v1/auth/logout` revokes the session row and sends `Set-Cookie: __Host-sigil_session=; Max-Age=0`.
- `GET /v1/auth/me` returns `{ human_id, endpoint_id, display_name }`, with `display_name` read from `human_attributes`.

### Callback decision

After `resolveIdentity`, in this order:

1. Look up `(issuer, subject)` in `oidc_identities`.
   - Row exists, `status = 'active'`, `verified_via = 'oauth'`, and the human is `active`: log in.
   - Row exists in any other state: `denied`. It never falls through to linking.
2. No row, and the flow carries an unconsumed, unexpired invite: link and log in (below).
3. Otherwise: `invite_required`.

`oidc_identities` gains `verified_via TEXT` (null for rows created through `POST /v1/identities`, `'oauth'` for rows this flow creates). `POST /v1/identities` lets any bearer human claim an `(issuer, subject)` with no proof, so step 1 honors only rows this flow verified. Otherwise a bearer holder could preempt a Google `sub` and capture its owner's login.

**Linking transaction.** The transaction opens after the outbound calls finish and never spans them. It does, in order:

1. Consume the invite with `UPDATE room_invites SET consumed_at = now WHERE invite_id = $1 AND consumed_at IS NULL AND expires_at > now`, aborting on zero rows. Two concurrent redemptions cannot both pass.
2. For a new-human invite, call foundation `provisionHuman` with a relay-generated endpoint id and the provider's display name stored as an attribute, then `addHumanToRoom` for each room in the invite with its role.
3. Insert the `oidc_identities` row with `verified_via = 'oauth'`.
4. Create the session.
5. Write audit events.

### Invites

- Created by the operator through the CLI (`sigil relay invite create --name <name> --room <id>:<role> ...`) or through `POST /v1/auth/invites` (bearer only, operator only). The invite is not under `/v1/rooms/`, which is already the browser-cookie namespace. v1 ships no browser "Invite person" dialog, since the web client holds no bearer token.
- Creation validates that `role` is `member` or `room_manager`, that the creator is a manager of every listed room, and that a wrap key is configured. Redemption re-checks the creator is still a manager.
- Bootstrap for the operator: `sigil relay invite create --self` produces a 10-minute invite bound to the operator's own human and `--room-human-identity` endpoint. It exists only through the CLI. There is no `target_human_id` parameter on the HTTP route, so a bearer holder cannot target another human's account.
- The link is `<public-origin>/invite#<token>`. The fragment is never sent to a server. The page posts the token to `start`. Only the token's SHA-256 is stored. Auth pages send `Referrer-Policy: no-referrer`. Expiry is 24 hours (10 minutes for `--self`).
- If the person already has a linked identity, step 1 logs them in and a new invite is not consumed. Adding an existing person to another room is an operator action (`sigil relay human add-to-room`), not an invite.

### Browser session

- Extends `human_sessions` rather than adding a table: `endpoint_id`, `last_seen_at`, and an absolute-expiry column, with `session_id = sha256(cookie value)` and `authentication_method` of `oauth_google` or `oauth_github`. The existing owner-checked revoke route and audit events apply. The 5-minute step-up sessions that `/v1/auth/login` writes are unaffected.
- Cookie `__Host-sigil_session`: `HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`. Idle timeout 8 hours, absolute 7 days. `last_seen_at` is written only when the stored value is more than 5 minutes old.
- Login revokes any session the browser presented, then issues a new id.
- Session lookup joins `humans.status` and endpoint status on every request (through the foundation's short cache). Suspension or identity revocation ends the session, and revoking an identity revokes sessions it created.

### Credential types and allowlist

A new authenticator composes bearer and cookie. It returns `{ endpoint_id, owner_id, human_id, credential: 'bearer' | 'cookie' }` and is built outside `createBearerAuthenticator`, which has no repository or URL. A cookie principal is accepted only when `isBrowserRoute(path)` is true or the path is `/v1/auth/me` or `/v1/auth/logout`. That reuses the one existing route list. On every other route a cookie counts as no credential, so `/v1/endpoint-tokens`, `/v1/identities`, grants, and `/v1/auth/invites` stay bearer-only and return 401.

### CSRF

Cookie-authenticated non-GET requests must send `X-Sigil-CSRF: 1` and an `Origin` header exactly equal to `--public-origin`, enforced in the gate helper beside `browser-cors.mjs`. Anything else returns `403`. The WebSocket keeps the single-use ticket from 4a, issued only through these checked routes.

## Errors and abuse handling

- Callback failures redirect to `/login?error=<code>` with one of `denied`, `invite_required`, `invite_expired`, or `provider_error`. The page never reveals whether an identity is linked.
- Post-login destinations come from a fixed server-side path. No parameter selects a redirect target.
- Rate limiting reuses `reserveRateLimit`. The relay listens on `127.0.0.1`, so behind the proxy every request has the same remote address, and per-IP keying would be one shared bucket any peer could exhaust. Limits key on values an attacker cannot inflate (the invite id, the flow cookie) plus a global ceiling on `start`. A `--trusted-proxy` setting is required before keying on `X-Forwarded-For`.
- Provider tokens, secrets, and codes never appear in logs or audit rows.
- Audit events: `oauth_login.success`, `oauth_login.denied`, `invite.created`, `invite.redeemed`, plus the existing `human_session.*` events.

## Data

One migration (next free number on `main`):

- `room_invites(invite_id, token_hash, role, room_ids, created_by_human_id, self_endpoint_id, created_at, expires_at, consumed_at, consumed_by_human_id)`.
- `human_sessions` additions listed above.
- `oidc_identities.verified_via`.

OAuth login requires Postgres, like the federation routes. Without a database the routes return `501`. The memory repository has no identity storage and only undo-based transactions, so supporting it would multiply the surface for no user.

## Configuration

- `--public-origin <https url>`: redirect-URI base, cookie scope, CSRF origin, and browser-origin allowlist. Required to enable OAuth login.
- `--room-key-wrap-key <ref>`: from the foundation spec. `--public-origin` requires it.
- Provider `client_id` and `client_secret` from the environment or Doppler. They are separate secrets per provider.
- `relay up` help text documents all of these.

## Testing

- Provider unit tests against a fake IdP and a fake GitHub API on local ports.
- Flow: missing or wrong flow cookie, state mismatch, replayed code, expired flow, nonce mismatch, provider `?error=`, reused invite, expired invite, two concurrent redemptions (Postgres race test), unlinked identity without an invite, revoked identity, suspended human, a `POST /v1/identities`-planted row not logging in, linked identity without an invite.
- CSRF and credential: wrong `Origin`, missing header, a cookie on `/v1/endpoint-tokens` and `/v1/identities` and `/v1/auth/invites` (all 401), idle and absolute expiry, logout, login revoking the presented session.
- Session ends on suspension, and the stream socket closes.
- End to end on Postgres, in the one-origin topology behind a loopback certificate: invite redeemed, invitee posts a signed message, owner sees it, and an owner-only agent mentioned by the invitee is refused.
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
2. Confirm `human_sessions` can take the new columns without breaking `/v1/auth/login`'s step-up rows.
3. Confirm `GET /v1/auth/me`'s `display_name` source (`human_attributes`) is populated for the operator's existing human.
