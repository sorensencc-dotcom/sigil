# Handoff: mock-OIDC login implementation plan (not yet written)

**State:** Spec approved and committed/pushed (2 commits: `7bcdf49` initial,
`89781f9` revised after review). Plan-writing (writing-plans skill) was
in progress, mid-research, when this session paused at the 2-3h
session-length checkpoint.

**Spec:** `docs/superpowers/specs/2026-08-22-sigil-mock-oidc-login.md` — read
this first, it's the source of truth. Summary: add `POST
/v1/auth/mock-login`, gated behind `enableMockOidc` (default off), hand-rolled
ES256 JWS verify against a committed fixture keypair, existing bearer-auth
principal for `human_id` (no new session-bootstrap model), mandatory
`iss/sub/email/email_verified/iat/exp/jti` claims, jti-based replay
protection, and wiring into the already-shipped
`attemptDirectoryMatchOnOidcLogin` (`sigil/relay/v1/directory-trust.mjs`).

## Next step

Resume with `superpowers:writing-plans`, argument: implement the spec above.
Save the plan to `docs/superpowers/plans/2026-08-22-sigil-mock-oidc-login.md`
(note: NOT the `-HANDOFF` suffix — that's this file only) and delete this
handoff file once the real plan exists.

## Research already done this session (don't re-derive — verified against the repo)

1. **`claimDirectoryMatch` opens its own internal transaction** (postgres-repository.mjs:280-294,
   `return this.withTransaction(async (client) => {...})`) — it does **not**
   accept an external `client` param. This breaks the spec's "one
   `repository.withTransaction` wraps all four writes" atomicity requirement
   as currently written. **Needs a small refactor task**: give
   `claimDirectoryMatch` an optional `client` param (skip the internal
   `withTransaction` wrapper when one is passed), same pattern already used
   by `reserveRateLimit(scopeKind, scopeId, windowStart, limit, client =
   this.pool)` (postgres-repository.mjs:462) — that exact default-param
   pattern was itself added in commit `139117e` to fix an identical gap for
   the directory routes. `createHumanSession` (line 628) and
   `recordAuditEvent` (line 862) also currently hardcode `this.pool.query`
   with no `client` param — both need the same `client = this.pool`
   treatment to participate in the route's transaction. Add this as an
   explicit task before the route-handler task.

2. **Next migration number is `013`** (`sigil/migrations/012_directory_trust.sql`
   is the latest). Follow that file's idempotent `CREATE TABLE IF NOT
   EXISTS` convention for the new `mock_login_replays (jti TEXT PRIMARY KEY,
   expires_at TIMESTAMPTZ NOT NULL)` table.

3. **`directory_match_requests.issuer` has a hard FK to
   `oidc_issuer_allowlist(issuer)`** (migrations/012_directory_trust.sql:35).
   The fixture issuer must be upserted into that table when `enableMockOidc`
   is true (spec already covers this — see "Issuer allow-listing" section)
   or every match attempt fails the FK on Postgres.

4. **Existing helpers to reuse, not reinvent:**
   - `assertAssurance(assurance)` (`auth-policy.mjs:34`) — validates
     `'low'|'standard'|'high'`; call with `'standard'` for the mock session.
   - `readBody(request, maxBytes = 1024*1024)` (`http-server.mjs:23`) — every
     route uses this exact try/catch → `413` pattern; copy it verbatim, see
     any existing route (e.g. `http-server.mjs:347-351` for `/v1/account-links`)
     for the full error-response shape convention (`writeHead` +
     `JSON.stringify({ request_id, code, message, details: {} })`).
   - `createRelayServer`'s options object is at `http-server.mjs:29` — add
     `enableMockOidc = false` there.

5. **Test harness patterns, two tiers:**
   - **Lightweight (no real Postgres)**: `sigil/relay/v1/http-server.test.mjs`
     builds a hand-written fake `repository` object with only the methods a
     given test needs (see lines 21-26 for the shape), spins up
     `createRelayServer` on a real ephemeral port, and uses the `request()`
     helper at the bottom of that file (line 670) to drive HTTP calls. Use
     this tier for: `enableMockOidc: false` → 404, missing principal → 403,
     bad token → 401, replay → 401 (fake repo can simulate jti-conflict
     without real Postgres constraints).
   - **Live-Postgres**: `sigil/integration/vertical-slice.test.mjs` — see
     `bootstrapLiveRelay(t)` (line 28) for the full real-DB bootstrap
     (drops/recreates schema, runs all migrations, seeds humans/endpoints,
     wires bearer-token auth). Tests are gated with `{ skip: !connectionString
     }` where `connectionString = process.env.SIGIL_TEST_DATABASE_URL`
     (line 19, line 214 for the skip-option usage). Use this tier for: FK/
     allow-list behavior, real transactional rollback, real jti uniqueness
     constraint.
   - `node --test` auto-discovers all `*.test.mjs` recursively — no manual
     registration needed for new test files.

6. **Signing/verify module location decided in spec:**
   `sigil/relay/v1/mock-oidc.mjs` + `sigil/relay/v1/fixtures/mock-oidc-keys.json`.
   Not yet started — no code written yet for any part of this feature,
   only the spec doc exists.

## What's NOT decided yet (resolve while writing the plan, not blocking)

- Exact migration filename for `013_...` (pick a descriptive name, e.g.
  `013_mock_login_replays.sql`).
- Whether the `enableMockOidc` CLI flag on `sigil relay up` is a plan task
  or explicitly deferred (spec mentions it should exist; confirm scope with
  the user if unclear when writing the plan — it's a small CLI-arg-parsing
  addition, likely in-scope).
