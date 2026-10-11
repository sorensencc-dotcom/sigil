# Sigil rooms third-party login — design

## Problem

Rooms web (phases 4a and 4b) authenticates with a bearer token the operator pastes into the page and keeps in `sessionStorage`. The 4a spec deferred a session-to-token exchange or `HttpOnly` cookie "until 4b needs work off localhost" (`2026-10-05-sigil-rooms-phase-4a-relay-browser-surface-design.md`). That moment arrives when other people on the operator's network use rooms.

Sigil has no way to turn "this person logged in with an identity provider" into "this request is from human H." `POST /v1/auth/login` (`2026-08-23-sigil-real-oidc-login.md`) does not do it. It requires an already-authenticated human bearer principal, verifies an ID token the caller supplies, and records a 5-minute `human_sessions` row. It returns no credential. That spec also states Sigil never drives a browser redirect or authorization-code exchange.

This spec adds the missing bootstrap: a browser login through Google or GitHub, gated by invite, that yields a cookie session usable on the rooms browser routes.

## Decisions

| Question | Decision |
| --- | --- |
| Audience | You plus people you invite, on a private network. Not public sign-up. |
| Network | Tailscale first. A public tunnel later, for mobile, under a separate hardening spec. The relay takes a `--public-origin` so the move is configuration. |
| Admission | Invite-only. An invite links a provider identity to a Sigil human on first login. Unlinked identities without an invite get nothing. |
| Providers in v1 | Google (OIDC) and GitHub (OAuth2 only). The provider interface makes Microsoft, X, or Meta a later addition. |
| Architecture | Relay-native. The relay runs the authorization-code + PKCE flow and issues the session cookie. No sidecar and no external broker. |
| Signing identity | Relay-custodial, per-human keys, wrapped by an operator-supplied key. Browser-held keys are a later upgrade behind the same seam. |

Claude, ChatGPT, and Grok are not providers. No public "sign in with" flow is known for them, so this spec does not count them. Sigil already talks to those agents as endpoints.

## Reused parts

- `oidc_identities` maps `(issuer, subject)` to a human.
- `verifyRealIdToken`, the discovery cache, and the JWKS cache (`sigil/relay/v1/oidc-client.mjs`).
- The OIDC issuer allow-list, which holds each provider's `client_id`.
- `humans` and `endpoints`, the audit table, and `recordAuditEvent`.
- The room routes and the `ws-ticket` flow from 4a. These need no change except accepting a second credential type.

## Components

### Provider interface

`sigil/relay/v1/oauth/providers/{google,github}.mjs`, each exporting:

```
authorizeUrl({ state, nonce, codeChallenge, redirectUri }) -> string
exchangeCode({ code, codeVerifier, redirectUri }) -> { accessToken, idToken? }
resolveIdentity({ accessToken, idToken?, nonce }) -> { issuer, subject, displayName?, email? }
```

- **Google.** Issuer `https://accounts.google.com`. `resolveIdentity` verifies the `id_token` with `verifyRealIdToken` and rejects a `nonce` that does not equal the flow's nonce.
- **GitHub.** No `id_token`. `resolveIdentity` calls `GET /user` with the access token. `subject` is the numeric account `id` as a string, never `login`. The issuer is the fixed string `https://github.com`. Email, if fetched, comes from `GET /user/emails` (verified and primary only) and is display-only.

Provider endpoints and client credentials are fixed server-side configuration. No provider URL is read from a request.

### Routes

All three routes sit before the bearer authentication gate, because their callers have no credential yet.

- `GET /v1/auth/oauth/{provider}/start?invite=<token>` creates an `oauth_flows` row holding `state_hash`, `nonce`, the PKCE verifier (encrypted), the provider, and the optional invite id. It then redirects with `302` to the provider. A missing or unknown provider returns `404`.
- `GET /v1/auth/oauth/{provider}/callback?code=&state=` consumes the flow row exactly once and compares the state hash. It exchanges the code with the verifier and the client secret, then calls `resolveIdentity`. Then:
  1. If `(issuer, subject)` exists in `oidc_identities` and its human is active, log that human in.
  2. Otherwise, if the flow carries an unconsumed, unexpired invite, link the identity to the invite's human, consume the invite, and log in. This runs in one transaction.
  3. Otherwise, redirect to `/login?error=invite_required`.
  
  On success the response is a `302` to a fixed path with `Set-Cookie`.
- `POST /v1/auth/logout` deletes the caller's `browser_sessions` row.
- `GET /v1/auth/me` returns `{ human_id, display_name, role }` for the cookie principal.

### Invites

- `POST /v1/rooms/invites` is owner-only and bearer-authenticated. The body carries `role`, `room_ids`, and an optional `target_human_id`. With a target, the invite binds an existing human, which is how the owner bootstraps their own login. Without one, redeeming creates a new human, endpoint, and signing key.
- The response is a one-time URL, `<public-origin>/invite/<token>`, with a 24-hour TTL. Only the token's SHA-256 is stored.
- The CLI wraps the same route as `sigil relay invite`.

### Browser session

- Cookie `__Host-sigil_session` with `HttpOnly; Secure; SameSite=Lax; Path=/` and no `Domain`. The value is 256 random bits. Only its SHA-256 is stored in `browser_sessions`.
- Idle timeout 8 hours, absolute timeout 7 days. Login issues a fresh id and logout deletes the row.
- The authenticator accepts the cookie as a second credential type and yields a principal with `human_id` and `endpoint_id`, the same shape a bearer token yields.
- A cookie principal is valid only on an explicit route allowlist: the rooms browser routes (`ws-ticket`, messages, ack, room list, and member routes the 4b client calls), `/v1/auth/me`, and `/v1/auth/logout`. Everywhere else a cookie is treated as no credential. Cookies cannot mint endpoint tokens, create grants, or manage identities.

### CSRF and origin

- Cookie-authenticated requests that change state must send `X-Sigil-CSRF: 1` and an `Origin` header exactly equal to `--public-origin`. Anything else returns `403`. The custom header forces a CORS preflight from any other origin.
- The WebSocket keeps the single-use ticket from 4a. The ticket is issued only through the checked routes above.
- The rooms web client is served from the same origin as the relay, directly or behind a reverse proxy, so no credentialed cross-origin CORS is needed.

### Signing keys

`signForEndpoint(endpoint_id)` currently holds one key from `--room-human-identity` and refuses any other endpoint. It changes to:

1. The configured identity file still serves the owner's existing endpoint.
2. For any other human endpoint, it loads the row from `human_signing_keys`, unwraps the private key with the key named by `wrap_key_id`, and signs.
3. It throws `NO_SIGNING_KEY` for an endpoint with no key, as today.

Redeeming a new-human invite creates the human, a `kind=human` endpoint, and a keypair in one transaction. The relay refuses to start if `--room-key-wrap-key` is unset while any `human_signing_keys` rows exist. The startup public-key consistency check from 4a applies to every stored key, so a registry and key-store mismatch fails closed.

Custody stance: a signature from an invited human proves the relay saw that person authenticate. It does not prove the person held the key. A compromised relay exposes every key. This matches the existing trust model, where the relay already holds the owner's key.

## Data

Two migrations. Numbering follows the next free slot on `main` at implementation time.

- `oauth_flows(flow_id, state_hash, nonce, pkce_verifier_enc, provider, invite_id, created_at, expires_at, consumed_at)`. 10-minute TTL, consumed once, reaped after expiry.
- `room_invites(invite_id, token_hash, target_human_id, role, room_ids, created_by_human_id, created_at, expires_at, consumed_at, consumed_by_human_id)`.
- `browser_sessions(session_hash, human_id, endpoint_id, created_at, last_seen_at, expires_at, revoked_at)`.
- `human_signing_keys(endpoint_id, public_key, wrapped_private_key, wrap_key_id, created_at)`.

Both repositories (Postgres and memory) implement every new method, as with existing routes.

## Rooms web client

- A login page with Google and GitHub buttons that link to `/v1/auth/oauth/{provider}/start`.
- An `/invite/<token>` landing page. It shows the provider buttons and passes the invite token through `start`.
- The pasted-token field and the `sessionStorage` token are removed. Requests rely on the cookie.
- An owner "Invite person" dialog and a logout button.
- A `401` from any request returns the client to the login page.

## Errors and abuse handling

- Every callback failure redirects to `/login?error=<code>` with one of `denied`, `invite_required`, `invite_expired`, or `provider_error`. The response never reveals whether an identity is already linked.
- Post-login destinations come from a fixed server-side path allowlist. No parameter selects a redirect target.
- `start` and `callback` are rate-limited per client IP.
- Provider tokens, secrets, and codes never appear in logs or audit rows.
- Audit events: `oauth_login.success`, `oauth_login.denied`, `invite.created`, `invite.redeemed`, `browser_session.created`, `browser_session.revoked`. Mutations and their audit rows share one transaction, as existing routes do.

## Configuration

- `--public-origin <https url>`: redirect URI base, cookie scope, and CSRF origin. Required to enable OAuth login.
- `--room-key-wrap-key <ref>`: reference to the key that wraps stored private keys, from the environment or Doppler. The value never appears in argv.
- Provider `client_id` comes from the issuer allow-list. `client_secret` comes from the environment or Doppler.
- `relay up` help text documents all of the above.

## Testing

- Provider unit tests run against a fake IdP and a fake GitHub API on local ports.
- Flow tests cover: state mismatch, replayed code, expired flow, reused invite, expired invite, unlinked identity without an invite, linked identity without an invite, nonce mismatch, wrong `Origin`, missing CSRF header, a cookie on a non-allowlisted route, idle and absolute expiry, and logout.
- Key tests cover: wrap and unwrap round trip, wrong wrap key, startup refusal when the wrap key is missing, and two invited humans producing two distinct verified senders.
- The existing Playwright e2e harness runs a full login against the fake IdP.
- Real Google and GitHub cannot be automated. A manual smoke checklist ships with the plan.

## Out of scope

- X, Meta, and Microsoft providers.
- Browser-held signing keys.
- Public-internet hardening for the tunnel step: bot protection, tighter rate limits, and account recovery. A separate spec precedes that step.
- CLI and agent login.
- Multi-tenant sign-up.

## Open items for the plan

1. Confirm whether `verifyRealIdToken` checks `nonce`. If not, the Google provider adds the check itself.
2. Confirm whether `sigil-rooms-web` can be served from the relay's origin or needs a reverse-proxy recipe.
3. Confirm Google accepts the chosen Tailscale hostname as a redirect URI. If it does not, a domain you own is the fallback.
4. Confirm the principal shape that room routes require (`human_id`, `endpoint_id`) is all they read.
