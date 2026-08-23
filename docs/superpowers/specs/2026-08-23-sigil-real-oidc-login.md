# Sigil real OIDC login — design

## Problem

`POST /v1/auth/mock-login` (`docs/superpowers/specs/2026-08-22-sigil-mock-oidc-login.md`)
proved the OIDC first-contact match flow end-to-end — `attemptDirectoryMatchOnOidcLogin`,
`claimDirectoryMatch`, session creation, replay protection — but is fixture-signed
against a committed local keypair, gated behind `--enable-mock-oidc`, local dev/CI
only. Per `docs/meta/sigil-cli-roadmap.md`, "remaining open work is a real IdP
integration (live OIDC client, JWKS fetch), not the trust model or the wiring
itself." This spec closes that gap: a production login route that verifies ID
tokens against a real, rotating, remote IdP keyset.

## Decision

Add `POST /v1/auth/login`, always present (no feature flag — unlike mock-login,
this is the production path). It reuses the entire match/session/audit/replay core
that mock-login already exercises, swapping only the token-verification step: a new
`sigil/relay/v1/oidc-client.mjs` does OIDC discovery + JWKS fetch + real signature
verification, in place of `mock-oidc.mjs`'s fixed local keypair.

### Token acquisition model

Sigil never drives a browser redirect or authorization-code exchange. The caller
(human or agent tooling) obtains an ID token from the IdP by whatever means it
already uses (a provider CLI, a browser login outside Sigil, etc.) and POSTs it —
identical to mock-login's contract. Sigil's relay is not a web app; adding a
redirect/PKCE flow would require a public callback URI and browser-in-the-loop
state management, which is out of scope and unnecessary for this repo's model of
"caller already holds a bearer token for a known human; the ID token supplies a
verified email claim for that human."

### Issuer registration (PostgreSQL)

`oidc_issuer_allowlist` gains a `client_id TEXT NOT NULL` column (migration
`0NN_oidc_issuer_client_id.sql`). Each allow-listed issuer is admin-provisioned
with the OAuth client_id Sigil was registered under at that IdP. This is required
to validate the token's `aud` claim (see below) — without it, any valid token from
an allow-listed issuer, regardless of which application it was issued for, would
verify. `memory-repository.mjs`'s issuer allow-list (currently no enforcement at
all — mock-login's spec notes `claimDirectoryMatch` matches on raw issuer-string
equality there) gets a matching in-memory `client_id` field wherever tests seed an
issuer for the real-login path.

Only issuers present in the allow-list are ever looked up. The route resolves
`client_id` from the allow-list *before* any outbound network call — an
unrecognized issuer is rejected immediately, so discovery/JWKS fetches never run
against arbitrary attacker-supplied hosts (closes an SSRF vector: the issuer string
in a request is untrusted input; only a value already vetted by an admin ever
reaches `fetch`).

### Discovery + JWKS fetch

`sigil/relay/v1/oidc-client.mjs`:

- `discoverIssuer(issuer)` — `fetch(\`${issuer}/.well-known/openid-configuration\`)`
  using Node's built-in `fetch` (no new dependency). Issuer must be `https:` only.
  The discovery document's own `issuer` field must exactly equal the requested
  issuer string (RFC 8414 §3.3) — a mismatch is rejected before the `jwks_uri` is
  ever trusted, closing a class of discovery-document-spoofing bugs.
- `fetchJwks(jwksUri)` — fetches the keyset (also `https:`-only), returns the raw
  JWK array.
- In-memory cache: `Map<issuer, { jwks, fetchedAt }>`, default TTL 1 hour. On a
  verify call where the token's `kid` isn't present in the cached set, one forced
  refetch runs before rejecting (covers key rotation) — capped at one refetch per
  verify call, never a retry loop.

### Signature verification

Hand-rolled via `node:crypto`, matching this repo's existing convention (mock-OIDC
ES256 sign/verify, webauthn attestation parsing) rather than adding a JOSE
dependency. Real IdPs mostly use RS256; this repo already hand-rolls ES256, so both
are supported:

- `jwkToKeyObject(jwk)` — `crypto.createPublicKey({ key: jwk, format: 'jwk' })`,
  branching on `jwk.kty`: `RSA` or `EC`. Any other `kty` is rejected outright.
- `verifyRealIdToken(token, { issuer, clientId, now })`:
  1. Parse the JWS header. `alg` must be exactly `RS256` or `ES256`, and must match
     the resolved key's type (`RSA`↔`RS256`, `EC`↔`ES256`) — an alg/kty mismatch is
     a hard rejection, same class of bug as the mock verifier's `alg === 'ES256'`
     pin.
  2. Look up the key by `header.kid` in the cached (or refetched) JWKS; missing kid
     after one refetch → reject.
  3. `crypto.verify` the signature with the resolved public key.
  4. Validate claims: `iss === issuer`, `aud` includes `clientId` (`aud` may be a
     string or array per spec), `email_verified === true`, all of `iss`, `sub`,
     `email`, `email_verified`, `iat`, `exp`, `jti` present, `exp`/`iat` sane with
     ±30s clock-skew leeway (matching the mock verifier's tolerance).
  5. Return `{ issuer, subject, email, jti }` — the exact shape
     `attemptDirectoryMatchOnOidcLogin` and the route already consume from
     mock-login, so no downstream code needs to know which verifier ran.

Any failure at any step throws `{ code: 'INVALID_ID_TOKEN', message }`, the same
error shape as `verifyMockIdToken`, so the route's error handling is one shared
code path for both tokens.

### Replay guard: shared table

Migration renames `mock_login_replays` to `login_jti_replays` (same schema: `jti
TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL`). Both `/v1/auth/mock-login` and
`/v1/auth/login` insert into this one table. `jti` collision across the two routes
is a non-issue in practice (different issuers mint them), and a shared table avoids
maintaining two near-identical repository methods. `postgres-repository.mjs`'s
`consumeMockLoginJti` is renamed `consumeLoginJti`; `memory-repository.mjs`'s
`consumedMockLoginJtis` Map is renamed `consumedLoginJtis`. Existing mock-login
tests are updated for the rename only — no behavior change to that route.

### Route contract

```
POST /v1/auth/login
Authorization: <endpoint bearer token>   (principal.human_id required)

{ "id_token": "<compact RS256 or ES256 JWS>" }
```

Identical contract shape to mock-login:

- Missing `principal.human_id` → `403 HUMAN_CONTEXT_REQUIRED`.
- Issuer (from the token header/payload, read only to do the allow-list lookup —
  not yet trusted) not in `oidc_issuer_allowlist` → `401 INVALID_ID_TOKEN` before
  any outbound fetch.
- Discovery/JWKS fetch failure (network error, timeout, malformed document,
  IdP-down) → `401 INVALID_ID_TOKEN` (never a 5xx leaking IdP-outage details to an
  unauthenticated-for-this-claim caller; the caller already holds a valid bearer
  token, so this is a "your ID token didn't verify" response, not a server error).
- Malformed / bad-alg / bad-signature / expired / missing-claim /
  `email_verified !== true` / wrong-`aud` token → `401 INVALID_ID_TOKEN`.
- Already-consumed `jti` → `401 TOKEN_REPLAYED`.
- Success → `201`, same body shape as mock-login:
  `{ "request_id": "...", "code": "OK", "session": { ... }, "match": { "request_id": "..." } | null }`.

Same transactional write sequence as mock-login (consume `jti`, create session,
record audit event, conditionally claim match) inside `repository.withTransaction`
on PostgreSQL; same no-op-transaction safety argument applies to
`memory-repository.mjs` (synchronous Map mutations, no `await` between them).

## Components

- `sigil/relay/v1/oidc-client.mjs` (new): `discoverIssuer`, `fetchJwks`,
  `jwkToKeyObject`, `verifyRealIdToken`, plus the in-memory
  `Map<issuer, { jwks, fetchedAt }>` cache. Accepts an injectable `fetch` for
  tests.
- `sigil/relay/v1/http-server.mjs`: new `POST /v1/auth/login` route, always
  registered (no `enable*` flag), placed alongside `/v1/auth/mock-login` and the
  other human-scoped routes. Shares the match/session/audit helper calls that
  mock-login's handler already uses.
- `sigil/migrations/0NN_oidc_issuer_client_id.sql`: `ALTER TABLE
  oidc_issuer_allowlist ADD COLUMN client_id TEXT NOT NULL`.
- `sigil/migrations/0NN_rename_login_jti_replays.sql`: `ALTER TABLE
  mock_login_replays RENAME TO login_jti_replays`.
- `sigil/relay/v1/postgres-repository.mjs`: `consumeMockLoginJti` →
  `consumeLoginJti` (rename); issuer-allowlist lookup returns `client_id`.
- `sigil/cli/memory-repository.mjs`: `consumedMockLoginJtis` →
  `consumedLoginJtis` (rename); issuer allow-list entries carry `client_id`.

## Testing

- `oidc-client.test.mjs`: discovery doc issuer-mismatch rejected; non-https issuer
  rejected; JWKS fetch failure/timeout surfaces as verify failure not a crash;
  RS256 round trip (real key, injected fetch returning a fixture JWKS); ES256
  round trip; alg/kty mismatch rejected (RS256 header with an EC key, and vice
  versa); unknown `kid` triggers exactly one refetch, then rejects if still
  missing; cache hit skips refetch within TTL; cache expiry triggers refetch;
  wrong `aud` rejected; `aud` as array containing clientId accepted; missing any
  required claim rejected; `email_verified: false`/absent rejected; expired token
  (including skew-boundary cases) rejected.
- `http-server` integration tests (both repositories):
  - unrecognized issuer → `401`, no outbound fetch attempted (assert via a
    fetch spy/mock that asserts zero calls).
  - success path creates a session and fires a match when one is pending, mirroring
    mock-login's equivalent case.
  - success path with no pending match → `match: null`, session still created.
  - missing `principal.human_id` → `403`, no writes performed.
  - bad token (signature/alg/claims/aud) → `401 INVALID_ID_TOKEN`, no writes
    performed.
  - replayed token (same `jti` twice) → second call `401 TOKEN_REPLAYED`.
  - IdP discovery/JWKS endpoint unreachable → `401`, not a `5xx`.
  - simulated mid-sequence failure on PostgreSQL → transaction rolls back, `jti`
    not left consumed.
- Existing `mock-oidc.test.mjs` and mock-login integration tests updated only for
  the `login_jti_replays`/`consumeLoginJti` rename — no behavioral change asserted
  or expected there.

## Out of scope

- Authorization-code/PKCE redirect flow — Sigil never becomes a browser-facing
  OAuth client; callers supply an already-obtained ID token.
- Token refresh / refresh_token handling — sessions are short-lived (matching the
  existing 5-minute TTL convention), not long-lived credentials needing renewal.
- Revocation checking (e.g. token introspection endpoints) — out of scope for a
  first real-IdP cut; ID tokens are trusted for their stated `exp` only, same as
  mock-login.
- Shared hosted relay / centrally-run Sigil — unrelated roadmap item, not touched
  here.
