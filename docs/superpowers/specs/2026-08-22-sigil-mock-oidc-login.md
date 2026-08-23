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
against a keypair it already holds. **This route simulates an OIDC login for
test/dev purposes; it is never real authentication.** Everywhere below that would
otherwise say "verified email," read "fixture-asserted email" — the value is only as
trustworthy as the fixture private key, which is committed to the repo and must never
be treated as a production credential.

### Production gate (default-off)

A committed private key is readable by anyone with repository access. Combined with
an authenticated bearer token for *any* human, that's enough to mint a
fixture-asserted email claim and claim any pending directory match — this route must
never be reachable unless someone has explicitly opted in.

`createRelayServer` gets a new option, `enableMockOidc = false`. When falsy, `POST
/v1/auth/mock-login` doesn't exist as a route at all (falls through to the normal
404 path, not a 403 — don't reveal the route exists). `sigil relay up` exposes this
as `--enable-mock-oidc` (or `SIGIL_ENABLE_MOCK_OIDC=1`), and the CLI/README must call
out that this flag is for local development and CI only, never a relay reachable from
untrusted networks. This mirrors how `oidcIssuerAllowList` is already an explicit
opt-in set rather than "anything works by default."

### Auth model

The route requires an already-authenticated `principal.human_id`, exactly like every
other human-scoped route in `http-server.mjs` (`/v1/account-links`, `/v1/identities`,
`/v1/identities/revoke`). The caller already holds an endpoint bearer token whose
owner is the human in question; the mock ID-token supplies a fixture-asserted email claim for
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

**Required claims.** The payload must carry exactly: `iss`, `sub`, `email`,
`email_verified`, `iat`, `exp`, `jti` (added below, for replay protection). All seven
are mandatory — missing any of them is `INVALID_ID_TOKEN`. `email_verified` must be
the literal boolean `true`; `false` or absent is rejected the same way a bad
signature is. `signMockIdToken` always sets `email_verified: true` (there's no
fixture use case for asserting an unverified email) and generates a fresh random
`jti` (`crypto.randomUUID()`) per call.

**Time semantics.** `iat`/`exp` are NumericDate (integer seconds since epoch), per
JWT convention. `signMockIdToken({ ..., now, ttlSeconds = 300 })` sets `iat =
floor(now / 1000)` and `exp = iat + ttlSeconds`; if a caller passes `ttlSeconds <= 0`
the signer throws synchronously (never produces a token where `exp <= iat`).
`verifyMockIdToken(token, { now })` takes `now` as an explicit, injectable parameter
(defaulting to `() => new Date()` like the rest of `http-server.mjs`) so tests can
control time without real delays. Verification applies ±30s clock-skew leeway on
both bounds — reject if `nowSeconds > exp + 30` or `nowSeconds < iat - 30` — matching
the tolerance a real OIDC verifier would apply, even though skew is largely moot for
a same-process time source.

### Issuer allow-listing (PostgreSQL)

`directory_match_requests.issuer` has a hard foreign key to
`oidc_issuer_allowlist(issuer)` (`sigil/migrations/012_directory_trust.sql:35`). The
fixture issuer (`https://mock-oidc.sigil.local`) must exist in that table or
`claimDirectoryMatch` never has a row to match against on PostgreSQL — the whole
route would silently no-op (`match: null` always) against a real repository, which
would look like a bug, not the advertised success path.

Handling: when `enableMockOidc` is true, `createRelayServer`'s startup path
`UPSERT`s the fixture issuer into `oidc_issuer_allowlist` (`enabled = true,
assurance_level = 'standard'`) before serving requests — scoped strictly to the
opt-in flag, so a production relay that never sets `--enable-mock-oidc` never touches
this table for the fixture issuer. `memory-repository.mjs`'s `claimDirectoryMatch`
has no allow-list enforcement at all today (matches on raw issuer-string equality),
so no memory-side change is needed there. Tests that exercise the PostgreSQL path
seed the row directly with `INSERT INTO oidc_issuer_allowlist ...`, matching the
existing convention in `postgres-repository.directory-match.test.mjs:30`.

### Replay protection

The directory-match claim itself is already single-use (`claimDirectoryMatch` only
matches `status = 'pending'` rows), but nothing stops the *same valid token* from
being replayed to mint unlimited five-minute sessions before it expires — session
creation has no idempotency of its own.

Add a `jti` uniqueness guard: a new table, `mock_login_replays (jti TEXT PRIMARY
KEY, expires_at TIMESTAMPTZ NOT NULL)`, and the route inserts the token's `jti`
before/alongside creating the session. The primary-key uniqueness constraint makes
a second use of the same token fail the insert; the route reports `401
TOKEN_REPLAYED` in that case. A cheap periodic or lazy delete of rows past
`expires_at` keeps the table bounded (out of scope to spec the sweep mechanism here
— any of the repo's existing rate-window-style cleanup patterns applies).
`memory-repository.mjs` gets a matching `consumedMockLoginJtis` `Map<jti,
expiresAt>`, checked and inserted the same way.

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

### Session record and atomicity

The route also calls `repository.createHumanSession`, which exists in
`postgres-repository.mjs` today but is unused. Adding a call here gives the mock
login route a durable audit record (`human_sessions` row + `human_session.created`
audit event, mirroring the pattern at `http-server.mjs:360`), not just a bare match
attempt. Session TTL: 5 minutes, matching the mock ID-token's own TTL — short enough
that a test/dev session doesn't linger.

The route performs four writes per successful call: consume the `jti` (replay guard),
create the human session, record the audit event, and (conditionally) claim a
directory match. These must not partially apply — a mid-sequence failure must not
leave a consumed `jti` with no session, or a session with no audit row. On
PostgreSQL, the whole sequence runs inside one `repository.withTransaction(...)`
(already used elsewhere in this file, e.g. `acceptEnvelopeAsync`'s repository-aware
path), so any thrown error rolls back all four writes together and the route
responds with the underlying error's status instead of a partial `201`.
`memory-repository.mjs`'s `withTransaction` is `async (fn) => fn(null)` — a no-op
passthrough — which is safe here because every memory-repository write in this route
is a synchronous, single-process `Map` mutation with no `await` between them, so
there is no window in which a partial-failure interleaving is observable.

`memory-repository.mjs` gets a matching `createHumanSession` (and a `humanSessions`
Map) for backend parity — `claimDirectoryMatch` already exists there, so only the
session half is missing.

## Route contract

```
POST /v1/auth/mock-login
Authorization: <endpoint bearer token>   (principal.human_id required)

{ "id_token": "<compact ES256 JWS>" }
```

- `enableMockOidc` false → route does not exist (`404`, same as any unmatched path
  — never reveal the feature is present but gated).
- Missing `principal.human_id` → `403 HUMAN_CONTEXT_REQUIRED` (matches every other
  human-scoped route's error shape).
- Malformed / bad-alg / bad-signature / expired / missing-required-claim /
  `email_verified !== true` token → `401 INVALID_ID_TOKEN`.
- Already-consumed `jti` → `401 TOKEN_REPLAYED`.
- Success → `201`:
  ```json
  { "request_id": "...", "code": "OK", "session": { ... }, "match": { "request_id": "..." } | null }
  ```
  `match` is `null` when no pending, unexpired `directory_match_requests` row exists
  for that issuer + fixture-asserted email — this is not an error, just "nothing to
  claim yet."

## Components

- `sigil/relay/v1/fixtures/mock-oidc-keys.json` — committed P-256 keypair + issuer
  string.
- `sigil/relay/v1/mock-oidc.mjs`:
  - `signMockIdToken({ subject, email, issuer, now, ttlSeconds = 300 })` → compact
    JWS string, `email_verified: true` and a fresh `jti` always set. Exported for
    tests/dev tooling only; not reachable over HTTP.
  - `verifyMockIdToken(token, { now })` → `{ issuer, subject, email, jti }` or throws
    `{ code: 'INVALID_ID_TOKEN', message }`.
- `sigil/relay/v1/http-server.mjs`: new `POST /v1/auth/mock-login` route (gated
  behind `enableMockOidc`), placed alongside the other human-scoped routes. New
  `createRelayServer` option `enableMockOidc = false`.
- `sigil/migrations/0NN_mock_login_replays.sql` (or folded into the mock-oidc work
  as its own migration): `mock_login_replays (jti TEXT PRIMARY KEY, expires_at
  TIMESTAMPTZ NOT NULL)`.
- `sigil/relay/v1/postgres-repository.mjs`: `consumeMockLoginJti(jti, { now,
  expiresAt })` (insert-or-throw-on-conflict) and the `oidc_issuer_allowlist` upsert
  run at startup when `enableMockOidc` is true.
- `sigil/cli/memory-repository.mjs`: `humanSessions` Map + `createHumanSession`;
  `consumedMockLoginJtis` Map + `consumeMockLoginJti`.

## Testing

- `mock-oidc.test.mjs`: sign/verify round trip; tampered signature rejected;
  expired token rejected (including exactly-at-skew-boundary cases); `exp <= iat`
  rejected at sign time; wrong/missing `alg` (including `none`) rejected; malformed
  compact-JWS rejected; missing any of the seven required claims rejected;
  `email_verified: false` and `email_verified` absent both rejected.
- `http-server` integration tests, run against both repositories:
  - `enableMockOidc: false` (default) → route returns `404`.
  - success path creates a session and fires a match when one is pending.
  - success path with no pending match → `match: null`, session still created.
  - missing `principal.human_id` → `403`, no writes performed.
  - bad token (signature/alg/claims) → `401 INVALID_ID_TOKEN`, no writes performed.
  - replayed token (same `jti` twice) → second call `401 TOKEN_REPLAYED`, only one
    session/audit row exists.
  - wrong issuer (not the fixture issuer, or — PostgreSQL only — not present in
    `oidc_issuer_allowlist`) → token still verifies (signature is what's checked),
    but the match half returns `null` rather than erroring.
  - oversized request body → same `413` handling as every other route (via
    `readBody`), asserted for this route specifically.
  - simulated mid-sequence failure (e.g. `createHumanSession` rejects) on
    PostgreSQL → the transaction rolls back; the `jti` is *not* left consumed, so
    retrying the exact same token afterward succeeds.
  - audit event payload assertion: `human_session.created` row's `actor_human_id`,
    `endpoint_id`, `subject_id`, `outcome` match the created session.

## Out of scope

- Any live/external OIDC client, JWKS-over-HTTPS fetch, or IdP integration — tracked
  separately per `docs/meta/sigil-cli-roadmap.md` if ever pursued.
- A JWKS HTTP endpoint for the mock keys — verification is local-only by design, so
  none is needed.
