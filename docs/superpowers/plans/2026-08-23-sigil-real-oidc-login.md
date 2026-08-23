# Sigil real OIDC login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "real IdP integration" gap on Sigil's roadmap with a production `POST /v1/auth/login` route that verifies real OIDC ID tokens (RS256/ES256, live JWKS fetch) and reuses the existing match/session/audit/replay core that `POST /v1/auth/mock-login` already exercises.

**Architecture:** A new `sigil/relay/v1/oidc-client.mjs` module does OIDC discovery + JWKS fetch + hand-rolled `node:crypto` signature verification, replacing `mock-oidc.mjs`'s fixed local keypair for this one route. `oidc_issuer_allowlist` gains a `client_id` column so the route can validate `aud`/`azp`. The mock-login route is untouched behavior-wise (only its replay-table/method names are renamed for sharing). The two routes share one replay-guard table and the same `attemptDirectoryMatchOnOidcLogin` / session / audit-event call sequence.

**Tech Stack:** Node.js `>=22` (`node:crypto`, global `fetch`), `node:test` + `node:assert/strict`, PostgreSQL (`pg`), the repo's existing in-memory test double (`memory-repository.mjs`). No new npm dependency.

**Spec:** `docs/superpowers/specs/2026-08-23-sigil-real-oidc-login.md`

## Global Constraints

- No new npm dependency — crypto and HTTP fetch use `node:crypto` and Node's built-in global `fetch` only, matching this repo's hand-rolled-crypto convention.
- `POST /v1/auth/login` has no feature flag — it is always registered (unlike `enableMockOidc`), since this is the production path.
- Issuer allow-list lookup (Postgres `oidc_issuer_allowlist` row with `client_id`) must happen and reject *before* any outbound `fetch` call — never fetch discovery/JWKS for an issuer that isn't already admin-allow-listed (SSRF guard).
- ES256 signature verification via `crypto.verify` must pass `{ dsaEncoding: 'ieee-p1363' }` — compact JWS ECDSA signatures are raw `r || s`, not DER.
- `alg` header must be exactly `RS256` or `ES256` and must match the resolved key's `kty` (`RSA`↔`RS256`, `EC`↔`ES256`); any other value or a mismatch is a hard rejection before the signature is touched.
- Discovery and JWKS URLs must be `https:` only; the discovery document's own `issuer` field must exactly equal the requested issuer string before its `jwks_uri` is trusted.
- Clock-skew leeway on `iat`/`exp` is ±30 seconds, matching `mock-oidc.mjs`'s existing tolerance.
- JWKS cache: `Map<issuer, { jwks, fetchedAt, lastMissRefetchAt }>`, TTL 1 hour, at most one kid-miss-triggered refetch per verify call, and at most one such refetch per 10 seconds per issuer (cooldown).
- Replay table `login_jti_replays` (renamed from `mock_login_replays`) is shared by both `/v1/auth/mock-login` and `/v1/auth/login`. Existing mock-login behavior must not change — only the table/method names.
- All error responses from the new route use `{ request_id, code, message, details: {} }`, matching every other route in `http-server.mjs`.

---

## File Structure

- `sigil/relay/v1/oidc-client.mjs` (new) — discovery, JWKS fetch + cache, `verifyRealIdToken`. Pure logic, no HTTP route handling, no repository access — mirrors `mock-oidc.mjs`'s role for the mock route.
- `sigil/relay/v1/oidc-client.test.mjs` (new) — unit tests for the above, with an injectable `fetch`.
- `sigil/migrations/014_oidc_issuer_client_id.sql` (new) — adds `client_id` to `oidc_issuer_allowlist`.
- `sigil/migrations/015_rename_login_jti_replays.sql` (new) — renames `mock_login_replays` to `login_jti_replays`.
- `sigil/relay/v1/postgres-repository.mjs` (modify) — rename `consumeMockLoginJti` → `consumeLoginJti`; add `getOidcIssuerAllowlistEntry(issuer)`.
- `sigil/cli/memory-repository.mjs` (modify) — rename `consumedMockLoginJtis`/`consumeMockLoginJti` → `consumedLoginJtis`/`consumeLoginJti`; add an `oidcIssuerAllowlist` Map + `getOidcIssuerAllowlistEntry`/a seeding helper for tests.
- `sigil/relay/v1/http-server.mjs` (modify) — rename the mock route's call to `consumeLoginJti`; add new `POST /v1/auth/login` route.
- `sigil/relay/v1/mock-oidc-route.test.mjs` (modify) — update references to the renamed repository method only.
- `sigil/relay/v1/postgres-mock-oidc-route.test.mjs` (modify) — same rename update, plus the migration file list picks up the two new files automatically (it globs `*.sql`).
- `sigil/relay/v1/real-oidc-route.test.mjs` (new) — in-memory-repository integration tests for `/v1/auth/login`.
- `sigil/relay/v1/postgres-real-oidc-route.test.mjs` (new) — PostgreSQL integration tests for `/v1/auth/login`.

---

### Task 1: Rename the shared replay-guard table and repository methods

**Files:**
- Create: `sigil/migrations/015_rename_login_jti_replays.sql`
- Modify: `sigil/relay/v1/postgres-repository.mjs:876-884` (the `consumeMockLoginJti` method)
- Modify: `sigil/cli/memory-repository.mjs:30-31,268-274` (`consumedMockLoginJtis` Map + `consumeMockLoginJti` method)
- Modify: `sigil/relay/v1/http-server.mjs:656,666` (mock-login route's calls into the repository)
- Modify: `sigil/relay/v1/mock-oidc-route.test.mjs` (any `consumeMockLoginJti` reference in fake repositories)
- Modify: `sigil/relay/v1/postgres-mock-oidc-route.test.mjs` (any direct references, if present)

**Interfaces:**
- Consumes: nothing new.
- Produces: `repository.consumeLoginJti(jti, { now, expiresAt, client })` (Postgres) and `repository.consumeLoginJti(jti, { now, expiresAt })` (memory) — same signature and throw behavior (`{ code: 'TOKEN_REPLAYED' }` on duplicate) as the old `consumeMockLoginJti`, just renamed. Both `/v1/auth/mock-login` and the new `/v1/auth/login` (Task 5) call this one method.

This is a pure rename with no behavior change — do it first so every later task calls the final names.

- [ ] **Step 1: Write the migration renaming the table**

```sql
-- sigil/migrations/015_rename_login_jti_replays.sql
-- Shared jti-replay guard for both POST /v1/auth/mock-login and the
-- production POST /v1/auth/login (docs/superpowers/specs/2026-08-23-sigil-real-oidc-login.md).
-- jti collision across the two routes' tokens is a non-issue in practice
-- (different issuers mint them); one table avoids two near-identical
-- repository methods.
ALTER TABLE mock_login_replays RENAME TO login_jti_replays;
```

- [ ] **Step 2: Rename the Postgres repository method and its SQL**

In `sigil/relay/v1/postgres-repository.mjs`, replace the `consumeMockLoginJti` method (lines 873-884) with:

```javascript
  // Replay guard shared by POST /v1/auth/mock-login and POST /v1/auth/login:
  // the primary-key uniqueness constraint on login_jti_replays.jti makes a
  // second insert of the same jti fail with 23505, mapped here to
  // TOKEN_REPLAYED.
  async consumeLoginJti(jti, { now = new Date(), expiresAt, client = this.pool } = {}) {
    const expires = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt).toISOString();
    try {
      await client.query('INSERT INTO login_jti_replays (jti, expires_at) VALUES ($1, $2)', [jti, expires]);
    } catch (error) {
      if (error.code === '23505') throw Object.assign(new Error('ID token has already been used'), { code: 'TOKEN_REPLAYED' });
      throw error;
    }
  }
```

- [ ] **Step 3: Rename the memory-repository Map and method**

In `sigil/cli/memory-repository.mjs`, rename the `consumedMockLoginJtis` Map (line 31) to `consumedLoginJtis`, and replace the `consumeMockLoginJti` method (lines 268-274) with:

```javascript
    async consumeLoginJti(jti, { now = new Date(), expiresAt }) {
      if (consumedLoginJtis.has(jti)) {
        throw Object.assign(new Error('ID token has already been used'), { code: 'TOKEN_REPLAYED' });
      }
      consumedLoginJtis.set(jti, (expiresAt instanceof Date ? expiresAt : new Date(expiresAt)).toISOString());
      return undefined;
    },
```

- [ ] **Step 4: Update the mock-login route to call the renamed method**

In `sigil/relay/v1/http-server.mjs`, in the `/v1/auth/mock-login` handler:
- Line 656: change `!repository?.consumeMockLoginJti` to `!repository?.consumeLoginJti`.
- Line 666: change `await repository.consumeMockLoginJti(claims.jti, { now, expiresAt, client });` to `await repository.consumeLoginJti(claims.jti, { now, expiresAt, client });`.

- [ ] **Step 5: Update existing test fakes/references**

In `sigil/relay/v1/mock-oidc-route.test.mjs`, in `fakeRepository()` (around line 29), rename `async consumeMockLoginJti() {}` to `async consumeLoginJti() {}`. Search the file for any other `consumeMockLoginJti`/`consumedMockLoginJtis` occurrences and rename them the same way. Do the same check in `sigil/relay/v1/postgres-mock-oidc-route.test.mjs`.

- [ ] **Step 6: Run the existing mock-login test suites to confirm no behavior changed**

Run: `node --test sigil/relay/v1/mock-oidc-route.test.mjs`
Expected: all tests PASS (same as before the rename).

If `SIGIL_TEST_DATABASE_URL` is set in this environment, also run:
Run: `node --test sigil/relay/v1/postgres-mock-oidc-route.test.mjs`
Expected: all tests PASS. If the env var isn't set, these tests skip (per the file's `{ skip: !connectionString }`) — that's fine, don't block on it.

- [ ] **Step 7: Commit**

```bash
git add sigil/migrations/015_rename_login_jti_replays.sql sigil/relay/v1/postgres-repository.mjs sigil/cli/memory-repository.mjs sigil/relay/v1/http-server.mjs sigil/relay/v1/mock-oidc-route.test.mjs sigil/relay/v1/postgres-mock-oidc-route.test.mjs
git commit -m "refactor(sigil): rename mock_login_replays to login_jti_replays for sharing"
```

---

### Task 2: Add `client_id` to the issuer allow-list (both repositories)

**Files:**
- Create: `sigil/migrations/014_oidc_issuer_client_id.sql`
- Modify: `sigil/relay/v1/postgres-repository.mjs` (new `getOidcIssuerAllowlistEntry` method, near `upsertMockOidcIssuerAllowlist` at line 885)
- Modify: `sigil/cli/memory-repository.mjs` (new `oidcIssuerAllowlist` Map, `getOidcIssuerAllowlistEntry` method, and a `_debugSeedOidcIssuer` test helper)
- Test: `sigil/relay/v1/postgres-repository.oidc-issuer.test.mjs` (new)
- Test: `sigil/cli/memory-repository.oidc-issuer.test.mjs` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `repository.getOidcIssuerAllowlistEntry(issuer)` → `Promise<{ issuer, clientId, enabled } | null>` on both repositories. Task 4's `oidc-client.mjs` doesn't call this directly (it's route-level), but Task 5's route handler does, before calling anything in `oidc-client.mjs`.

- [ ] **Step 1: Write the migration**

```sql
-- sigil/migrations/014_oidc_issuer_client_id.sql
-- Real OIDC login (docs/superpowers/specs/2026-08-23-sigil-real-oidc-login.md)
-- validates a token's aud/azp claim against the OAuth client_id Sigil was
-- registered under at each allow-listed issuer. Required (not nullable):
-- an issuer can't be used for real login until an admin provisions this.
ALTER TABLE oidc_issuer_allowlist ADD COLUMN client_id TEXT;
```

Note: added nullable first (existing rows, e.g. any fixture issuer from `upsertMockOidcIssuerAllowlist`, have no `client_id` and must not break). `getOidcIssuerAllowlistEntry` (Step 2) treats a `NULL` `client_id` as "not configured for real login" and the route (Task 5) will reject with `INVALID_ID_TOKEN` in that case — never crash on `NULL`.

- [ ] **Step 2: Add the Postgres lookup method**

In `sigil/relay/v1/postgres-repository.mjs`, add this method near `upsertMockOidcIssuerAllowlist` (after line 896):

```javascript
  async getOidcIssuerAllowlistEntry(issuer) {
    const result = await this.pool.query('SELECT issuer, client_id, enabled FROM oidc_issuer_allowlist WHERE issuer = $1', [issuer]);
    const row = result.rows[0];
    if (!row) return null;
    return { issuer: row.issuer, clientId: row.client_id, enabled: row.enabled };
  }
```

- [ ] **Step 3: Write a Postgres integration test**

```javascript
// sigil/relay/v1/postgres-repository.oidc-issuer.test.mjs
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

async function bootstrap(t) {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  return { pool, repository: new PostgresRepository({ pool }) };
}

test('getOidcIssuerAllowlistEntry returns null for an unknown issuer', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  assert.equal(await repository.getOidcIssuerAllowlistEntry('https://unknown.example'), null);
});

test('getOidcIssuerAllowlistEntry returns clientId/enabled for a seeded issuer', { skip: !connectionString }, async (t) => {
  const { pool, repository } = await bootstrap(t);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  await pool.query(
    `INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, assurance_level, client_id, added_at) VALUES ($1, 'Test IdP', TRUE, 'standard', $2, NOW())`,
    [`https://idp-${suffix}.example`, `client_${suffix}`]
  );
  const entry = await repository.getOidcIssuerAllowlistEntry(`https://idp-${suffix}.example`);
  assert.equal(entry.clientId, `client_${suffix}`);
  assert.equal(entry.enabled, true);
});

test('getOidcIssuerAllowlistEntry returns clientId: null for a row with no client_id set', { skip: !connectionString }, async (t) => {
  const { pool, repository } = await bootstrap(t);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  await pool.query(
    `INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, assurance_level, added_at) VALUES ($1, 'Test IdP', TRUE, 'standard', NOW())`,
    [`https://idp-${suffix}.example`]
  );
  const entry = await repository.getOidcIssuerAllowlistEntry(`https://idp-${suffix}.example`);
  assert.equal(entry.clientId, null);
});
```

- [ ] **Step 4: Run the Postgres test (skips cleanly without a test DB)**

Run: `node --test sigil/relay/v1/postgres-repository.oidc-issuer.test.mjs`
Expected: PASS if `SIGIL_TEST_DATABASE_URL` is set, otherwise all three tests report as skipped — either outcome is fine here, not a failure.

- [ ] **Step 5: Add the memory-repository equivalent**

In `sigil/cli/memory-repository.mjs`, near the top where `humanSessions`/`consumedLoginJtis` are declared (around line 30-31), add:

```javascript
  const oidcIssuerAllowlist = new Map();
```

Add these two methods near `consumeLoginJti` (from Task 1):

```javascript
    async getOidcIssuerAllowlistEntry(issuer) {
      const entry = oidcIssuerAllowlist.get(issuer);
      return entry ? { issuer, clientId: entry.clientId ?? null, enabled: entry.enabled } : null;
    },
    // Test-only: memory-repository has no admin/migration path, so tests
    // that exercise the real-login route seed allow-list rows directly,
    // mirroring how Postgres tests INSERT into oidc_issuer_allowlist.
    _debugSeedOidcIssuer({ issuer, clientId = null, enabled = true }) {
      oidcIssuerAllowlist.set(issuer, { clientId, enabled });
    },
```

- [ ] **Step 6: Write a memory-repository unit test**

```javascript
// sigil/cli/memory-repository.oidc-issuer.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

test('getOidcIssuerAllowlistEntry returns null for an unknown issuer', async () => {
  const repository = createMemoryRepository();
  assert.equal(await repository.getOidcIssuerAllowlistEntry('https://unknown.example'), null);
});

test('getOidcIssuerAllowlistEntry returns a seeded entry', async () => {
  const repository = createMemoryRepository();
  repository._debugSeedOidcIssuer({ issuer: 'https://idp.example', clientId: 'client_123' });
  const entry = await repository.getOidcIssuerAllowlistEntry('https://idp.example');
  assert.deepEqual(entry, { issuer: 'https://idp.example', clientId: 'client_123', enabled: true });
});

test('getOidcIssuerAllowlistEntry reflects enabled: false when seeded that way', async () => {
  const repository = createMemoryRepository();
  repository._debugSeedOidcIssuer({ issuer: 'https://idp.example', clientId: 'client_123', enabled: false });
  const entry = await repository.getOidcIssuerAllowlistEntry('https://idp.example');
  assert.equal(entry.enabled, false);
});
```

- [ ] **Step 7: Run the memory-repository test**

Run: `node --test sigil/cli/memory-repository.oidc-issuer.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add sigil/migrations/014_oidc_issuer_client_id.sql sigil/relay/v1/postgres-repository.mjs sigil/cli/memory-repository.mjs sigil/relay/v1/postgres-repository.oidc-issuer.test.mjs sigil/cli/memory-repository.oidc-issuer.test.mjs
git commit -m "feat(sigil): add client_id to oidc_issuer_allowlist and a lookup method"
```

---

### Task 3: `oidc-client.mjs` — discovery, JWKS fetch, and cache

**Files:**
- Create: `sigil/relay/v1/oidc-client.mjs`
- Test: `sigil/relay/v1/oidc-client.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure module, injectable `fetch`).
- Produces:
  - `discoverIssuer(issuer, { fetchImpl = fetch } = {})` → `Promise<{ jwksUri: string }>`, throws `{ code: 'INVALID_ID_TOKEN' }` on any failure (non-https issuer, network error, malformed JSON, issuer mismatch).
  - `createJwksCache({ fetchImpl = fetch, ttlMs = 3600_000, missCooldownMs = 10_000 } = {})` → `{ getKey(issuer, kid, now) }`, where `getKey` returns `Promise<object | null>` (the raw JWK, or `null` if not found even after one cooldown-gated refetch). This is Task 3's only stateful piece — Task 4 holds one instance per `verifyRealIdToken` caller (i.e. one per route/module lifetime, not per call).

This task has zero dependency on the repository or route layer — it's testable entirely in isolation with a fake `fetch`.

- [ ] **Step 1: Write failing tests for `discoverIssuer`**

```javascript
// sigil/relay/v1/oidc-client.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverIssuer, createJwksCache } from './oidc-client.mjs';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test('discoverIssuer rejects a non-https issuer', async () => {
  await assert.rejects(() => discoverIssuer('http://idp.example'), { code: 'INVALID_ID_TOKEN' });
});

test('discoverIssuer fetches the well-known discovery doc and returns jwksUri', async () => {
  const fetchImpl = async (url) => {
    assert.equal(url, 'https://idp.example/.well-known/openid-configuration');
    return jsonResponse({ issuer: 'https://idp.example', jwks_uri: 'https://idp.example/jwks.json' });
  };
  const result = await discoverIssuer('https://idp.example', { fetchImpl });
  assert.equal(result.jwksUri, 'https://idp.example/jwks.json');
});

test('discoverIssuer rejects when the discovery doc issuer does not match', async () => {
  const fetchImpl = async () => jsonResponse({ issuer: 'https://attacker.example', jwks_uri: 'https://idp.example/jwks.json' });
  await assert.rejects(() => discoverIssuer('https://idp.example', { fetchImpl }), { code: 'INVALID_ID_TOKEN' });
});

test('discoverIssuer rejects on a network error', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(() => discoverIssuer('https://idp.example', { fetchImpl }), { code: 'INVALID_ID_TOKEN' });
});

test('discoverIssuer rejects on a non-ok HTTP status', async () => {
  const fetchImpl = async () => jsonResponse({}, { ok: false, status: 500 });
  await assert.rejects(() => discoverIssuer('https://idp.example', { fetchImpl }), { code: 'INVALID_ID_TOKEN' });
});

test('discoverIssuer rejects on malformed JSON', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
  await assert.rejects(() => discoverIssuer('https://idp.example', { fetchImpl }), { code: 'INVALID_ID_TOKEN' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test sigil/relay/v1/oidc-client.test.mjs`
Expected: FAIL — `oidc-client.mjs` does not exist yet (module not found).

- [ ] **Step 3: Implement `discoverIssuer`**

```javascript
// sigil/relay/v1/oidc-client.mjs
function invalidToken(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ID_TOKEN' });
}

export async function discoverIssuer(issuer, { fetchImpl = fetch } = {}) {
  if (typeof issuer !== 'string' || !issuer.startsWith('https://')) {
    throw invalidToken('OIDC issuer must be an https:// URL');
  }
  let response;
  try {
    response = await fetchImpl(`${issuer}/.well-known/openid-configuration`);
  } catch {
    throw invalidToken('Failed to reach OIDC discovery endpoint');
  }
  if (!response.ok) throw invalidToken(`OIDC discovery endpoint returned HTTP ${response.status}`);
  let doc;
  try {
    doc = await response.json();
  } catch {
    throw invalidToken('Malformed OIDC discovery document');
  }
  // RFC 8414 SS3.3: the discovery document's own issuer must exactly match
  // the issuer it was requested from -- otherwise a doc served from (or
  // proxied through) an unexpected host could redirect trust to a jwks_uri
  // the caller never vetted.
  if (doc.issuer !== issuer) throw invalidToken('OIDC discovery document issuer mismatch');
  if (typeof doc.jwks_uri !== 'string' || !doc.jwks_uri.startsWith('https://')) {
    throw invalidToken('OIDC discovery document missing a valid https jwks_uri');
  }
  return { jwksUri: doc.jwks_uri };
}
```

- [ ] **Step 4: Run the tests to verify `discoverIssuer` passes**

Run: `node --test sigil/relay/v1/oidc-client.test.mjs`
Expected: the 6 `discoverIssuer` tests PASS.

- [ ] **Step 5: Write failing tests for the JWKS cache**

```javascript
// append to sigil/relay/v1/oidc-client.test.mjs

function jwksResponse(keys) {
  return jsonResponse({ keys });
}

test('createJwksCache fetches and returns a key by kid', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount++; return jwksResponse([{ kid: 'key-1', kty: 'RSA' }]); };
  const cache = createJwksCache({ fetchImpl });
  const key = await cache.getKey('https://idp.example/jwks.json', 'key-1', new Date());
  assert.equal(key.kid, 'key-1');
  assert.equal(fetchCount, 1);
});

test('createJwksCache returns null when the kid is not found even after one refetch', async () => {
  const fetchImpl = async () => jwksResponse([{ kid: 'key-1', kty: 'RSA' }]);
  const cache = createJwksCache({ fetchImpl });
  const key = await cache.getKey('https://idp.example/jwks.json', 'missing-kid', new Date());
  assert.equal(key, null);
});

test('createJwksCache serves from cache within TTL without refetching', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount++; return jwksResponse([{ kid: 'key-1', kty: 'RSA' }]); };
  const cache = createJwksCache({ fetchImpl, ttlMs: 3600_000 });
  const t0 = new Date('2026-08-23T00:00:00Z');
  await cache.getKey('https://idp.example/jwks.json', 'key-1', t0);
  await cache.getKey('https://idp.example/jwks.json', 'key-1', new Date(t0.getTime() + 1000));
  assert.equal(fetchCount, 1);
});

test('createJwksCache refetches after TTL expiry', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount++; return jwksResponse([{ kid: 'key-1', kty: 'RSA' }]); };
  const cache = createJwksCache({ fetchImpl, ttlMs: 1000 });
  const t0 = new Date('2026-08-23T00:00:00Z');
  await cache.getKey('https://idp.example/jwks.json', 'key-1', t0);
  await cache.getKey('https://idp.example/jwks.json', 'key-1', new Date(t0.getTime() + 1001));
  assert.equal(fetchCount, 2);
});

test('createJwksCache refetches once on a kid miss even within TTL (rotation)', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount++;
    return fetchCount === 1 ? jwksResponse([{ kid: 'old-key', kty: 'RSA' }]) : jwksResponse([{ kid: 'new-key', kty: 'RSA' }]);
  };
  const cache = createJwksCache({ fetchImpl, ttlMs: 3600_000 });
  const t0 = new Date('2026-08-23T00:00:00Z');
  await cache.getKey('https://idp.example/jwks.json', 'old-key', t0);
  const key = await cache.getKey('https://idp.example/jwks.json', 'new-key', new Date(t0.getTime() + 1000));
  assert.equal(key.kid, 'new-key');
  assert.equal(fetchCount, 2);
});

test('createJwksCache does not refetch a second time for a kid miss within the cooldown window', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount++; return jwksResponse([{ kid: 'key-1', kty: 'RSA' }]); };
  const cache = createJwksCache({ fetchImpl, ttlMs: 3600_000, missCooldownMs: 10_000 });
  const t0 = new Date('2026-08-23T00:00:00Z');
  await cache.getKey('https://idp.example/jwks.json', 'missing', t0); // fetch #1 (initial), fetch #2 (miss refetch)
  await cache.getKey('https://idp.example/jwks.json', 'missing', new Date(t0.getTime() + 1000)); // within cooldown: no fetch #3
  assert.equal(fetchCount, 2);
});

test('createJwksCache allows a refetch again once the cooldown has elapsed', async () => {
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount++; return jwksResponse([{ kid: 'key-1', kty: 'RSA' }]); };
  const cache = createJwksCache({ fetchImpl, ttlMs: 3600_000, missCooldownMs: 10_000 });
  const t0 = new Date('2026-08-23T00:00:00Z');
  await cache.getKey('https://idp.example/jwks.json', 'missing', t0); // fetch #1, #2
  await cache.getKey('https://idp.example/jwks.json', 'missing', new Date(t0.getTime() + 10_001)); // cooldown elapsed: fetch #3
  assert.equal(fetchCount, 3);
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `node --test sigil/relay/v1/oidc-client.test.mjs`
Expected: FAIL — `createJwksCache` is not exported yet.

- [ ] **Step 7: Implement `createJwksCache`**

Append to `sigil/relay/v1/oidc-client.mjs`:

```javascript
async function fetchJwks(jwksUri, fetchImpl) {
  if (typeof jwksUri !== 'string' || !jwksUri.startsWith('https://')) {
    throw invalidToken('jwks_uri must be an https:// URL');
  }
  let response;
  try {
    response = await fetchImpl(jwksUri);
  } catch {
    throw invalidToken('Failed to reach JWKS endpoint');
  }
  if (!response.ok) throw invalidToken(`JWKS endpoint returned HTTP ${response.status}`);
  let doc;
  try {
    doc = await response.json();
  } catch {
    throw invalidToken('Malformed JWKS document');
  }
  if (!Array.isArray(doc.keys)) throw invalidToken('JWKS document missing a keys array');
  return doc.keys;
}

// Cache keyed by jwksUri (the route resolves jwksUri via discoverIssuer
// first, then calls getKey with that URI). TTL and a per-URI kid-miss
// refetch cooldown bound how often this ever calls out to the network --
// see docs/superpowers/specs/2026-08-23-sigil-real-oidc-login.md's "Cached
// JWKS with rotation refetch" section for the reasoning.
export function createJwksCache({ fetchImpl = fetch, ttlMs = 3600_000, missCooldownMs = 10_000 } = {}) {
  const cache = new Map(); // jwksUri -> { keys, fetchedAt, lastMissRefetchAt }

  async function refetch(jwksUri, now) {
    const keys = await fetchJwks(jwksUri, fetchImpl);
    const entry = { keys, fetchedAt: now.getTime(), lastMissRefetchAt: cache.get(jwksUri)?.lastMissRefetchAt ?? -Infinity };
    cache.set(jwksUri, entry);
    return entry;
  }

  return {
    async getKey(jwksUri, kid, now = new Date()) {
      let entry = cache.get(jwksUri);
      if (!entry || now.getTime() - entry.fetchedAt > ttlMs) {
        entry = await refetch(jwksUri, now);
      }
      let key = entry.keys.find((k) => k.kid === kid);
      if (!key) {
        const cooledDown = now.getTime() - entry.lastMissRefetchAt > missCooldownMs;
        if (cooledDown) {
          entry = await refetch(jwksUri, now);
          entry.lastMissRefetchAt = now.getTime();
          key = entry.keys.find((k) => k.kid === kid);
        }
      }
      return key ?? null;
    }
  };
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test sigil/relay/v1/oidc-client.test.mjs`
Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add sigil/relay/v1/oidc-client.mjs sigil/relay/v1/oidc-client.test.mjs
git commit -m "feat(sigil): add OIDC discovery + cached JWKS fetch (oidc-client.mjs)"
```

---

### Task 4: `verifyRealIdToken` — RS256/ES256 signature and claim verification

**Files:**
- Modify: `sigil/relay/v1/oidc-client.mjs` (add `verifyRealIdToken`)
- Modify: `sigil/relay/v1/oidc-client.test.mjs` (add verification tests)

**Interfaces:**
- Consumes: `createJwksCache` from Task 3 (same module).
- Produces: `verifyRealIdToken(token, { issuer, clientId, jwksCache, jwksUri, now = () => new Date() })` → `Promise<{ issuer, subject, email, jti }>` where `jti` is `payload.jti ?? undefined` (no fallback derivation here — that's the route's job, Task 5). Throws `{ code: 'INVALID_ID_TOKEN' }` on any verification failure. This is the function Task 5's route calls after resolving `jwksUri` via `discoverIssuer` and `clientId` via `repository.getOidcIssuerAllowlistEntry`.

This task is the security-critical core: alg/kty pinning, ieee-p1363 ECDSA, `aud`/`azp` checks, clock skew — all called out explicitly in the spec and in the prior architecture review.

- [ ] **Step 1: Generate fixture RSA and EC keypairs for tests, and a small local signer helper**

Add this test-only helper at the top of `sigil/relay/v1/oidc-client.test.mjs` (it signs tokens the same way a real IdP would, purely so tests have real tokens to verify against — it is never exported from `oidc-client.mjs` itself):

```javascript
import crypto from 'node:crypto';

function b64url(buffer) { return buffer.toString('base64url'); }

function signToken({ privateKey, alg, header = {}, payload }) {
  const fullHeader = { alg, typ: 'JWT', ...header };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(fullHeader)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const options = alg === 'ES256' ? { key: privateKey, dsaEncoding: 'ieee-p1363' } : { key: privateKey };
  const signature = crypto.sign(alg === 'ES256' ? 'sha256' : 'RSA-SHA256', Buffer.from(signingInput), options);
  return `${signingInput}.${b64url(signature)}`;
}

const rsaKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ecKeyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const rsaJwk = { ...rsaKeyPair.publicKey.export({ format: 'jwk' }), kid: 'rsa-key-1' };
const ecJwk = { ...ecKeyPair.publicKey.export({ format: 'jwk' }), kid: 'ec-key-1' };

const ISSUER = 'https://idp.example';
const CLIENT_ID = 'sigil-client-1';
const JWKS_URI = 'https://idp.example/jwks.json';

function makeCache(keys) {
  return createJwksCache({ fetchImpl: async () => jwksResponse(keys) });
}

function basePayload(overrides = {}) {
  const iat = Math.floor(FIXED_NOW.getTime() / 1000);
  return { iss: ISSUER, sub: 'sub_1', email: 'a@example.com', email_verified: true, aud: CLIENT_ID, iat, exp: iat + 300, jti: crypto.randomUUID(), ...overrides };
}

const FIXED_NOW = new Date('2026-08-23T00:00:00Z');
```

- [ ] **Step 2: Write failing tests for RS256/ES256 round trips and alg/kty pinning**

```javascript
// append to sigil/relay/v1/oidc-client.test.mjs
import { verifyRealIdToken } from './oidc-client.mjs';

test('verifyRealIdToken: RS256 round trip succeeds and returns issuer/subject/email/jti', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload: basePayload() });
  const claims = await verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW });
  assert.equal(claims.issuer, ISSUER);
  assert.equal(claims.subject, 'sub_1');
  assert.equal(claims.email, 'a@example.com');
  assert.equal(typeof claims.jti, 'string');
});

test('verifyRealIdToken: ES256 round trip succeeds with a raw r||s signature', async () => {
  const token = signToken({ privateKey: ecKeyPair.privateKey, alg: 'ES256', header: { kid: ecJwk.kid }, payload: basePayload() });
  const claims = await verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([ecJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW });
  assert.equal(claims.subject, 'sub_1');
});

test('verifyRealIdToken: rejects alg/kty mismatch (RS256 header, EC key)', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: ecJwk.kid }, payload: basePayload() });
  await assert.rejects(
    () => verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([ecJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW }),
    { code: 'INVALID_ID_TOKEN' }
  );
});

test('verifyRealIdToken: rejects an unsupported alg (none)', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid, alg: 'none' }, payload: basePayload() });
  // Force header.alg to 'none' after signing so the signature itself is irrelevant to this check.
  const [, payloadSeg, sigSeg] = token.split('.');
  const noneHeader = b64url(Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: rsaJwk.kid })));
  const tampered = `${noneHeader}.${payloadSeg}.${sigSeg}`;
  await assert.rejects(
    () => verifyRealIdToken(tampered, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW }),
    { code: 'INVALID_ID_TOKEN' }
  );
});

test('verifyRealIdToken: rejects when kid is not found in the JWKS', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: 'unknown-kid' }, payload: basePayload() });
  await assert.rejects(
    () => verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW }),
    { code: 'INVALID_ID_TOKEN' }
  );
});

test('verifyRealIdToken: rejects a tampered signature', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload: basePayload() });
  const [header, payload, signature] = token.split('.');
  const tampered = `${header}.${payload}.${signature.slice(0, -4)}${signature.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
  await assert.rejects(
    () => verifyRealIdToken(tampered, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW }),
    { code: 'INVALID_ID_TOKEN' }
  );
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test sigil/relay/v1/oidc-client.test.mjs`
Expected: FAIL — `verifyRealIdToken` is not exported yet.

- [ ] **Step 4: Implement `verifyRealIdToken`**

Append to `sigil/relay/v1/oidc-client.mjs`:

```javascript
import crypto from 'node:crypto';

const REQUIRED_CLAIMS = ['iss', 'sub', 'email', 'email_verified', 'iat', 'exp'];
const CLOCK_SKEW_SECONDS = 30;
const ALG_TO_KTY = { RS256: 'RSA', ES256: 'EC' };

function jwkToKeyObject(jwk) {
  if (jwk.kty !== 'RSA' && jwk.kty !== 'EC') throw invalidToken(`Unsupported JWK key type: ${jwk.kty}`);
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

export async function verifyRealIdToken(token, { issuer, clientId, jwksCache, jwksUri, now = () => new Date() } = {}) {
  if (typeof token !== 'string') throw invalidToken('ID token must be a string');
  const segments = token.split('.');
  if (segments.length !== 3) throw invalidToken('Malformed compact JWS');
  const [headerSegment, payloadSegment, signatureSegment] = segments;

  let header;
  try { header = JSON.parse(Buffer.from(headerSegment, 'base64url').toString()); }
  catch { throw invalidToken('Malformed JWS header'); }

  const expectedKty = ALG_TO_KTY[header.alg];
  if (!expectedKty) throw invalidToken(`Unsupported or missing alg: ${header.alg}`);

  const jwk = await jwksCache.getKey(jwksUri, header.kid, typeof now === 'function' ? now() : now);
  if (!jwk) throw invalidToken(`No matching JWKS key for kid: ${header.kid}`);
  // Alg/kty confusion guard: a header claiming RS256 must resolve to an
  // RSA key, ES256 to an EC key. Checked before the signature is touched.
  if (jwk.kty !== expectedKty) throw invalidToken('Token alg does not match resolved key type');
  const publicKey = jwkToKeyObject(jwk);

  const signature = Buffer.from(signatureSegment, 'base64url');
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const verifyOptions = header.alg === 'ES256' ? { key: publicKey, dsaEncoding: 'ieee-p1363' } : { key: publicKey };
  let signatureValid;
  try { signatureValid = crypto.verify(header.alg === 'ES256' ? 'sha256' : 'RSA-SHA256', Buffer.from(signingInput), verifyOptions, signature); }
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
  if (payload.iss !== issuer) throw invalidToken('Unexpected issuer');

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(clientId)) throw invalidToken('aud does not include the expected client_id');
  // azp pins the actual requesting client when an IdP puts a broader value
  // in aud -- Google notably does this. Only enforced when present.
  if ('azp' in payload && payload.azp !== clientId) throw invalidToken('azp does not match the expected client_id');

  const nowSeconds = Math.floor((typeof now === 'function' ? now() : now).getTime() / 1000);
  if (nowSeconds > payload.exp + CLOCK_SKEW_SECONDS) throw invalidToken('ID token has expired');
  if (nowSeconds < payload.iat - CLOCK_SKEW_SECONDS) throw invalidToken('ID token is not yet valid');

  return { issuer: payload.iss, subject: payload.sub, email: payload.email, jti: payload.jti };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test sigil/relay/v1/oidc-client.test.mjs`
Expected: all tests PASS.

- [ ] **Step 6: Write and run additional claim-validation tests (aud/azp/expiry/missing-jti)**

```javascript
// append to sigil/relay/v1/oidc-client.test.mjs

test('verifyRealIdToken: rejects wrong aud', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload: basePayload({ aud: 'someone-else' }) });
  await assert.rejects(
    () => verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW }),
    { code: 'INVALID_ID_TOKEN' }
  );
});

test('verifyRealIdToken: accepts aud as an array containing clientId', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload: basePayload({ aud: ['other-app', CLIENT_ID] }) });
  const claims = await verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW });
  assert.equal(claims.subject, 'sub_1');
});

test('verifyRealIdToken: rejects mismatched azp even when aud matches', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload: basePayload({ aud: [CLIENT_ID], azp: 'a-different-app' }) });
  await assert.rejects(
    () => verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW }),
    { code: 'INVALID_ID_TOKEN' }
  );
});

test('verifyRealIdToken: rejects an expired token outside the 30s skew window', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload: basePayload() });
  const past = new Date(FIXED_NOW.getTime() + 300_000 + 31_000);
  await assert.rejects(
    () => verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => past }),
    { code: 'INVALID_ID_TOKEN' }
  );
});

test('verifyRealIdToken: rejects email_verified: false', async () => {
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload: basePayload({ email_verified: false }) });
  await assert.rejects(
    () => verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW }),
    { code: 'INVALID_ID_TOKEN' }
  );
});

test('verifyRealIdToken: accepts a token with no jti claim, returning jti: undefined', async () => {
  const payload = basePayload();
  delete payload.jti;
  const token = signToken({ privateKey: rsaKeyPair.privateKey, alg: 'RS256', header: { kid: rsaJwk.kid }, payload });
  const claims = await verifyRealIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksCache: makeCache([rsaJwk]), jwksUri: JWKS_URI, now: () => FIXED_NOW });
  assert.equal(claims.jti, undefined);
});
```

Run: `node --test sigil/relay/v1/oidc-client.test.mjs`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add sigil/relay/v1/oidc-client.mjs sigil/relay/v1/oidc-client.test.mjs
git commit -m "feat(sigil): add verifyRealIdToken (RS256/ES256, aud/azp, JWKS-backed)"
```

---

### Task 5: `POST /v1/auth/login` route

**Files:**
- Modify: `sigil/relay/v1/http-server.mjs` (new route, new imports, one module-level `jwksCache` instance)
- Test: `sigil/relay/v1/real-oidc-route.test.mjs` (new, in-memory repository)

**Interfaces:**
- Consumes: `discoverIssuer`, `verifyRealIdToken`, `createJwksCache` (Tasks 3-4); `repository.getOidcIssuerAllowlistEntry` (Task 2); `repository.consumeLoginJti`, `repository.createHumanSession`, `repository.recordAuditEvent`, `repository.withTransaction`, `attemptDirectoryMatchOnOidcLogin` (all pre-existing, same as the mock-login route).
- Produces: the `POST /v1/auth/login` HTTP route itself — nothing downstream depends on this as a function interface, since it's the terminal consumer in this plan.

This route deliberately mirrors the mock-login handler's structure (same file, right below it) so a reviewer can diff the two side by side.

- [ ] **Step 1: Write failing route tests (in-memory repository)**

```javascript
// sigil/relay/v1/real-oidc-route.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRelayServer } from './http-server.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

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

const FIXED_NOW = new Date('2026-08-23T00:00:00Z');
const ISSUER = 'https://idp.example';
const CLIENT_ID = 'sigil-client-1';
const JWKS_URI = 'https://idp.example/jwks.json';

function b64url(buffer) { return buffer.toString('base64url'); }
function signToken({ privateKey, alg = 'RS256', header = {}, payload }) {
  const fullHeader = { alg, typ: 'JWT', ...header };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(fullHeader)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const options = alg === 'ES256' ? { key: privateKey, dsaEncoding: 'ieee-p1363' } : { key: privateKey };
  const signature = crypto.sign(alg === 'ES256' ? 'sha256' : 'RSA-SHA256', Buffer.from(signingInput), options);
  return `${signingInput}.${b64url(signature)}`;
}

const rsaKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaJwk = { ...rsaKeyPair.publicKey.export({ format: 'jwk' }), kid: 'rsa-key-1' };

function basePayload(overrides = {}) {
  const iat = Math.floor(FIXED_NOW.getTime() / 1000);
  return { iss: ISSUER, sub: 'sub_1', email: 'a@example.com', email_verified: true, aud: CLIENT_ID, iat, exp: iat + 300, jti: crypto.randomUUID(), ...overrides };
}

function makeToken(overrides = {}) {
  return signToken({ privateKey: rsaKeyPair.privateKey, header: { kid: rsaJwk.kid }, payload: basePayload(overrides) });
}

function fetchImplFor(keys = [rsaJwk]) {
  return async (url) => {
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return { ok: true, status: 200, json: async () => ({ issuer: ISSUER, jwks_uri: JWKS_URI }) };
    }
    if (url === JWKS_URI) {
      return { ok: true, status: 200, json: async () => ({ keys }) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

async function repositoryWithIssuer() {
  const repository = createMemoryRepository();
  repository._debugSeedOidcIssuer({ issuer: ISSUER, clientId: CLIENT_ID, enabled: true });
  return repository;
}

test('unrecognized issuer -- 401, no outbound fetch attempted', async () => {
  const repository = createMemoryRepository(); // no issuer seeded
  let fetchCalls = 0;
  const fetchImpl = async (...args) => { fetchCalls++; return fetchImplFor()(...args); };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImpl }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: makeToken() } });
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'INVALID_ID_TOKEN');
    assert.equal(fetchCalls, 0);
  });
});

test('success path creates a session and returns match: null when nothing pending', async () => {
  const repository = await repositoryWithIssuer();
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImplFor() }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: makeToken() } });
    assert.equal(result.status, 201);
    assert.equal(result.body.session.human_id, 'usr_1');
    assert.equal(result.body.match, null);
  });
});

test('missing principal.human_id -- 403, no writes performed', async () => {
  const repository = await repositoryWithIssuer();
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImplFor() }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: makeToken() } });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'HUMAN_CONTEXT_REQUIRED');
  });
});

test('bad token (wrong aud) -- 401 INVALID_ID_TOKEN', async () => {
  const repository = await repositoryWithIssuer();
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImplFor() }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: makeToken({ aud: 'someone-else' }) } });
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'INVALID_ID_TOKEN');
  });
});

test('replayed token (same jti twice) -- second call 401 TOKEN_REPLAYED', async () => {
  const repository = await repositoryWithIssuer();
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImplFor() }, async (port) => {
    const token = makeToken();
    const first = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: token } });
    assert.equal(first.status, 201);
    const second = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: token } });
    assert.equal(second.status, 401);
    assert.equal(second.body.code, 'TOKEN_REPLAYED');
  });
});

test('token with no jti: first login succeeds, replaying the same token fails, a fresh token for the same subject succeeds', async () => {
  const repository = await repositoryWithIssuer();
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImplFor() }, async (port) => {
    const payload = basePayload(); delete payload.jti;
    const token = signToken({ privateKey: rsaKeyPair.privateKey, header: { kid: rsaJwk.kid }, payload });
    const first = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: token } });
    assert.equal(first.status, 201);
    const replay = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: token } });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.code, 'TOKEN_REPLAYED');
    const payload2 = basePayload({ iat: payload.iat + 1, exp: payload.exp + 1 }); delete payload2.jti;
    const token2 = signToken({ privateKey: rsaKeyPair.privateKey, header: { kid: rsaJwk.kid }, payload: payload2 });
    const second = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: token2 } });
    assert.equal(second.status, 201);
  });
});

test('IdP discovery endpoint unreachable -- 401, not a 5xx', async () => {
  const repository = await repositoryWithIssuer();
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_1', human_id: 'usr_1' }), now: () => FIXED_NOW, oidcFetchImpl: fetchImpl }, async (port) => {
    const result = await request(port, { method: 'POST', path: '/v1/auth/login', body: { id_token: makeToken() } });
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'INVALID_ID_TOKEN');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test sigil/relay/v1/real-oidc-route.test.mjs`
Expected: FAIL — route doesn't exist yet (404s / `oidcFetchImpl` option ignored).

- [ ] **Step 3: Wire the imports and a module-level cache into `http-server.mjs`**

Near the top of `sigil/relay/v1/http-server.mjs`, alongside the existing `import { verifyMockIdToken } from './mock-oidc.mjs';` (line 11), add:

```javascript
import { discoverIssuer, verifyRealIdToken, createJwksCache } from './oidc-client.mjs';
```

In the `createRelayServer({ ... })` destructured options (line 31), add `oidcFetchImpl = fetch` to the parameter list (defaults to the global `fetch`; tests override it to avoid real network calls):

```javascript
export function createRelayServer({ registry, idempotency = new Map(), lookupIdempotency, persist, repository, authenticate, tokenHashes, now: configuredNow = () => new Date(), stream, relayOrigin, rpId, approvalChallenges = new Map(), maxPendingApprovals = 100, oidcIssuerAllowList = new Set(), lookupHumanCredential, verifyAssertion, enableMockOidc = false, oidcFetchImpl = fetch } = {}) {
```

Immediately after that line, add one cache shared across all requests this server instance handles (mirrors `idempotency`/`approvalChallenges` being created once per server, not per request):

```javascript
  const jwksCache = createJwksCache({ fetchImpl: oidcFetchImpl });
```

- [ ] **Step 4: Add the route handler**

Immediately after the existing `/v1/auth/mock-login` block (after line 678, before the final `response.writeHead(404, ...)` at line 679), add:

```javascript
    if (request.method === 'POST' && request.url === '/v1/auth/login') {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body?.id_token) { response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'id_token is required', details: {} })); }

      if (!repository?.getOidcIssuerAllowlistEntry || !repository?.consumeLoginJti || !repository?.createHumanSession || !repository?.recordAuditEvent) {
        response.writeHead(503, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'REAL_LOGIN_UNAVAILABLE', message: 'Repository does not support real OIDC login', details: {} }));
      }

      // Read the issuer from the token's unverified payload purely to do the
      // allow-list lookup -- it is not trusted until verifyRealIdToken
      // confirms the signature against that same issuer's own JWKS below.
      // Rejecting an unrecognized issuer here, before any outbound fetch,
      // is what keeps discoverIssuer/JWKS fetch from ever running against
      // an attacker-supplied host.
      let unverifiedIssuer;
      try {
        const segments = body.id_token.split('.');
        unverifiedIssuer = JSON.parse(Buffer.from(segments[1], 'base64url').toString()).iss;
      } catch {
        response.writeHead(401, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ID_TOKEN', message: 'Malformed ID token', details: {} }));
      }

      const allowlistEntry = await repository.getOidcIssuerAllowlistEntry(unverifiedIssuer);
      if (!allowlistEntry || !allowlistEntry.enabled || !allowlistEntry.clientId) {
        response.writeHead(401, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ID_TOKEN', message: 'Issuer is not allow-listed for real OIDC login', details: {} }));
      }

      let claims;
      try {
        const { jwksUri } = await discoverIssuer(unverifiedIssuer, { fetchImpl: oidcFetchImpl });
        claims = await verifyRealIdToken(body.id_token, { issuer: unverifiedIssuer, clientId: allowlistEntry.clientId, jwksCache, jwksUri, now: () => now });
      } catch (error) {
        response.writeHead(401, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'INVALID_ID_TOKEN', message: error.message, details: {} }));
      }

      // Real IdPs are inconsistent about including jti (Google's standard ID
      // tokens omit it). When absent, derive a stable replay key from the
      // signature segment: same token replayed -> same key -> collides; a
      // fresh token for the same subject has a different signature -> no
      // false-positive block on legitimate re-logins.
      const replayKey = claims.jti ?? crypto.createHash('sha256').update(`${claims.issuer}:${claims.subject}:${body.id_token.split('.')[2]}`).digest('hex');

      try {
        const sessionId = `sess_${crypto.randomUUID()}`;
        const sessionTtlMs = 5 * 60 * 1000;
        const expiresAt = new Date(now.getTime() + sessionTtlMs);
        const result = await repository.withTransaction(async (client) => {
          await repository.consumeLoginJti(replayKey, { now, expiresAt, client });
          const session = await repository.createHumanSession({ sessionId, humanId: principal.human_id, authenticationMethod: 'oidc', assurance: 'standard', issuedAt: now, expiresAt, now, client });
          await repository.recordAuditEvent?.({ eventType: 'human_session.created', subjectId: sessionId, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'human_session', objectId: sessionId, outcome: 'success', now, client });
          const match = await attemptDirectoryMatchOnOidcLogin({ repository: { claimDirectoryMatch: (args) => repository.claimDirectoryMatch({ ...args, client }) }, issuer: claims.issuer, verifiedEmail: claims.email, matchedHumanId: principal.human_id, now });
          return { session, match };
        });
        response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', session: result.session, match: result.match ?? null }));
      } catch (error) {
        response.writeHead(error.code === 'TOKEN_REPLAYED' ? 401 : 500, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'REAL_LOGIN_FAILED', message: error.message, details: {} }));
      }
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test sigil/relay/v1/real-oidc-route.test.mjs`
Expected: all tests PASS.

- [ ] **Step 6: Run the full existing suite to check for regressions**

Run: `node --test sigil/relay/v1/http-server.test.mjs sigil/relay/v1/mock-oidc-route.test.mjs sigil/relay/v1/mock-oidc.test.mjs sigil/relay/v1/oidc-client.test.mjs sigil/relay/v1/real-oidc-route.test.mjs`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add sigil/relay/v1/http-server.mjs sigil/relay/v1/real-oidc-route.test.mjs
git commit -m "feat(sigil): add POST /v1/auth/login (real OIDC, JWKS-verified)"
```

---

### Task 6: PostgreSQL integration tests for `/v1/auth/login`

**Files:**
- Test: `sigil/relay/v1/postgres-real-oidc-route.test.mjs` (new)

**Interfaces:**
- Consumes: everything from Tasks 1-5, exercised against a real PostgreSQL instance.
- Produces: nothing new — this task is test-only, closing the gap between the in-memory tests (Task 5) and the transactional/FK behavior only Postgres exercises (mirrors why `postgres-mock-oidc-route.test.mjs` exists alongside `mock-oidc-route.test.mjs`).

- [ ] **Step 1: Write the integration test file**

```javascript
// sigil/relay/v1/postgres-real-oidc-route.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { createRelayServer } from './http-server.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

const ISSUER = 'https://idp.example';
const CLIENT_ID = 'sigil-client-1';
const JWKS_URI = 'https://idp.example/jwks.json';
const FIXED_NOW = new Date('2026-08-23T00:00:00Z');

function b64url(buffer) { return buffer.toString('base64url'); }
function signToken({ privateKey, header = {}, payload }) {
  const fullHeader = { alg: 'RS256', typ: 'JWT', ...header };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(fullHeader)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

const rsaKeyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaJwk = { ...rsaKeyPair.publicKey.export({ format: 'jwk' }), kid: 'rsa-key-1' };

function makeToken(overrides = {}) {
  const iat = Math.floor(FIXED_NOW.getTime() / 1000);
  const payload = { iss: ISSUER, sub: 'sub_1', email: 'a@example.com', email_verified: true, aud: CLIENT_ID, iat, exp: iat + 300, jti: crypto.randomUUID(), ...overrides };
  return signToken({ privateKey: rsaKeyPair.privateKey, header: { kid: rsaJwk.kid }, payload });
}

function fetchImpl(url) {
  if (url === `${ISSUER}/.well-known/openid-configuration`) return Promise.resolve({ ok: true, status: 200, json: async () => ({ issuer: ISSUER, jwks_uri: JWKS_URI }) });
  if (url === JWKS_URI) return Promise.resolve({ ok: true, status: 200, json: async () => ({ keys: [rsaJwk] }) });
  return Promise.reject(new Error(`Unexpected fetch: ${url}`));
}

async function bootstrap(t, { seedIssuer = true } = {}) {
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
  if (seedIssuer) {
    await pool.query(
      `INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, assurance_level, client_id, added_at) VALUES ($1, 'Test IdP', TRUE, 'standard', $2, NOW())`,
      [ISSUER, CLIENT_ID]
    );
  }
  const repository = new PostgresRepository({ pool });
  const server = createRelayServer({ repository, authenticate: async () => ({ endpoint_id: endpointId, human_id: humanId }), now: () => FIXED_NOW, oidcFetchImpl: fetchImpl });
  const port = await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { pool, humanId, endpointId, baseUrl: `http://127.0.0.1:${port}` };
}

async function post(baseUrl, idToken) {
  const response = await fetch(`${baseUrl}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id_token: idToken }) });
  return { status: response.status, body: await response.json() };
}

test('unrecognized issuer -- 401, session table untouched', { skip: !connectionString }, async (t) => {
  const { pool, baseUrl } = await bootstrap(t, { seedIssuer: false });
  const result = await post(baseUrl, makeToken());
  assert.equal(result.status, 401);
  const sessions = await pool.query('SELECT count(*) FROM human_sessions');
  assert.equal(Number(sessions.rows[0].count), 0);
});

test('success path creates a durable session row and audit event', { skip: !connectionString }, async (t) => {
  const { pool, humanId, baseUrl } = await bootstrap(t);
  const result = await post(baseUrl, makeToken());
  assert.equal(result.status, 201);
  const sessions = await pool.query('SELECT human_id FROM human_sessions WHERE session_id = $1', [result.body.session.session_id]);
  assert.equal(sessions.rows[0].human_id, humanId);
  const audit = await pool.query(`SELECT * FROM audit_events WHERE event_type = 'human_session.created' AND subject_id = $1`, [result.body.session.session_id]);
  assert.equal(audit.rows[0].actor_human_id, humanId);
});

test('replayed token -- second call 401 TOKEN_REPLAYED, only one session row exists', { skip: !connectionString }, async (t) => {
  const { pool, baseUrl } = await bootstrap(t);
  const token = makeToken();
  const first = await post(baseUrl, token);
  assert.equal(first.status, 201);
  const second = await post(baseUrl, token);
  assert.equal(second.status, 401);
  assert.equal(second.body.code, 'TOKEN_REPLAYED');
  const sessions = await pool.query('SELECT count(*) FROM human_sessions');
  assert.equal(Number(sessions.rows[0].count), 1);
});

test('simulated mid-sequence failure rolls back the transaction; retrying the same token afterward succeeds', { skip: !connectionString }, async (t) => {
  const { pool, humanId, endpointId } = await bootstrap(t);
  const repository = new PostgresRepository({ pool });
  const failingRepository = new Proxy(repository, {
    get(target, prop) {
      if (prop === 'createHumanSession') {
        let calls = 0;
        return async (...args) => { calls++; if (calls === 1) throw new Error('simulated failure'); return target.createHumanSession(...args); };
      }
      return target[prop];
    }
  });
  const server = createRelayServer({ repository: failingRepository, authenticate: async () => ({ endpoint_id: endpointId, human_id: humanId }), now: () => FIXED_NOW, oidcFetchImpl: fetchImpl });
  const port = await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = makeToken();
  const failed = await post(baseUrl, token);
  assert.equal(failed.status, 500);
  const retried = await post(baseUrl, token);
  assert.equal(retried.status, 201);
});
```

- [ ] **Step 2: Run the test (skips cleanly without a test DB)**

Run: `node --test sigil/relay/v1/postgres-real-oidc-route.test.mjs`
Expected: PASS if `SIGIL_TEST_DATABASE_URL` is set; otherwise all tests report skipped.

- [ ] **Step 3: Commit**

```bash
git add sigil/relay/v1/postgres-real-oidc-route.test.mjs
git commit -m "test(sigil): add PostgreSQL integration coverage for POST /v1/auth/login"
```

---

### Task 7: Documentation and roadmap update

**Files:**
- Modify: `docs/meta/sigil-cli-roadmap.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: nothing (docs only).
- Produces: nothing consumed by other tasks — this is the final task.

- [ ] **Step 1: Update the roadmap**

In `docs/meta/sigil-cli-roadmap.md`, the "What this is not" section (around lines 64-69) currently reads: "First-contact trust exists but isn't wired to a real IdP... No live/external OIDC client, no JWKS-over-HTTPS fetch, no real IdP integration exists yet." Replace that bullet with:

```markdown
- **First-contact trust is now wired to real IdPs.** `POST /v1/auth/login`
  verifies real ID tokens (RS256/ES256) against a live, JWKS-backed IdP
  keyset, validated against a per-issuer `client_id`
  (`oidc_issuer_allowlist.client_id`). `POST /v1/auth/mock-login` remains for
  local dev/CI only. See
  `docs/superpowers/specs/2026-08-23-sigil-real-oidc-login.md`.
```

Also update the numbered "Immediate next candidates" item that previously read "Real IdP integration for OIDC first-contact match..." (around lines 106-109) — remove that bullet entirely, since it is now done.

- [ ] **Step 2: Add a CHANGELOG entry**

Add an entry to `CHANGELOG.md` under the current unreleased/top section (match the file's existing format by reading its first ~10 lines before editing):

```markdown
- Added `POST /v1/auth/login`: production OIDC login backed by live IdP
  discovery and JWKS fetch (RS256/ES256, aud/azp validation, JWKS caching
  with rotation refetch). Closes the "real IdP integration" roadmap item.
```

- [ ] **Step 3: Commit**

```bash
git add docs/meta/sigil-cli-roadmap.md CHANGELOG.md
git commit -m "docs(sigil): update roadmap and changelog for real OIDC login"
```

---

## Final Verification

- [ ] **Run the complete test suite for the touched area**

Run: `node --test sigil/relay/v1/*.test.mjs sigil/cli/*.test.mjs`
Expected: all PASS (Postgres-only tests skip if `SIGIL_TEST_DATABASE_URL` is unset).

- [ ] **If a test database is available, run the full suite against it**

Run: `SIGIL_TEST_DATABASE_URL=<disposable-test-db-url> node --test sigil/relay/v1/*.test.mjs sigil/cli/*.test.mjs`
Expected: all PASS, including every Postgres-gated test in Tasks 1, 2, and 6.
