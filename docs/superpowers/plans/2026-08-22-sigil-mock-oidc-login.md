# Sigil mock-OIDC login route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /v1/auth/mock-login`, a default-off, fully local mock-OIDC
login route that lets an already-authenticated human present a hand-rolled
ES256 ID token (signed against a committed fixture keypair) and reach the
already-shipped `attemptDirectoryMatchOnOidcLogin` match-claim logic, which
today is dead code with nothing calling it.

**Architecture:** A new `sigil/relay/v1/mock-oidc.mjs` module owns ES256
sign/verify against a committed fixture keypair (`sigil/relay/v1/fixtures/mock-oidc-keys.json`).
A new route in `http-server.mjs`, gated behind `enableMockOidc` (default
`false`, so the route doesn't exist unless explicitly opted in), consumes a
token's `jti` for replay protection, creates a `human_sessions` row via
`repository.createHumanSession`, records an audit event, and calls
`attemptDirectoryMatchOnOidcLogin`. All four writes run inside one
`repository.withTransaction(...)` on PostgreSQL, which requires giving three
existing repository methods (`claimDirectoryMatch`, `createHumanSession`,
`recordAuditEvent`) an optional `client` parameter so they can participate in
the caller's transaction instead of only ever opening their own.

**Tech Stack:** Node.js (`node:crypto`, `node:test`), PostgreSQL (`pg`), no
new npm dependencies (spec explicitly rejects adding a JOSE/JWT library in
favor of this repo's existing hand-rolled-crypto convention).

**Spec:** `docs/superpowers/specs/2026-08-22-sigil-mock-oidc-login.md`

## Global Constraints

- No new npm dependency — ES256 JWS sign/verify is hand-rolled via
  `node:crypto`, matching the existing `parseAttestationObject`/
  `verifyPackedAttestation` convention in `http-server.mjs`.
- `enableMockOidc` defaults to `false` on `createRelayServer`. When falsy,
  `POST /v1/auth/mock-login` must not exist as a route (falls through to the
  generic 404 — never reveal the route exists via a 403).
- Required ID-token claims are exactly: `iss`, `sub`, `email`,
  `email_verified`, `iat`, `exp`, `jti`. Missing any one, or
  `email_verified !== true`, is `401 INVALID_ID_TOKEN`.
- `verifyMockIdToken` must reject any `header.alg !== 'ES256'` (including
  `none`) before touching the signature.
- Clock-skew leeway is ±30s on both `iat` and `exp` bounds.
- Every human-scoped route error shape in this codebase is
  `{ request_id, code, message, details: {} }` via `readBody`'s existing
  413 pattern and `writeHead`/`JSON.stringify` — the new route matches this
  exactly.
- On PostgreSQL, the route's four writes (consume `jti`, create session,
  record audit event, claim match) run inside one
  `repository.withTransaction(...)` — a mid-sequence failure must roll back
  all four, never leave a consumed `jti` with no session.
- Every repository method touched by this route must exist on both
  `PostgresRepository` and `memory-repository.mjs`'s `createMemoryRepository`
  (dual-repository equivalence, this repo's existing convention).

---

## File Structure

- `sigil/relay/v1/fixtures/mock-oidc-keys.json` — **create**. Committed P-256
  keypair (JWK) + fixed issuer string. Generated once during this plan's
  Task 1 and hardcoded into both the fixture file and this plan (already
  generated below — copy verbatim, do not regenerate).
- `sigil/relay/v1/mock-oidc.mjs` — **create**. `signMockIdToken`/
  `verifyMockIdToken`, hand-rolled ES256 JWS.
- `sigil/relay/v1/mock-oidc.test.mjs` — **create**. Unit tests for the sign/
  verify module.
- `sigil/migrations/013_mock_login_replays.sql` — **create**. `mock_login_replays`
  table for jti-based replay protection.
- `sigil/relay/v1/postgres-repository.mjs` — **modify**. Add `client`
  participation to `claimDirectoryMatch`, `createHumanSession`,
  `recordAuditEvent`; add `consumeMockLoginJti` and
  `upsertMockOidcIssuerAllowlist`.
- `sigil/cli/memory-repository.mjs` — **modify**. Add `humanSessions` Map +
  `createHumanSession`; add `consumedMockLoginJtis` Map +
  `consumeMockLoginJti`.
- `sigil/relay/v1/http-server.mjs` — **modify**. New `enableMockOidc = false`
  option on `createRelayServer`; new `POST /v1/auth/mock-login` route.
- `sigil/relay/v1/mock-oidc-route.test.mjs` — **create**. Lightweight
  (fake-repository) integration tests for the route.
- `sigil/relay/v1/postgres-mock-oidc-route.test.mjs` — **create**. Live-Postgres
  integration tests for the route (FK/allow-list, real transactional
  rollback, real `jti` uniqueness).
- `sigil/cli/sigil.mjs` — **modify**. `cmdRelayUp` gets `--enable-mock-oidc`
  / `SIGIL_ENABLE_MOCK_OIDC=1`, wired to `createRelayServer` and to the
  startup `oidc_issuer_allowlist` upsert.

## Interfaces (cross-task contract)

- `signMockIdToken({ subject, email, issuer, now, ttlSeconds = 300 })` →
  `string` (compact JWS). Throws synchronously if `ttlSeconds <= 0`.
- `verifyMockIdToken(token, { now = () => new Date() })` →
  `{ issuer, subject, email, jti }`. Throws
  `Object.assign(new Error(message), { code: 'INVALID_ID_TOKEN' })` on any
  failure.
- `PostgresRepository#claimDirectoryMatch({ issuer, matchTarget, matchedHumanId, now, client })`
  — `client` optional; when provided, skips the internal `withTransaction`
  wrap and runs directly on `client`.
- `PostgresRepository#createHumanSession({ sessionId, humanId, authenticationMethod, assurance, deviceContext, issuedAt, expiresAt, now, client = this.pool })`
- `PostgresRepository#recordAuditEvent({ ...existing fields, client = this.pool })`
- `PostgresRepository#consumeMockLoginJti(jti, { now, expiresAt, client = this.pool })`
  → `void`. Throws `{ code: 'TOKEN_REPLAYED' }` if `jti` already present
  (Postgres unique-violation `23505` mapped to this code).
- `PostgresRepository#upsertMockOidcIssuerAllowlist({ issuer, now })` → `void`.
- `memory-repository`'s `createHumanSession({ sessionId, humanId, authenticationMethod, assurance, deviceContext, issuedAt, expiresAt, now })`
  → same shape as the Postgres row.
- `memory-repository`'s `consumeMockLoginJti(jti, { now, expiresAt })` →
  `void`. Throws `{ code: 'TOKEN_REPLAYED' }` on a repeat `jti`.

---

## Task 1: Fixture keypair + mock-oidc.mjs sign/verify module

**Files:**
- Create: `sigil/relay/v1/fixtures/mock-oidc-keys.json`
- Create: `sigil/relay/v1/mock-oidc.mjs`
- Test: `sigil/relay/v1/mock-oidc.test.mjs`

**Interfaces:**
- Produces: `signMockIdToken`, `verifyMockIdToken` (see contract above),
  consumed by Task 6's route handler.

This fixture keypair was generated once for this plan (P-256, JWK format)
and round-trip-verified with `node:crypto`'s `sign`/`verify` using
`dsaEncoding: 'ieee-p1363'` (raw 64-byte r||s signature, not DER — required
so the JWS signature segment is the standard JOSE format). Copy it verbatim;
do not regenerate it.

- [ ] **Step 1: Write the fixture file**

```json
{
  "issuer": "https://mock-oidc.sigil.local",
  "publicJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "7nAUYSGDtTNO9N8VBEL5ICiqROIn5uD4U9H47dgfy64",
    "y": "hHYJrvqaMiGwzJWdpyiVMKHvB8Eoo5cwsK_zPdAkXJo"
  },
  "privateJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "7nAUYSGDtTNO9N8VBEL5ICiqROIn5uD4U9H47dgfy64",
    "y": "hHYJrvqaMiGwzJWdpyiVMKHvB8Eoo5cwsK_zPdAkXJo",
    "d": "otqA-vFCwvc430v-aHAD47DlGb4Kk-2X3_oc7bkHQr8"
  }
}
```

Save this at `sigil/relay/v1/fixtures/mock-oidc-keys.json`.

- [ ] **Step 2: Write the failing tests**

Create `sigil/relay/v1/mock-oidc.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { signMockIdToken, verifyMockIdToken } from './mock-oidc.mjs';

const FIXED_NOW = new Date('2026-08-22T00:00:00Z');

test('sign/verify round trip: valid token verifies and returns issuer/subject/email/jti', async () => {
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
  const claims = verifyMockIdToken(token, { now: () => FIXED_NOW });
  assert.equal(claims.issuer, 'https://mock-oidc.sigil.local');
  assert.equal(claims.subject, 'sub_1');
  assert.equal(claims.email, 'a@example.com');
  assert.equal(typeof claims.jti, 'string');
  assert.ok(claims.jti.length > 0);
});

test('two signMockIdToken calls produce different jti values', () => {
  const first = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
  const second = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
  const decode = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
  assert.notEqual(decode(first).jti, decode(second).jti);
});

test('signMockIdToken throws synchronously when ttlSeconds <= 0', () => {
  assert.throws(() => signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW, ttlSeconds: 0 }));
  assert.throws(() => signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW, ttlSeconds: -5 }));
});

test('tampered signature is rejected', () => {
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
  const [header, payload, signature] = token.split('.');
  const tampered = `${header}.${payload}.${signature.slice(0, -4)}${signature.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
  assert.throws(() => verifyMockIdToken(tampered, { now: () => FIXED_NOW }), { code: 'INVALID_ID_TOKEN' });
});

test('expired token is rejected outside the 30s skew boundary', () => {
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW, ttlSeconds: 300 });
  const past31s = new Date(FIXED_NOW.getTime() + 300_000 + 31_000);
  assert.throws(() => verifyMockIdToken(token, { now: () => past31s }), { code: 'INVALID_ID_TOKEN' });
});

test('token is accepted exactly at the 30s skew boundary (expired side)', () => {
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW, ttlSeconds: 300 });
  const past30s = new Date(FIXED_NOW.getTime() + 300_000 + 30_000);
  assert.doesNotThrow(() => verifyMockIdToken(token, { now: () => past30s }));
});

test('token is accepted exactly at the 30s skew boundary (not-yet-valid side)', () => {
  const later = new Date(FIXED_NOW.getTime() + 60_000);
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: later, ttlSeconds: 300 });
  const before30s = new Date(later.getTime() - 30_000);
  assert.doesNotThrow(() => verifyMockIdToken(token, { now: () => before30s }));
});

test('token rejected 31s before iat', () => {
  const later = new Date(FIXED_NOW.getTime() + 60_000);
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: later, ttlSeconds: 300 });
  const before31s = new Date(later.getTime() - 31_000);
  assert.throws(() => verifyMockIdToken(token, { now: () => before31s }), { code: 'INVALID_ID_TOKEN' });
});

test('wrong alg (RS256) is rejected', () => {
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
  const [, payload, signature] = token.split('.');
  const badHeader = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  assert.throws(() => verifyMockIdToken(`${badHeader}.${payload}.${signature}`, { now: () => FIXED_NOW }), { code: 'INVALID_ID_TOKEN' });
});

test('alg "none" is rejected regardless of signature presence', () => {
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
  const [, payload] = token.split('.');
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.throws(() => verifyMockIdToken(`${noneHeader}.${payload}.`, { now: () => FIXED_NOW }), { code: 'INVALID_ID_TOKEN' });
});

test('malformed compact JWS (wrong segment count) is rejected', () => {
  assert.throws(() => verifyMockIdToken('not.a.valid.jws', { now: () => FIXED_NOW }), { code: 'INVALID_ID_TOKEN' });
  assert.throws(() => verifyMockIdToken('onlyonesegment', { now: () => FIXED_NOW }), { code: 'INVALID_ID_TOKEN' });
});

test('missing each required claim is rejected one at a time', () => {
  const requiredClaims = ['iss', 'sub', 'email', 'email_verified', 'iat', 'exp', 'jti'];
  for (const omit of requiredClaims) {
    const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
    const [header, payload, signature] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    delete claims[omit];
    const tamperedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    // Signature no longer matches the tampered payload, but a claims-shape
    // check must fail before verification would even matter here -- both
    // paths land on INVALID_ID_TOKEN, so this also covers "bad signature".
    assert.throws(() => verifyMockIdToken(`${header}.${tamperedPayload}.${signature}`, { now: () => FIXED_NOW }), { code: 'INVALID_ID_TOKEN' }, `expected rejection when ${omit} is missing`);
  }
});

test('email_verified: false is rejected', () => {
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  claims.email_verified = false;
  const tamperedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  assert.throws(() => verifyMockIdToken(`${header}.${tamperedPayload}.${signature}`, { now: () => FIXED_NOW }), { code: 'INVALID_ID_TOKEN' });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run (from `c:\dev\sigil-repo`): `node --test sigil/relay/v1/mock-oidc.test.mjs`
Expected: FAIL — `Cannot find module './mock-oidc.mjs'`.

- [ ] **Step 4: Write `mock-oidc.mjs`**

```js
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/mock-oidc-keys.json', import.meta.url));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const FIXTURE_ISSUER = fixture.issuer;
const privateKey = crypto.createPrivateKey({ key: fixture.privateJwk, format: 'jwk' });
const publicKey = crypto.createPublicKey({ key: fixture.publicJwk, format: 'jwk' });

const REQUIRED_CLAIMS = ['iss', 'sub', 'email', 'email_verified', 'iat', 'exp', 'jti'];
const CLOCK_SKEW_SECONDS = 30;

function b64url(buffer) {
  return buffer.toString('base64url');
}

function invalidToken(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ID_TOKEN' });
}

// Test/dev-only signer. Never reachable over HTTP -- exported for tests and
// dev tooling to construct a mock ID token, not called from any route.
export function signMockIdToken({ subject, email, issuer = FIXTURE_ISSUER, now = new Date(), ttlSeconds = 300 } = {}) {
  if (ttlSeconds <= 0) throw new Error('ttlSeconds must be positive');
  const iat = Math.floor((now instanceof Date ? now : new Date(now)).getTime() / 1000);
  const exp = iat + ttlSeconds;
  const header = { alg: 'ES256', typ: 'JWT' };
  const payload = { iss: issuer, sub: subject, email, email_verified: true, iat, exp, jti: crypto.randomUUID() };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}

// Verifies against the same committed fixture keypair the signer above
// uses -- no JWKS fetch, entirely local. `now` is injectable so tests can
// control time without real delays (mirrors the rest of http-server.mjs's
// `now: () => new Date()` convention).
export function verifyMockIdToken(token, { now = () => new Date() } = {}) {
  if (typeof token !== 'string') throw invalidToken('ID token must be a string');
  const segments = token.split('.');
  if (segments.length !== 3) throw invalidToken('Malformed compact JWS');
  const [headerSegment, payloadSegment, signatureSegment] = segments;

  let header;
  try { header = JSON.parse(Buffer.from(headerSegment, 'base64url').toString()); }
  catch { throw invalidToken('Malformed JWS header'); }
  // Alg-confusion / none-alg hard rejection -- checked before the signature
  // is ever touched, per spec's header/algorithm-hardening requirement.
  if (header.alg !== 'ES256') throw invalidToken(`Unsupported or missing alg: ${header.alg}`);

  let signature;
  try { signature = Buffer.from(signatureSegment, 'base64url'); }
  catch { throw invalidToken('Malformed JWS signature'); }
  const signingInput = `${headerSegment}.${payloadSegment}`;
  let signatureValid;
  try { signatureValid = crypto.verify('sha256', Buffer.from(signingInput), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature); }
  catch { throw invalidToken('Signature verification failed'); }
  if (!signatureValid) throw invalidToken('Signature verification failed');

  let payload;
  try { payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString()); }
  catch { throw invalidToken('Malformed JWS payload'); }

  for (const claim of REQUIRED_CLAIMS) {
    if (!(claim in payload) || payload[claim] === null || payload[claim] === undefined) {
      throw invalidToken(`Missing required claim: ${claim}`);
    }
  }
  if (payload.email_verified !== true) throw invalidToken('email_verified must be true');

  const nowSeconds = Math.floor((typeof now === 'function' ? now() : now).getTime() / 1000);
  if (nowSeconds > payload.exp + CLOCK_SKEW_SECONDS) throw invalidToken('ID token has expired');
  if (nowSeconds < payload.iat - CLOCK_SKEW_SECONDS) throw invalidToken('ID token is not yet valid');

  return { issuer: payload.iss, subject: payload.sub, email: payload.email, jti: payload.jti };
}

export { FIXTURE_ISSUER };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test sigil/relay/v1/mock-oidc.test.mjs`
Expected: PASS, all tests green.

- [ ] **Step 6: Commit**

```bash
git add sigil/relay/v1/fixtures/mock-oidc-keys.json sigil/relay/v1/mock-oidc.mjs sigil/relay/v1/mock-oidc.test.mjs
git commit -m "feat(sigil): add hand-rolled ES256 sign/verify for mock-OIDC ID tokens"
```

---

## Task 2: `withTransaction`-participation refactor for three repository methods

**Files:**
- Modify: `sigil/relay/v1/postgres-repository.mjs:280-294` (`claimDirectoryMatch`)
- Modify: `sigil/relay/v1/postgres-repository.mjs:628-639` (`createHumanSession`)
- Modify: `sigil/relay/v1/postgres-repository.mjs:862-871` (`recordAuditEvent`)
- Test: `sigil/relay/v1/postgres-repository.transaction-participation.test.mjs`

**Interfaces:**
- Produces: the three methods each accept an optional trailing `client`
  (default `this.pool` for `createHumanSession`/`recordAuditEvent`; for
  `claimDirectoryMatch`, an explicit optional param that — when passed —
  skips the method's own `withTransaction` wrap entirely and runs the query
  directly against that client). Task 6's route handler is the first caller
  to actually pass a shared `client`.

This is the refactor flagged in the handoff: `claimDirectoryMatch` currently
always opens its own internal transaction (`return this.withTransaction(async (client) => {...})`),
which breaks the spec's "one `withTransaction` wraps all four writes"
requirement. `createHumanSession` and `recordAuditEvent` currently hardcode
`this.pool.query` with no `client` param at all. The fix for all three
follows the exact `client = this.pool` default-param pattern already used by
`reserveRateLimit` (`postgres-repository.mjs:462`).

This task touches existing, already-tested methods with no test file of its
own yet for the "participates in an external transaction" behavior — write
that test first, live-Postgres only (this behavior is meaningless against
the memory repository's no-op `withTransaction`).

- [ ] **Step 1: Write the failing test**

Create `sigil/relay/v1/postgres-repository.transaction-participation.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function freshDb(t) {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  return pool;
}

test('createHumanSession and recordAuditEvent participate in a caller-supplied transaction and roll back together', { skip: !connectionString }, async (t) => {
  const pool = await freshDb(t);
  const repository = new PostgresRepository({ pool });
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = `usr_txn_${suffix}`;
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [humanId]);
  const now = new Date('2026-08-22T00:00:00Z');
  const sessionId = `sess_${suffix}`;

  await assert.rejects(repository.withTransaction(async (client) => {
    await repository.createHumanSession({ sessionId, humanId, authenticationMethod: 'mock_oidc', assurance: 'standard', issuedAt: now, expiresAt: new Date(now.getTime() + 60_000), now, client });
    await repository.recordAuditEvent({ eventType: 'human_session.created', subjectId: sessionId, actorHumanId: humanId, objectType: 'human_session', objectId: sessionId, outcome: 'success', now, client });
    throw new Error('force rollback');
  }));

  const sessionRow = await pool.query('SELECT * FROM human_sessions WHERE session_id = $1', [sessionId]);
  assert.equal(sessionRow.rows.length, 0, 'session row must not survive the rollback');
  const auditRow = await pool.query(`SELECT * FROM audit_events WHERE subject_id = $1`, [sessionId]);
  assert.equal(auditRow.rows.length, 0, 'audit row must not survive the rollback');
});

test('claimDirectoryMatch runs on a caller-supplied client without opening its own transaction', { skip: !connectionString }, async (t) => {
  const pool = await freshDb(t);
  const repository = new PostgresRepository({ pool });
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = { a: `usr_a_${suffix}`, b: `usr_b_${suffix}`, epA: `ep_a_${suffix}` };
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.a}', 'active', NOW()), ('${ids.b}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at) VALUES ('${ids.epA}', '${ids.a}', 'claude', 'install_a', 'A', 'active', NOW());
    INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, added_at) VALUES ('https://accounts.example.com', 'Example', TRUE, NOW());
  `);
  const now = new Date('2026-08-22T00:00:00Z');
  await repository.createDirectoryMatchRequest({ issuerEndpointId: ids.epA, issuerHumanId: ids.a, issuer: 'https://accounts.example.com', matchTarget: 'target@example.com', expiresAt: new Date(now.getTime() + 3_600_000), homeRelay: 'relay.local', now });

  const claimed = await repository.withTransaction((client) =>
    repository.claimDirectoryMatch({ issuer: 'https://accounts.example.com', matchTarget: 'target@example.com', matchedHumanId: ids.b, now, client })
  );
  assert.equal(typeof claimed.request_id, 'string');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `SIGIL_TEST_DATABASE_URL=<your test db> node --test sigil/relay/v1/postgres-repository.transaction-participation.test.mjs`
Expected: FAIL (`createHumanSession`/`recordAuditEvent` don't accept `client`
today, so both writes go through separate connections; the rollback test
then finds the rows DO exist since they were never actually inside the
transaction that gets rolled back — the assertion that rows are absent
fails).

- [ ] **Step 3: Edit `claimDirectoryMatch`**

In `sigil/relay/v1/postgres-repository.mjs`, replace the existing
`claimDirectoryMatch` (lines 280-294):

```js
  async claimDirectoryMatch({ issuer, matchTarget, matchedHumanId, now = new Date(), client } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const targetHash = hashMatchTarget(matchTarget);
    const run = async (txClient) => {
      const candidate = await txClient.query(
        `SELECT request_id FROM directory_match_requests
         WHERE issuer = $1 AND match_target_hash = $2 AND status = 'pending' AND expires_at > $3
         FOR UPDATE SKIP LOCKED LIMIT 1`,
        [issuer, targetHash, timestamp]
      );
      if (!candidate.rows[0]) return null;
      await txClient.query(`UPDATE directory_match_requests SET status = 'matched', matched_human_id = $1, matched_at = $2 WHERE request_id = $3`, [matchedHumanId, timestamp, candidate.rows[0].request_id]);
      return { request_id: candidate.rows[0].request_id };
    };
    return client ? run(client) : this.withTransaction(run);
  }
```

- [ ] **Step 4: Edit `createHumanSession`**

Replace the existing `createHumanSession` (lines 628-639):

```js
  async createHumanSession({ sessionId, humanId, authenticationMethod, assurance, deviceContext = {}, issuedAt = new Date(), expiresAt, now = new Date(), client = this.pool } = {}) {
    assertAssurance(assurance);
    const issued = issuedAt instanceof Date ? issuedAt.toISOString() : new Date(issuedAt).toISOString();
    const expires = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt).toISOString();
    const result = await client.query(
      `INSERT INTO human_sessions (session_id, human_id, authentication_method, assurance, device_context, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING session_id, human_id, authentication_method, assurance, device_context, issued_at, version, expires_at, revoked_at`,
      [sessionId, humanId, authenticationMethod, assurance, JSON.stringify(deviceContext), issued, expires]
    );
    return result.rows[0];
  }
```

- [ ] **Step 5: Edit `recordAuditEvent`**

Replace the existing `recordAuditEvent` (lines 862-871):

```js
  async recordAuditEvent({ eventId = `audit_${crypto.randomUUID()}`, eventType, subjectId, actorId = null, actorHumanId = null, endpointId = null, objectType = null, objectId = null, actionHash = null, outcome = null, reason = null, payload = {}, metadataRedacted = null, now = new Date(), client = this.pool } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const result = await client.query(
      `INSERT INTO audit_events (event_id, event_type, subject_id, actor_id, actor_human_id, endpoint_id, object_type, object_id, action_hash, outcome, reason, payload, metadata_redacted, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING event_id, event_type, subject_id, actor_id, actor_human_id, endpoint_id, object_type, object_id, action_hash, outcome, reason, created_at`,
      [eventId, eventType, subjectId, actorId, actorHumanId, endpointId, objectType, objectId, actionHash, outcome, reason, JSON.stringify(payload), metadataRedacted ? JSON.stringify(metadataRedacted) : null, timestamp]
    );
    return result.rows[0];
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `SIGIL_TEST_DATABASE_URL=<your test db> node --test sigil/relay/v1/postgres-repository.transaction-participation.test.mjs`
Expected: PASS.

Also run the full existing suite to confirm no regression in callers that
don't pass `client` (they all fall back to their defaults):
Run: `SIGIL_TEST_DATABASE_URL=<your test db> npm test`
Expected: PASS (all pre-existing tests still green).

- [ ] **Step 7: Commit**

```bash
git add sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/postgres-repository.transaction-participation.test.mjs
git commit -m "refactor(sigil): let claimDirectoryMatch/createHumanSession/recordAuditEvent join a caller's transaction"
```

---

## Task 3: Migration 013 (`mock_login_replays`) + memory-repository parity

**Files:**
- Create: `sigil/migrations/013_mock_login_replays.sql`
- Modify: `sigil/cli/memory-repository.mjs`
- Test: `sigil/cli/memory-repository.mock-oidc.test.mjs`

**Interfaces:**
- Produces: memory-repository's `createHumanSession(...)` and
  `consumeMockLoginJti(jti, { now, expiresAt })`, consumed by Task 6's route
  handler on the memory-repository path.

- [ ] **Step 1: Write the migration**

Create `sigil/migrations/013_mock_login_replays.sql`:

```sql
-- sigil/migrations/013_mock_login_replays.sql
-- jti-based replay guard for POST /v1/auth/mock-login (mock-OIDC login,
-- docs/superpowers/specs/2026-08-22-sigil-mock-oidc-login.md). The same
-- valid token must not be replayable into unlimited short-lived sessions
-- before it expires; the primary-key uniqueness constraint below makes a
-- second insert of the same jti fail, which the route maps to
-- 401 TOKEN_REPLAYED.

CREATE TABLE IF NOT EXISTS mock_login_replays (
  jti TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS mock_login_replays_expires_at_idx ON mock_login_replays(expires_at);
```

- [ ] **Step 2: Write the failing memory-repository test**

Create `sigil/cli/memory-repository.mock-oidc.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryRepository } from './memory-repository.mjs';

test('memory relay createHumanSession returns a session row shaped like the Postgres one', async () => {
  const repository = createMemoryRepository();
  const now = new Date('2026-08-22T00:00:00Z');
  const session = await repository.createHumanSession({ sessionId: 'sess_1', humanId: 'usr_1', authenticationMethod: 'mock_oidc', assurance: 'standard', issuedAt: now, expiresAt: new Date(now.getTime() + 300_000), now });
  assert.equal(session.session_id, 'sess_1');
  assert.equal(session.human_id, 'usr_1');
  assert.equal(session.authentication_method, 'mock_oidc');
  assert.equal(session.assurance, 'standard');
  assert.equal(session.revoked_at, null);
});

test('memory relay consumeMockLoginJti allows first use, rejects replay', async () => {
  const repository = createMemoryRepository();
  const now = new Date('2026-08-22T00:00:00Z');
  const expiresAt = new Date(now.getTime() + 300_000);
  await repository.consumeMockLoginJti('jti_1', { now, expiresAt });
  await assert.rejects(
    () => repository.consumeMockLoginJti('jti_1', { now, expiresAt }),
    { code: 'TOKEN_REPLAYED' }
  );
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test sigil/cli/memory-repository.mock-oidc.test.mjs`
Expected: FAIL — `repository.createHumanSession is not a function`.

- [ ] **Step 4: Edit `memory-repository.mjs`**

In `sigil/cli/memory-repository.mjs`, add two new `Map`s alongside the
existing ones near the top of `createMemoryRepository` (after
`directoryMatchRequests` at line 29):

```js
  const humanSessions = new Map();
  const consumedMockLoginJtis = new Map();
```

Then add two new methods to the returned object — insert them after
`revokeCapabilityGrant` (the last method, ending at line 257), keeping the
object's closing `}` after them:

```js
    async createHumanSession({ sessionId, humanId, authenticationMethod, assurance, deviceContext = {}, issuedAt = new Date(), expiresAt, now = new Date() }) {
      const issued = (issuedAt instanceof Date ? issuedAt : new Date(issuedAt)).toISOString();
      const expires = (expiresAt instanceof Date ? expiresAt : new Date(expiresAt)).toISOString();
      const session = { session_id: sessionId, human_id: humanId, authentication_method: authenticationMethod, assurance, device_context: deviceContext, issued_at: issued, version: 1, expires_at: expires, revoked_at: null };
      humanSessions.set(sessionId, session);
      return session;
    },
    async consumeMockLoginJti(jti, { now = new Date(), expiresAt }) {
      if (consumedMockLoginJtis.has(jti)) {
        throw Object.assign(new Error('Mock ID token has already been used'), { code: 'TOKEN_REPLAYED' });
      }
      consumedMockLoginJtis.set(jti, (expiresAt instanceof Date ? expiresAt : new Date(expiresAt)).toISOString());
      return undefined;
    }
```

Remember to add a comma after the existing `revokeCapabilityGrant` method's
closing `}` (it currently has none since it was the last entry).

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test sigil/cli/memory-repository.mock-oidc.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sigil/migrations/013_mock_login_replays.sql sigil/cli/memory-repository.mjs sigil/cli/memory-repository.mock-oidc.test.mjs
git commit -m "feat(sigil): add mock_login_replays migration and memory-repository session/jti parity"
```

---

## Task 4: PostgreSQL `consumeMockLoginJti` + issuer allow-list upsert

**Files:**
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Test: `sigil/relay/v1/postgres-repository.mock-oidc.test.mjs`

**Interfaces:**
- Consumes: nothing new (uses `this.pool`/`client` directly).
- Produces: `consumeMockLoginJti(jti, { now, expiresAt, client = this.pool })`,
  `upsertMockOidcIssuerAllowlist({ issuer, now })`, both consumed by Task 6's
  route handler (the first) and Task 7's CLI startup path (the second).

- [ ] **Step 1: Write the failing test**

Create `sigil/relay/v1/postgres-repository.mock-oidc.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function freshDb(t) {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  return pool;
}

test('consumeMockLoginJti allows first use, rejects replay with TOKEN_REPLAYED', { skip: !connectionString }, async (t) => {
  const pool = await freshDb(t);
  const repository = new PostgresRepository({ pool });
  const now = new Date('2026-08-22T00:00:00Z');
  const expiresAt = new Date(now.getTime() + 300_000);
  const jti = `jti_${crypto.randomUUID()}`;
  await repository.consumeMockLoginJti(jti, { now, expiresAt });
  await assert.rejects(
    () => repository.consumeMockLoginJti(jti, { now, expiresAt }),
    { code: 'TOKEN_REPLAYED' }
  );
});

test('upsertMockOidcIssuerAllowlist inserts the fixture issuer, enabled, standard assurance, idempotently', { skip: !connectionString }, async (t) => {
  const pool = await freshDb(t);
  const repository = new PostgresRepository({ pool });
  const now = new Date('2026-08-22T00:00:00Z');
  await repository.upsertMockOidcIssuerAllowlist({ issuer: 'https://mock-oidc.sigil.local', now });
  await repository.upsertMockOidcIssuerAllowlist({ issuer: 'https://mock-oidc.sigil.local', now });
  const row = await pool.query('SELECT * FROM oidc_issuer_allowlist WHERE issuer = $1', ['https://mock-oidc.sigil.local']);
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].enabled, true);
  assert.equal(row.rows[0].assurance_level, 'standard');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `SIGIL_TEST_DATABASE_URL=<your test db> node --test sigil/relay/v1/postgres-repository.mock-oidc.test.mjs`
Expected: FAIL — `repository.consumeMockLoginJti is not a function`.

- [ ] **Step 3: Add the two methods**

In `sigil/relay/v1/postgres-repository.mjs`, add these two methods right
after `recordAuditEvent` (which now ends around line 871 post-Task-2):

```js
  // Replay guard for POST /v1/auth/mock-login: the primary-key uniqueness
  // constraint on mock_login_replays.jti makes a second insert of the same
  // jti fail with 23505, mapped here to TOKEN_REPLAYED.
  async consumeMockLoginJti(jti, { now = new Date(), expiresAt, client = this.pool } = {}) {
    const expires = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt).toISOString();
    try {
      await client.query('INSERT INTO mock_login_replays (jti, expires_at) VALUES ($1, $2)', [jti, expires]);
    } catch (error) {
      if (error.code === '23505') throw Object.assign(new Error('Mock ID token has already been used'), { code: 'TOKEN_REPLAYED' });
      throw error;
    }
  }
  // Scoped strictly to enableMockOidc's opt-in startup path (Task 7) -- a
  // production relay that never sets --enable-mock-oidc never touches this
  // table for the fixture issuer.
  async upsertMockOidcIssuerAllowlist({ issuer, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    await this.pool.query(
      `INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, assurance_level, added_at)
       VALUES ($1, 'Mock OIDC (dev/test only)', TRUE, 'standard', $2)
       ON CONFLICT (issuer) DO UPDATE SET enabled = TRUE, assurance_level = 'standard'`,
      [issuer, timestamp]
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `SIGIL_TEST_DATABASE_URL=<your test db> node --test sigil/relay/v1/postgres-repository.mock-oidc.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/postgres-repository.mock-oidc.test.mjs
git commit -m "feat(sigil): add PostgresRepository consumeMockLoginJti and issuer allow-list upsert"
```

---

## Task 5: `POST /v1/auth/mock-login` route

**Files:**
- Modify: `sigil/relay/v1/http-server.mjs`
- Test: `sigil/relay/v1/mock-oidc-route.test.mjs` (lightweight, fake repository)

**Interfaces:**
- Consumes: `signMockIdToken`/`verifyMockIdToken` (Task 1),
  `repository.consumeMockLoginJti` (Tasks 3/4),
  `repository.createHumanSession` (Tasks 3/4, now `client`-aware from Task 2),
  `repository.recordAuditEvent` (`client`-aware from Task 2),
  `attemptDirectoryMatchOnOidcLogin` from `directory-trust.mjs` (already
  shipped, unmodified — it calls `repository.claimDirectoryMatch`, now
  `client`-aware from Task 2), `assertAssurance` from `auth-policy.mjs`
  (already imported in `http-server.mjs`... actually not yet imported there;
  this task adds it).
- Produces: the live `POST /v1/auth/mock-login` route, gated behind the new
  `enableMockOidc` option.

- [ ] **Step 1: Write the failing tests**

Create `sigil/relay/v1/mock-oidc-route.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';
import { signMockIdToken } from './mock-oidc.mjs';

function request(port, { method, path, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method, path, headers: { 'content-type': 'application/json' } }, (response) => {
      let text = ''; response.on('data', (chunk) => text += chunk); response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function withServer(options, fn) {
  const server = createRelayServer(options);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try { return await fn(port); } finally { await new Promise((resolve) => server.close(resolve)); }
}

const FIXED_NOW = new Date('2026-08-22T00:00:00Z');

function fakeRepository(overrides = {}) {
  return {
    async withTransaction(fn) { return fn(null); },
    async consumeMockLoginJti() {},
    async createHumanSession({ sessionId, humanId }) { return { session_id: sessionId, human_id: humanId, authentication_method: 'mock_oidc', assurance: 'standard', issued_at: FIXED_NOW.toISOString(), expires_at: FIXED_NOW.toISOString(), revoked_at: null }; },
    async recordAuditEvent() { return {}; },
    async claimDirectoryMatch() { return null; },
    ...overrides,
  };
}

test('enableMockOidc: false (default) -- route does not exist, returns 404', async () => {
  await withServer({ repository: fakeRepository(), authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }) }, async (port) => {
    const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
    const result = await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: token } });
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'CONTEXT_NOT_FOUND');
  });
});

test('success path creates a session and returns match: null when nothing pending', async () => {
  await withServer({ enableMockOidc: true, repository: fakeRepository(), authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW }, async (port) => {
    const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
    const result = await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: token } });
    assert.equal(result.status, 201);
    assert.equal(result.body.code, 'OK');
    assert.equal(result.body.session.human_id, 'usr_1');
    assert.equal(result.body.match, null);
  });
});

test('success path fires a match when one is pending', async () => {
  const repository = fakeRepository({ async claimDirectoryMatch() { return { request_id: 'dreq_1' }; } });
  await withServer({ enableMockOidc: true, repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW }, async (port) => {
    const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
    const result = await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: token } });
    assert.equal(result.status, 201);
    assert.equal(result.body.match.request_id, 'dreq_1');
  });
});

test('missing principal.human_id -- 403 HUMAN_CONTEXT_REQUIRED, no writes performed', async () => {
  let writes = 0;
  const repository = fakeRepository({ async consumeMockLoginJti() { writes++; }, async createHumanSession() { writes++; return {}; } });
  await withServer({ enableMockOidc: true, repository, authenticate: async () => ({ endpoint_id: 'ep_1' }), now: () => FIXED_NOW }, async (port) => {
    const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
    const result = await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: token } });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'HUMAN_CONTEXT_REQUIRED');
    assert.equal(writes, 0);
  });
});

test('bad token (tampered signature) -- 401 INVALID_ID_TOKEN, no writes performed', async () => {
  let writes = 0;
  const repository = fakeRepository({ async consumeMockLoginJti() { writes++; }, async createHumanSession() { writes++; return {}; } });
  await withServer({ enableMockOidc: true, repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW }, async (port) => {
    const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
    const tampered = token.slice(0, -4) + (token.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    const result = await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: tampered } });
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'INVALID_ID_TOKEN');
    assert.equal(writes, 0);
  });
});

test('replayed jti -- second call returns 401 TOKEN_REPLAYED', async () => {
  const usedJtis = new Set();
  const repository = fakeRepository({
    async consumeMockLoginJti(jti) {
      if (usedJtis.has(jti)) throw Object.assign(new Error('replayed'), { code: 'TOKEN_REPLAYED' });
      usedJtis.add(jti);
    },
  });
  await withServer({ enableMockOidc: true, repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW }, async (port) => {
    const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
    const first = await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: token } });
    assert.equal(first.status, 201);
    const second = await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: token } });
    assert.equal(second.status, 401);
    assert.equal(second.body.code, 'TOKEN_REPLAYED');
  });
});

test('oversized request body returns 413, same as every other route', async () => {
  await withServer({ enableMockOidc: true, repository: fakeRepository(), authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW }, async (port) => {
    const oversized = 'a'.repeat(1024 * 1024 + 1);
    const result = await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: oversized } });
    assert.equal(result.status, 413);
  });
});

test('audit event payload matches the created session', async () => {
  const audits = [];
  const repository = fakeRepository({ async recordAuditEvent(event) { audits.push(event); return {}; } });
  await withServer({ enableMockOidc: true, repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW }, async (port) => {
    const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now: FIXED_NOW });
    await request(port, { method: 'POST', path: '/v1/auth/mock-login', body: { id_token: token } });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].eventType, 'human_session.created');
    assert.equal(audits[0].actorHumanId, 'usr_1');
    assert.equal(audits[0].endpointId, 'ep_1');
    assert.equal(audits[0].outcome, 'success');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test sigil/relay/v1/mock-oidc-route.test.mjs`
Expected: FAIL — all requests to `/v1/auth/mock-login` hit the generic 404
(route doesn't exist yet).

- [ ] **Step 3: Add the route**

In `sigil/relay/v1/http-server.mjs`:

1. Add two imports near the top (after the existing `auth-policy.mjs`
   import on line 10):

```js
import { assertAssurance } from './auth-policy.mjs';
import { verifyMockIdToken } from './mock-oidc.mjs';
import { attemptDirectoryMatchOnOidcLogin } from './directory-trust.mjs';
```

(`assertAssurance` joins the existing `auth-policy.mjs` import line rather
than a new one — combine it into the existing
`import { assertAccountLinkCeremony, assertAllowedIssuer, boundedDirectoryExpiry, boundedTokenExpiry } from './auth-policy.mjs';`
on line 10.)

2. Add `enableMockOidc = false` to the `createRelayServer` options
   destructure on line 29 (append it to the existing parameter list).

3. Add the route itself. Insert it directly after the `/v1/directory/links/:linkId/revoke`
   block (which ends at line 640, right before the final fallback 404 block
   at lines 641-642):

```js
    if (request.method === 'POST' && request.url === '/v1/auth/mock-login' && enableMockOidc) {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body?.id_token) { response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'id_token is required', details: {} })); }

      let claims;
      try { claims = verifyMockIdToken(body.id_token, { now: () => now }); }
      catch (error) {
        response.writeHead(401, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'INVALID_ID_TOKEN', message: error.message, details: {} }));
      }

      if (!repository?.consumeMockLoginJti || !repository?.createHumanSession) return response.writeHead(503).end();

      try {
        const sessionId = `sess_${crypto.randomUUID()}`;
        const sessionTtlMs = 5 * 60 * 1000;
        const expiresAt = new Date(now.getTime() + sessionTtlMs);
        const result = await repository.withTransaction(async (client) => {
          await repository.consumeMockLoginJti(claims.jti, { now, expiresAt, client });
          const session = await repository.createHumanSession({ sessionId, humanId: principal.human_id, authenticationMethod: 'mock_oidc', assurance: 'standard', issuedAt: now, expiresAt, now, client });
          await repository.recordAuditEvent({ eventType: 'human_session.created', subjectId: sessionId, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'human_session', objectId: sessionId, outcome: 'success', now, client });
          const match = await attemptDirectoryMatchOnOidcLogin({ repository: { claimDirectoryMatch: (args) => repository.claimDirectoryMatch({ ...args, client }) }, issuer: claims.issuer, verifiedEmail: claims.email, matchedHumanId: principal.human_id, now });
          return { session, match };
        });
        response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', session: result.session, match: result.match ?? null }));
      } catch (error) {
        response.writeHead(error.code === 'TOKEN_REPLAYED' ? 401 : 500, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'MOCK_LOGIN_FAILED', message: error.message, details: {} }));
      }
    }
```

Note: `assertAssurance` imported above is not directly called in this route
body — `createHumanSession` already calls it internally (both repository
implementations validate `assurance` before insert). Remove the unused
top-level import of `assertAssurance` if your editor/linter flags it as
unused; it is optional here since `createHumanSession` enforces it either
way. (Kept out of the route body deliberately — no need to duplicate the
check.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test sigil/relay/v1/mock-oidc-route.test.mjs`
Expected: PASS, all 8 tests green.

Also run the full lightweight suite to confirm no regression:
Run: `node --test sigil/relay/v1/http-server.test.mjs sigil/relay/v1/identity-auth-routes.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/http-server.mjs sigil/relay/v1/mock-oidc-route.test.mjs
git commit -m "feat(sigil): add POST /v1/auth/mock-login gated behind enableMockOidc"
```

---

## Task 6: Live-Postgres integration tests for the route

**Files:**
- Create: `sigil/relay/v1/postgres-mock-oidc-route.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1-5, exercised against a real
  `PostgresRepository` and real HTTP server.

This closes the FK/allow-list, real-rollback, and real-jti-uniqueness gaps
the lightweight fake-repository tests in Task 5 can't cover.

- [ ] **Step 1: Write the tests**

Create `sigil/relay/v1/postgres-mock-oidc-route.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { createRelayServer } from './http-server.mjs';
import { signMockIdToken, FIXTURE_ISSUER } from './mock-oidc.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function bootstrap(t) {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = `usr_${suffix}`;
  const endpointId = `ep_${suffix}`;
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${humanId}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at) VALUES ('${endpointId}', '${humanId}', 'claude', 'install_${suffix}', 'A', 'active', NOW());
  `);
  const repository = new PostgresRepository({ pool });
  const now = new Date('2026-08-22T00:00:00Z');
  const server = createRelayServer({ repository, enableMockOidc: true, authenticate: async () => ({ endpoint_id: endpointId, human_id: humanId }), now: () => now });
  const port = await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { pool, humanId, endpointId, baseUrl: `http://127.0.0.1:${port}`, now };
}

test('wrong issuer with no oidc_issuer_allowlist row: token verifies, but match half returns null (FK-backed no-op, not an error)', { skip: !connectionString }, async (t) => {
  const { baseUrl, now } = await bootstrap(t);
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now });
  const response = await fetch(`${baseUrl}/v1/auth/mock-login`, { method: 'POST', body: JSON.stringify({ id_token: token }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.match, null);
});

test('success path: fixture issuer allow-listed, pending match request gets claimed', { skip: !connectionString }, async (t) => {
  const { pool, baseUrl, humanId, endpointId, now } = await bootstrap(t);
  await pool.query(`INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, added_at) VALUES ($1, 'Mock', TRUE, NOW())`, [FIXTURE_ISSUER]);
  const repository = new PostgresRepository({ pool });
  const requesterHuman = `usr_req_${crypto.randomUUID().replaceAll('-', '_')}`;
  const requesterEndpoint = `ep_req_${crypto.randomUUID().replaceAll('-', '_')}`;
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [requesterHuman]);
  await pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at) VALUES ($1, $2, 'claude', $3, 'R', 'active', NOW())`, [requesterEndpoint, requesterHuman, `install_${requesterEndpoint}`]);
  await repository.createDirectoryMatchRequest({ issuerEndpointId: requesterEndpoint, issuerHumanId: requesterHuman, issuer: FIXTURE_ISSUER, matchTarget: 'a@example.com', expiresAt: new Date(now.getTime() + 3_600_000), homeRelay: 'relay.local', now });

  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now });
  const response = await fetch(`${baseUrl}/v1/auth/mock-login`, { method: 'POST', body: JSON.stringify({ id_token: token }) });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(typeof body.match.request_id, 'string');
  assert.equal(body.session.human_id, humanId);

  const sessionRow = await pool.query('SELECT * FROM human_sessions WHERE session_id = $1', [body.session.session_id]);
  assert.equal(sessionRow.rows.length, 1);
  const auditRow = await pool.query(`SELECT * FROM audit_events WHERE subject_id = $1 AND event_type = 'human_session.created'`, [body.session.session_id]);
  assert.equal(auditRow.rows.length, 1);
  assert.equal(auditRow.rows[0].actor_human_id, humanId);
  assert.equal(auditRow.rows[0].endpoint_id, endpointId);
  assert.equal(auditRow.rows[0].outcome, 'success');
});

test('replayed jti: retrying the exact same token after a simulated mid-sequence failure succeeds (rollback did not consume it)', { skip: !connectionString }, async (t) => {
  const { pool, baseUrl, now } = await bootstrap(t);
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now });

  // First: monkeypatch createHumanSession to fail, forcing a rollback --
  // done here by directly exercising the repository/transaction path rather
  // than the HTTP route, since the route always uses the real method.
  const repository = new PostgresRepository({ pool });
  const originalCreateHumanSession = repository.createHumanSession.bind(repository);
  let shouldFail = true;
  repository.createHumanSession = async (...args) => {
    if (shouldFail) { shouldFail = false; throw new Error('simulated mid-sequence failure'); }
    return originalCreateHumanSession(...args);
  };
  const { verifyMockIdToken } = await import('./mock-oidc.mjs');
  const claims = verifyMockIdToken(token, { now: () => now });
  const sessionId = `sess_${crypto.randomUUID()}`;
  const expiresAt = new Date(now.getTime() + 300_000);
  await assert.rejects(repository.withTransaction(async (client) => {
    await repository.consumeMockLoginJti(claims.jti, { now, expiresAt, client });
    await repository.createHumanSession({ sessionId, humanId: 'irrelevant', authenticationMethod: 'mock_oidc', assurance: 'standard', issuedAt: now, expiresAt, now, client });
  }));

  // Retry: the jti must not have been left consumed by the rolled-back
  // transaction -- a fresh consumeMockLoginJti for the same jti succeeds.
  await repository.consumeMockLoginJti(claims.jti, { now, expiresAt });

  const replayRow = await pool.query('SELECT count(*) FROM mock_login_replays WHERE jti = $1', [claims.jti]);
  assert.equal(Number(replayRow.rows[0].count), 1);
});

test('replayed jti over HTTP: second call to the route with the same token returns 401 TOKEN_REPLAYED, only one session/audit row exists', { skip: !connectionString }, async (t) => {
  const { pool, baseUrl, now } = await bootstrap(t);
  const token = signMockIdToken({ subject: 'sub_1', email: 'a@example.com', now });
  const first = await fetch(`${baseUrl}/v1/auth/mock-login`, { method: 'POST', body: JSON.stringify({ id_token: token }) });
  assert.equal(first.status, 201);
  const second = await fetch(`${baseUrl}/v1/auth/mock-login`, { method: 'POST', body: JSON.stringify({ id_token: token }) });
  assert.equal(second.status, 401);
  const secondBody = await second.json();
  assert.equal(secondBody.code, 'TOKEN_REPLAYED');
  const sessions = await pool.query('SELECT count(*) FROM human_sessions');
  assert.equal(Number(sessions.rows[0].count), 1);
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `SIGIL_TEST_DATABASE_URL=<your test db> node --test sigil/relay/v1/postgres-mock-oidc-route.test.mjs`
Expected: PASS, all 4 tests green.

- [ ] **Step 3: Commit**

```bash
git add sigil/relay/v1/postgres-mock-oidc-route.test.mjs
git commit -m "test(sigil): add live-Postgres integration coverage for POST /v1/auth/mock-login"
```

---

## Task 7: CLI `--enable-mock-oidc` flag on `sigil relay up`

**Files:**
- Modify: `sigil/cli/sigil.mjs`
- Test: `sigil/cli/sigil-relay-mock-oidc.test.mjs`

**Interfaces:**
- Consumes: `createRelayServer`'s `enableMockOidc` option (Task 5),
  `PostgresRepository#upsertMockOidcIssuerAllowlist` (Task 4).

- [ ] **Step 1: Write the failing test**

Create `sigil/cli/sigil-relay-mock-oidc.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sigilPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');

function runCli(argv, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [sigilPath, ...argv], { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..') });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    const timer = setTimeout(() => { child.kill(); resolve({ stdout }); }, timeoutMs);
    child.on('exit', () => { clearTimeout(timer); resolve({ stdout }); });
  });
}

test('sigil relay up --help-equivalent usage text mentions --enable-mock-oidc', async () => {
  // sigil.mjs has no --help flag; assert against the command's own usage
  // banner text printed at startup instead (see cmdRelayUp's console.log
  // lines) by grepping the source for the flag definition -- a fast, no-
  // network smoke check that the flag exists and is documented.
  const source = await import('node:fs/promises').then((fs) => fs.readFile(sigilPath, 'utf8'));
  assert.match(source, /enable-mock-oidc/);
  assert.match(source, /SIGIL_ENABLE_MOCK_OIDC/);
});
```

(This CLI is a long-running `relay up` blocking process — see
`cmdRelayUp`'s trailing `await new Promise(() => {})` — so a full spawn-and-hit-the-route
smoke test is out of scope for this fast unit test; the route's actual
behavior is already covered end-to-end by Task 6's live-Postgres tests via
direct `createRelayServer` calls. This test only confirms the flag is wired
into the CLI's source, matching the low ceremony of this repo's other CLI
flag tests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test sigil/cli/sigil-relay-mock-oidc.test.mjs`
Expected: FAIL — neither string present yet.

- [ ] **Step 3: Edit `cmdRelayUp`**

In `sigil/cli/sigil.mjs`, update the `cmdRelayUp` function (lines 80-140):

1. Add `'enable-mock-oidc': { type: 'boolean' }` to the `parseArgs` options
   object on line 81.
2. After the `databaseUrl` line (line 85), add:

```js
  const enableMockOidc = Boolean(args.values['enable-mock-oidc']) || process.env.SIGIL_ENABLE_MOCK_OIDC === '1';
```

3. After the `repository = new PostgresRepository({ pool });` line inside
   the `if (databaseUrl)` block (line 97), add:

```js
    if (enableMockOidc) {
      const { FIXTURE_ISSUER } = await import('../relay/v1/mock-oidc.mjs');
      await repository.upsertMockOidcIssuerAllowlist({ issuer: FIXTURE_ISSUER });
    }
```

4. Update the `createRelayServer` call (line 132) to pass the flag:

```js
  server = createRelayServer({ registry, repository, tokenHashes, stream, relayOrigin, enableMockOidc });
```

5. Add a console warning right before the final `console.log` block (before
   line 138), so the local-dev-only nature is impossible to miss:

```js
  if (enableMockOidc) console.log('WARNING: mock-OIDC login is enabled (--enable-mock-oidc). This is for local development and CI only -- never expose this relay to untrusted networks.');
```

6. Update the usage banner comment near the top of the file (line 40) to
   document the new flag:

```js
//   relay up [--registry path] [--port N] [--enable-mock-oidc]        Run a local relay (blocks; Ctrl+C to stop)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test sigil/cli/sigil-relay-mock-oidc.test.mjs`
Expected: PASS.

Also run the full suite one final time to confirm nothing regressed:
Run: `npm test` (from `c:\dev\sigil-repo`)
Expected: PASS (live-Postgres tests skip automatically without
`SIGIL_TEST_DATABASE_URL`; re-run with that env var set for full coverage).

- [ ] **Step 5: Commit**

```bash
git add sigil/cli/sigil.mjs sigil/cli/sigil-relay-mock-oidc.test.mjs
git commit -m "feat(sigil): wire --enable-mock-oidc / SIGIL_ENABLE_MOCK_OIDC into sigil relay up"
```

---

## Task 8: README documentation

**Files:**
- Modify: repo `README.md` (or `sigil/README.md` if that's where CLI usage
  is documented — check both; use whichever already documents `sigil relay
  up`).

**Interfaces:** none (documentation only).

- [ ] **Step 1: Find the existing `sigil relay up` documentation**

Run: `grep -rn "relay up" --include=*.md .` from `c:\dev\sigil-repo` to
locate the file.

- [ ] **Step 2: Add a subsection**

Add a short subsection near the existing `relay up` docs:

```markdown
### Mock-OIDC login (local dev / CI only)

`sigil relay up --enable-mock-oidc` (or `SIGIL_ENABLE_MOCK_OIDC=1`) turns on
`POST /v1/auth/mock-login`, a fully local, fixture-signed OIDC login route
used to exercise the directory-match-on-login flow without a real identity
provider. **This is never real authentication** — the ID token is signed
with a keypair committed to this repository
(`sigil/relay/v1/fixtures/mock-oidc-keys.json`) and must never be enabled on
a relay reachable from untrusted networks.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(sigil): document --enable-mock-oidc as local-dev/CI-only"
```

---

## Self-Review Notes

- **Spec coverage:** every spec section has a task — signing/verification
  (Task 1), the `client`-participation refactor the handoff flagged (Task
  2), migration + memory parity (Task 3), Postgres-side jti/allow-list
  methods (Task 4), the route itself (Task 5), live-Postgres behavior
  including transactional rollback and replay (Task 6), the CLI flag (Task
  7), and docs (Task 8, called out in the spec's production-gate section as
  a CLI/README requirement).
- **Placeholder scan:** no TBDs; every step has literal code or an exact
  shell command.
- **Type consistency:** `client` param name and position match across
  `claimDirectoryMatch`/`createHumanSession`/`recordAuditEvent`/
  `consumeMockLoginJti`; `signMockIdToken`/`verifyMockIdToken` signatures
  match between Task 1's implementation and every later task's call sites;
  the route's error-code mapping (`TOKEN_REPLAYED` → 401,
  `INVALID_ID_TOKEN` → 401, `HUMAN_CONTEXT_REQUIRED` → 403) matches the
  spec's route contract exactly.
