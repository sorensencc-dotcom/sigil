# Sigil mock-OIDC login route — design

## Problem

`attemptDirectoryMatchOnOidcLogin` (`sigil/relay/v1/directory-trust.mjs`) implements
spec §3.2 step 2 of `docs/specs/sigil-endpoint-directory-trust-spec-v1.0.md` — checking
a human's provider-verified email against pending directory match requests — but is
wired to nothing. The function's own comment says so: "this repo has no OIDC login flow
at all yet (no ID-token verification, no JWKS, nothing calls
`repository.createHumanSession`)." On-ramp 2 (OIDC match) can create and
nominate-ready a `directory_match_requests` row, but that row can never leave
`pending` in production, because nothing ever supplies a verified email claim.

Building a live OIDC client (real IdP, JWKS fetch over HTTPS, ID-token verification
against a rotating remote keyset) is out of scope for closing this gap — it's a
separate, larger integration surface with its own config/ops burden. What's needed to
make the existing, already-tested match-claim logic reachable outside unit tests is a
deterministic, fully local login flow that produces the same shape of input
(`issuer`, verified `email`, `matchedHumanId`) that `attemptDirectoryMatchOnOidcLogin`
already expects.

## Decision

Add a mock-OIDC login route, `POST /v1/auth/mock-login`, backed by a committed local
test keypair. No outbound network calls, no live IdP — the relay verifies the token
against a keypair it already holds.

### Auth model

The route requires an already-authenticated `principal.human_id`, exactly like every
other human-scoped route in `http-server.mjs` (`/v1/account-links`, `/v1/identities`,
`/v1/identities/revoke`). The caller already holds an endpoint bearer token whose
owner is the human in question; the mock ID-token supplies a verified email claim for
*that already-known human*, not a fresh identity bootstrap. This matches the existing
auth model exactly and needs no new session-establishment plumbing.

Rejected: a standalone unauthenticated bootstrap route that establishes human
identity purely from the ID token. Nothing else in this codebase authenticates a
human that way — every human-scoped route derives `human_id` from an authenticated
endpoint's bearer token — and building a second, parallel auth model for this one
route would be new scope disproportionate to the problem.

### Signing/verification

Hand-rolled ES256 (P-256) JWS sign/verify via `node:crypto`, matching this repo's
existing convention of hand-rolling its own crypto/parsing rather than adding
dependencies (see `parseAttestationObject`/`verifyPackedAttestation` in
`http-server.mjs` for the webauthn precedent). No new dependency.

A committed fixture, `sigil/relay/v1/fixtures/mock-oidc-keys.json`, holds a fixed
P-256 keypair and a fixed issuer string (e.g. `https://mock-oidc.sigil.local`). Both
the signer (test/dev-only, never exposed over HTTP) and the verifier (used by the
route) load this same fixture, so trust is entirely local — no JWKS endpoint, no
outbound fetch.

**Header/algorithm hardening (classic JWT bypass protection):** `verifyMockIdToken`
must explicitly parse the JWS header and require `header.alg === 'ES256'` exactly,
before touching the signature. Any other declared algorithm — `none`, `RS256`,
`HS256`, or anything else — is a hard rejection (`INVALID_ID_TOKEN`), regardless of
whether a signature is present. This is the standard alg-confusion/none-alg mitigation
a hand-rolled verifier must not skip.

### Impersonation: already closed, not new work

A natural-sounding extra guard — "verify the claim's subject/issuer match the calling
endpoint's registered owner binding" — does **not** apply here and is deliberately
not implemented. `claimDirectoryMatch` (already shipped in both repositories) has no
such binding to check: OIDC-match is a *first-contact* flow where a stranger creates a
match request naming a target email before knowing who owns it. There is no
pre-existing subject/issuer→human mapping to compare against; requiring one would
make the feature permanently unable to fire.

The actual impersonation risk — a compromised endpoint claiming a match on behalf of
an arbitrary human — is already closed by construction: `matchedHumanId` passed to
`attemptDirectoryMatchOnOidcLogin` is always `principal.human_id`, resolved from the
trusted bearer-auth registry, **never** read from the token body or its claims. A
forged or attacker-supplied email claim can only ever be evaluated against the match
requests pending for the human the caller is already authenticated as — the same
resolve-from-trusted-registry principle already applied to the same-owner exemption
fix in `accept-envelope.mjs` (commit `e6de533`).

### Replay/double-matching: already closed, not new work

`claimDirectoryMatch`'s existing `status = 'pending'` guard plus the partial unique
index on `directory_links` (`WHERE status IN ('pending', 'active')`, documented in
`docs/specs/sigil-endpoint-directory-trust-spec-v1.0.md` around the containment-check
paragraph) already prevent a match request from being claimed twice or a link from
being created twice for the same pair. A second claim attempt against an
already-matched or expired request simply returns `null`. This route relies on that
existing guarantee; it does not need its own locking.

### Session record

The route also calls `repository.createHumanSession`, which exists in
`postgres-repository.mjs` today but is unused. Adding a call here gives the mock
login route a durable audit record (`human_sessions` row + `human_session.created`
audit event, mirroring the pattern at `http-server.mjs:360`), not just a bare match
attempt. Session TTL: 5 minutes, matching the mock ID-token's own TTL — short enough
that a test/dev session doesn't linger.

`memory-repository.mjs` gets a matching `createHumanSession` (and a `humanSessions`
Map) for backend parity — `claimDirectoryMatch` already exists there, so only the
session half is missing.

## Route contract

```
POST /v1/auth/mock-login
Authorization: <endpoint bearer token>   (principal.human_id required)

{ "id_token": "<compact ES256 JWS>" }
```

- Missing `principal.human_id` → `403 HUMAN_CONTEXT_REQUIRED` (matches every other
  human-scoped route's error shape).
- Malformed / bad-alg / bad-signature / expired token → `401 INVALID_ID_TOKEN`.
- Success → `201`:
  ```json
  { "request_id": "...", "code": "OK", "session": { ... }, "match": { "request_id": "..." } | null }
  ```
  `match` is `null` when no pending, unexpired `directory_match_requests` row exists
  for that issuer + verified email — this is not an error, just "nothing to claim
  yet."

## Components

- `sigil/relay/v1/fixtures/mock-oidc-keys.json` — committed P-256 keypair + issuer
  string.
- `sigil/relay/v1/mock-oidc.mjs`:
  - `signMockIdToken({ subject, email, issuer, now, ttlSeconds = 300 })` → compact
    JWS string. Exported for tests/dev tooling only; not reachable over HTTP.
  - `verifyMockIdToken(token, { now })` → `{ issuer, subject, email }` or throws
    `{ code: 'INVALID_ID_TOKEN', message }`.
- `sigil/relay/v1/http-server.mjs`: new `POST /v1/auth/mock-login` route, placed
  alongside the other human-scoped routes.
- `sigil/cli/memory-repository.mjs`: `humanSessions` Map + `createHumanSession`.

## Testing

- `mock-oidc.test.mjs`: sign/verify round trip; tampered signature rejected;
  expired token rejected; wrong/missing `alg` (including `none`) rejected; malformed
  compact-JWS rejected.
- `http-server` integration tests, run against both repositories:
  - success path creates a session and fires a match when one is pending.
  - success path with no pending match → `match: null`, session still created.
  - missing `principal.human_id` → `403`.
  - bad token → `401`, no session created.

## Out of scope

- Any live/external OIDC client, JWKS-over-HTTPS fetch, or IdP integration — tracked
  separately per `docs/meta/sigil-cli-roadmap.md` if ever pursued.
- A JWKS HTTP endpoint for the mock keys — verification is local-only by design, so
  none is needed.
