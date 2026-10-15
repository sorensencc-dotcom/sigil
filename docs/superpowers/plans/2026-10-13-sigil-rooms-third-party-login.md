# Sigil rooms third-party login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person invited by the operator logs into the rooms web client through GitHub and gets a cookie session on a cookie-only public listener, with no pasted bearer token.

**Architecture:** The relay runs authorization-code + PKCE (S256) itself and issues an `__Host-sigil_session` cookie. A second HTTP listener (`--public-port`) whose dispatch table is the allowlist carries only the OAuth, `/v1/auth/*`, `/v1/rooms*`, `/v1/mentions` routes plus a ticket-only stream endpoint. A TLS proxy (Tailscale Serve) fronts that listener and `sigil-rooms-web` on one origin (`--public-origin`). First contact needs an operator-created invite; a linked identity logs in without one.

**Tech Stack:** Node ESM, `node:test`, `pg` (Postgres only), `ws`, existing relay modules, React/Vite client in `packages/sigil-rooms-web`, Playwright for the one browser check.

**Spec:** `docs/superpowers/specs/2026-10-11-sigil-rooms-third-party-login-design.md` (read it first; this plan cites it as "spec §").

## Global Constraints

- GitHub is the only provider in v1. The provider interface stays so Google is additive. No Google code.
- Every authorize URL carries `code_challenge_method=S256`. `plain` is never produced.
- Every provider fetch uses `outboundFetchOptions` (5 s timeout, `redirect: 'error'`). No provider URL is read from a request.
- GitHub requests no scope. `subject` is the numeric account `id` as a string, never `login`. Issuer is the fixed string `https://github.com`.
- Cookies: `__Host-sigil_session` and `__Host-sigil_oauth`, both `HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`. Values are 256 random bits; only the SHA-256 is stored or keyed.
- Session: 7-day absolute cap (`expires_at`), 8-hour idle window (`last_seen_at`, written only when stale by more than 5 minutes). OAuth rows use `authentication_method = 'oauth_github'`, `assurance = 'standard'`.
- Each listener has one credential type. The main listener stays bearer-only. The public listener authenticates cookies only and ignores `Authorization`.
- Cookie-authenticated non-GET requests require `X-Sigil-CSRF: 1` and `Origin` exactly equal to `--public-origin`, else 403.
- Provider tokens, secrets, and codes never appear in logs or audit rows. `audit_events.subject_id` is NOT NULL.
- OAuth login requires Postgres. Without a database the routes return 501.
- Do not grow `sigil.mjs` (1869 lines), `postgres-repository.mjs` (2546), or `http-server.mjs` (1126) beyond the smallest wiring edit. New logic goes in new modules.
- No sidecar, no `oauth_flows` table (flow state is process-local).

## Execution notes

- **Branch base.** This worktree (`docs/sigil-rooms-third-party-login-spec`) already contains the multi-human foundation (PR #52). Run Task 0 first. If PR #52 has merged, rebase onto `main` before starting.
- **Preflight.** Before any read, write, test, or push in this worktree run `pwsh -NoProfile -File 'C:\dev\scripts\verify-repo-context.ps1' -Path 'C:\dev\.worktrees\sigil-third-party-login'`. Quote the paths; Git Bash strips unquoted backslashes.
- **Test timeout.** Every test command is wrapped in `timeout 60`. A single file runs well inside that. Never run the full suite in the foreground.
- **Pre-push hook.** `git push` runs the full suite (more than 10 minutes). Push with `run_in_background`, then check the real `git push` exit code, not the wrapper's. Run one background suite at a time; overlapping runs leak node processes and deadlock the shared Postgres.
- **Postgres tests.** `*.pg.test.mjs` read a connection string from the environment and skip when absent, like `sigil/migrations/033_multi_human_foundation.test.mjs`. Local disposable DB: `postgres://sigil:sigil_password@localhost:55432/sigil_test`. Each pg test passes through `assertDisposableTestDatabase`.
- **Out of this plan.** The deferred router-pick-vs-suspension race (STATUS.md known gap: `SELECT 1 FROM humans WHERE human_id=$1 FOR SHARE` on the trigger sender's `owner_id` in `room-routes.mjs`) is a separate change. Do not fold it in here.

## File structure

| File | Responsibility |
| --- | --- |
| `sigil/migrations/034_oauth_login.sql` (+ `.test.mjs`) | Schema: `room_invites`, `room_invite_rooms`, `human_sessions` and `oidc_identities` columns, composite FKs, quota constraint |
| `sigil/relay/v1/outbound-fetch.mjs` | `outboundFetchOptions` (single definition) |
| `sigil/relay/v1/oauth/flow-store.mjs` | Process-local TTL'd single-use OAuth flow store |
| `sigil/relay/v1/oauth/providers/github.mjs` | GitHub provider (`authorizeUrl`, `exchangeCode`, `resolveIdentity`) |
| `sigil/relay/v1/oauth/cookies.mjs` | Cookie parse/serialize, 256-bit value + hash |
| `sigil/relay/v1/oauth/invites.mjs` | Invite create/list/revoke (repository-level, takes `client`) |
| `sigil/relay/v1/oauth/login-tx.mjs` | Callback decision: returning login, link-with-invite, reactivation |
| `sigil/relay/v1/oauth/session-auth.mjs` | Cookie authenticator, session touch, session liveness row |
| `sigil/relay/v1/oauth/csrf.mjs` | Origin / `X-Sigil-CSRF` / `Sec-Fetch-Site` checks |
| `sigil/relay/v1/oauth/public-listener.mjs` | Allowlist dispatch for the cookie-only listener |
| `sigil/relay/v1/oauth/oauth-routes.mjs` | `handleOAuthPublicRoute`, `handleOAuthSessionRoute` |
| `sigil/relay/v1/oauth/wiring.mjs` | Builds listener, authenticator, flow store, startup assertions for `relay up` |
| `sigil/cli/oauth-commands.mjs` | `relay invite create/list/revoke`, `relay identity revoke` |
| `packages/sigil-rooms-web/...` | Static server `--auth-mode`, cookie-mode client |

Modified (smallest edits): `oidc-client.mjs`, `peer-discovery.mjs`, `postgres-repository.mjs` (`createHumanSession`, `createOidcIdentity`, session lookup), `ticket-store.mjs`, `stream-server.mjs`, `liveness.mjs`, `http-server.mjs` (pre-gate dispatch), `sigil.mjs` (flags, wiring, command dispatch), `sigil-rooms-web` server and client files.

---

### Task 0: Verify the base and read the anchors

**Files:** none modified.

- [ ] **Step 1: Run the preflight and confirm the foundation is present**

```bash
pwsh -NoProfile -File 'C:\dev\scripts\verify-repo-context.ps1' -Path 'C:\dev\.worktrees\sigil-third-party-login'
git log --oneline -3
ls sigil/migrations | tail -3
git fetch origin && git ls-tree --name-only origin/main sigil/migrations/ | tail -3
```

Expected: preflight prints the worktree row; `033_multi_human_foundation.sql` exists; `main` has no migration numbered above the highest here. If `main` has gained a `034_*`, use the next free number everywhere this plan says `034`.

- [ ] **Step 2: Record column types the migration depends on**

```bash
grep -n "CREATE TABLE human_sessions" -A 14 sigil/migrations/003_plugin_connector_auth.sql
grep -n "CREATE TABLE oidc_identities" -A 10 sigil/migrations/003_plugin_connector_auth.sql
grep -n "quota_usage_scope_kind_check" -B1 -A8 sigil/migrations/018_federation_directory.sql
```

Expected: timestamp column type for `issued_at`/`expires_at` (use the same type for `last_seen_at`), and the eleven `scope_kind` values listed in spec §Errors and abuse handling. If the type is `TEXT`, use `TEXT` in Task 1 and keep ISO strings.

- [ ] **Step 3: Confirm the authenticator cache anchor**

```bash
sed -n 15,70p sigil/relay/v1/transport-auth.mjs
```

Expected: a per-endpoint cache keyed by `endpoint_id`. The cookie authenticator in Task 6 does **not** reuse it (it keys by session, not endpoint). Cookie lookups hit one indexed join per request; no new cache in v1.

---

### Task 1: Migration 034

**Files:**
- Create: `sigil/migrations/034_oauth_login.sql`
- Test: `sigil/migrations/034_oauth_login.test.mjs`

**Interfaces:**
- Produces: tables `room_invites`, `room_invite_rooms`; columns `oidc_identities.verified_via`, `oidc_identities.endpoint_id`, `human_sessions.endpoint_id|last_seen_at|identity_issuer|identity_subject`; `quota_usage` scope kinds `invite`, `oauth_provider_subject`, `oauth_start`.

- [ ] **Step 1: Write the failing test**

Model it on `sigil/migrations/033_multi_human_foundation.test.mjs` (same imports, `connectionString`, skip pattern, `applyMigrations`). Content assertions plus behavior:

```js
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../scripts/apply-migrations.mjs';

const sql = fs.readFileSync(new URL('./034_oauth_login.sql', import.meta.url), 'utf8');
const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('034 declares the login schema', () => {
  for (const pattern of [
    /CREATE TABLE room_invites/, /CREATE TABLE room_invite_rooms/,
    /ADD COLUMN verified_via TEXT/, /ADD COLUMN last_seen_at/, /ADD COLUMN identity_issuer/,
    /FOREIGN KEY \(endpoint_id, human_id\) REFERENCES endpoints \(endpoint_id, owner_id\)/,
    /oauth_provider_subject/, /oauth_start/, /federation_directory_redemption_inbound/,
  ]) assert.match(sql, pattern);
});

test('034 constraints behave', { skip: !connectionString }, async (t) => {
  await assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString);
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const s = crypto.randomBytes(4).toString('hex');
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 3600_000).toISOString();
  for (const h of ['a', 'b']) {
    await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1,'active',$2)`, [`hum_${h}_${s}`, now]);
    await pool.query(
      `INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at)
       VALUES ($1,$2,'human','human',$3,$4,'active',$5)`,
      [`ep_${h}_${s}`, `hum_${h}_${s}`, `inst_${h}_${s}`, h, now]);
  }
  const session = (id, endpoint, human, extra = {}) => pool.query(
    `INSERT INTO human_sessions (session_id, human_id, authentication_method, assurance, device_context, issued_at, expires_at, endpoint_id, last_seen_at, identity_issuer, identity_subject)
     VALUES ($1,$2,'oauth_github','standard','{}',$3,$4,$5,$6,$7,$8)`,
    [id, human, now, later, endpoint, extra.lastSeen ?? now, extra.issuer ?? 'https://github.com', extra.subject ?? '1']);
  await session(`s1_${s}`, `ep_a_${s}`, `hum_a_${s}`);
  await assert.rejects(session(`s2_${s}`, `ep_a_${s}`, `hum_b_${s}`), /foreign key/i); // endpoint of another human
  await assert.rejects(session(`s3_${s}`, `ep_a_${s}`, `hum_a_${s}`, { lastSeen: null }), /check/i);
  // step-up row: null endpoint_id still inserts
  await pool.query(
    `INSERT INTO human_sessions (session_id, human_id, authentication_method, assurance, device_context, issued_at, expires_at)
     VALUES ($1,$2,'mock_oidc','standard','{}',$3,$4)`, [`s4_${s}`, `hum_a_${s}`, now, later]);
  // invite CHECKs
  const invite = (id, cols) => pool.query(
    `INSERT INTO room_invites (invite_id, token_hash, name, created_by_human_id, created_at, expires_at ${cols.names})
     VALUES ($1,$2,'n',$3,$4,$5 ${cols.values})`, [id, `th_${id}`, `hum_a_${s}`, now, later, ...cols.params]);
  await invite(`i1_${s}`, { names: '', values: '', params: [] });
  await assert.rejects(invite(`i2_${s}`, { names: ', consumed_at', values: ', $6', params: [now] }), /check/i); // consumed without consumer
  await assert.rejects(invite(`i3_${s}`, { names: ', target_issuer', values: ', $6', params: ['https://github.com'] }), /check/i); // partial target
  // quota scope kinds
  for (const kind of ['invite', 'oauth_provider_subject', 'oauth_start', 'federation_origin']) {
    await pool.query(`INSERT INTO quota_usage (scope_kind, scope_id, window_start, count) VALUES ($1,$2,$3,1)`, [kind, `k_${s}`, now]);
  }
});
```

Adjust the `quota_usage` column list to the real columns (`grep -n "CREATE TABLE quota_usage" sigil/migrations/*.sql`). The test env var name must match what `033`'s test reads; copy it.

- [ ] **Step 2: Run to verify it fails**

Run: `timeout 60 node --test sigil/migrations/034_oauth_login.test.mjs`
Expected: FAIL, `ENOENT ... 034_oauth_login.sql`.

- [ ] **Step 3: Write the migration**

Use the timestamp type found in Task 0 Step 2 (shown here as `TIMESTAMPTZ`).

```sql
-- OAuth login: invites, verified identities, cookie sessions.

ALTER TABLE oidc_identities
  ADD COLUMN verified_via TEXT,
  ADD COLUMN endpoint_id TEXT,
  ADD CONSTRAINT oidc_identities_verified_via_check CHECK (verified_via IN ('oauth')),
  ADD CONSTRAINT oidc_identities_verified_endpoint_check CHECK (verified_via IS NULL OR endpoint_id IS NOT NULL),
  ADD CONSTRAINT oidc_identities_endpoint_owner_fk
    FOREIGN KEY (endpoint_id, human_id) REFERENCES endpoints (endpoint_id, owner_id);

ALTER TABLE human_sessions
  ADD COLUMN endpoint_id TEXT,
  ADD COLUMN last_seen_at TIMESTAMPTZ,
  ADD COLUMN identity_issuer TEXT,
  ADD COLUMN identity_subject TEXT,
  ADD CONSTRAINT human_sessions_identity_pair_check
    CHECK ((identity_issuer IS NULL) = (identity_subject IS NULL)),
  ADD CONSTRAINT human_sessions_cookie_row_check
    CHECK (endpoint_id IS NULL OR (last_seen_at IS NOT NULL AND identity_issuer IS NOT NULL)),
  ADD CONSTRAINT human_sessions_endpoint_owner_fk
    FOREIGN KEY (endpoint_id, human_id) REFERENCES endpoints (endpoint_id, owner_id);
CREATE INDEX human_sessions_identity_idx ON human_sessions (identity_issuer, identity_subject);

CREATE TABLE room_invites (
  invite_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_by_human_id TEXT NOT NULL REFERENCES humans (human_id),
  target_human_id TEXT,
  target_endpoint_id TEXT,
  target_issuer TEXT,
  target_subject TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by_human_id TEXT REFERENCES humans (human_id),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT room_invites_consumed_pair_check CHECK ((consumed_at IS NULL) = (consumed_by_human_id IS NULL)),
  CONSTRAINT room_invites_not_both_check CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  CONSTRAINT room_invites_target_all_or_none_check CHECK (
    (target_human_id IS NULL AND target_endpoint_id IS NULL AND target_issuer IS NULL AND target_subject IS NULL)
    OR (target_human_id IS NOT NULL AND target_endpoint_id IS NOT NULL AND target_issuer IS NOT NULL AND target_subject IS NOT NULL)),
  CONSTRAINT room_invites_target_endpoint_fk
    FOREIGN KEY (target_endpoint_id, target_human_id) REFERENCES endpoints (endpoint_id, owner_id)
);

CREATE TABLE room_invite_rooms (
  invite_id TEXT NOT NULL REFERENCES room_invites (invite_id),
  room_id TEXT NOT NULL REFERENCES rooms (conversation_id),
  role TEXT NOT NULL CHECK (role IN ('member', 'room_manager')),
  PRIMARY KEY (invite_id, room_id)
);

ALTER TABLE quota_usage DROP CONSTRAINT quota_usage_scope_kind_check;
ALTER TABLE quota_usage ADD CONSTRAINT quota_usage_scope_kind_check CHECK (scope_kind IN (
  'endpoint', 'owner', 'conversation',
  'directory_invite_create', 'directory_invite_redeem', 'directory_match_create', 'directory_match_attempt',
  'federation_origin', 'federation_directory_invite_create', 'federation_directory_redeem',
  'federation_directory_redemption_inbound',
  'invite', 'oauth_provider_subject', 'oauth_start'));
```

If Task 0 Step 2 shows the live constraint lists a different set than the eleven names above, copy the live list and append the three new kinds.

- [ ] **Step 4: Run to verify it passes**

Run: `timeout 60 node --test sigil/migrations/034_oauth_login.test.mjs`
Expected: PASS (the behavior test is skipped without the database env var; run it once with the local disposable DB).

- [ ] **Step 5: Commit**

```bash
git add sigil/migrations/034_oauth_login.sql sigil/migrations/034_oauth_login.test.mjs
git commit -m "feat(sigil): add oauth login schema (invites, cookie sessions, verified identities)"
```

---

### Task 2: Single `outboundFetchOptions`

**Files:**
- Create: `sigil/relay/v1/outbound-fetch.mjs`
- Modify: `sigil/relay/v1/oidc-client.mjs:15`, `sigil/relay/v1/peer-discovery.mjs:9`
- Test: `sigil/relay/v1/outbound-fetch.test.mjs`

**Interfaces:**
- Produces: `export function outboundFetchOptions(): { signal: AbortSignal, redirect: 'error' }`

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { outboundFetchOptions } from './outbound-fetch.mjs';

test('fresh signal per call, redirect refused', () => {
  const a = outboundFetchOptions();
  const b = outboundFetchOptions();
  assert.equal(a.redirect, 'error');
  assert.notEqual(a.signal, b.signal);
  assert.equal(a.signal.aborted, false);
});
```

- [ ] **Step 2:** Run `timeout 60 node --test sigil/relay/v1/outbound-fetch.test.mjs`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement and switch both callers**

```js
// sigil/relay/v1/outbound-fetch.mjs
// Fixed timeout and no-follow redirect policy for every outbound fetch. The
// signal is created per call: one shared AbortSignal.timeout would fire once and
// then stay aborted for every later request.
export function outboundFetchOptions() {
  return { signal: AbortSignal.timeout(5000), redirect: 'error' };
}
```

In `oidc-client.mjs` delete the local function (lines 15-17 plus its comment block above) and add `import { outboundFetchOptions } from './outbound-fetch.mjs';`. In `peer-discovery.mjs` do the same (its local copy at line 9 mirrors it).

- [ ] **Step 4:** Run `timeout 60 node --test sigil/relay/v1/outbound-fetch.test.mjs sigil/relay/v1/oidc-client.test.mjs sigil/relay/v1/peer-discovery.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/outbound-fetch.mjs sigil/relay/v1/outbound-fetch.test.mjs sigil/relay/v1/oidc-client.mjs sigil/relay/v1/peer-discovery.mjs
git commit -m "refactor(sigil): share outboundFetchOptions between oidc-client and peer-discovery"
```

---

### Task 3: Cookie helpers and flow store

**Files:**
- Create: `sigil/relay/v1/oauth/cookies.mjs`, `sigil/relay/v1/oauth/flow-store.mjs`
- Test: `sigil/relay/v1/oauth/cookies.test.mjs`, `sigil/relay/v1/oauth/flow-store.test.mjs`

**Interfaces:**
- Produces (`cookies.mjs`):
  - `newCookieSecret(): { value: string, hash: string }` — 256 random bits base64url, SHA-256 hex.
  - `hashCookie(value: string): string`
  - `parseCookies(header: string | undefined): Record<string,string>`
  - `setCookie(name, value, { maxAge }): string` — `Name=value; Max-Age=n; Secure; Path=/; HttpOnly; SameSite=Lax`
  - `clearCookie(name): string` — `Name=; Max-Age=0; Secure; Path=/; HttpOnly; SameSite=Lax`
  - consts `SESSION_COOKIE = '__Host-sigil_session'`, `FLOW_COOKIE = '__Host-sigil_oauth'`
- Produces (`flow-store.mjs`):
  - `createFlowStore({ now, ttlMs = 600_000, maxEntries = 10_000 })` returning `{ start({ provider, inviteId }): { cookieValue, flow }, take(cookieValue): flow | null, size() }`
  - `flow = { flow_id, state, nonce, pkceVerifier, codeChallenge, provider, inviteId }`. `start` throws `{ code: 'FLOW_CAP' }` when full after a sweep.

- [ ] **Step 1: Write the failing tests**

```js
// cookies.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newCookieSecret, hashCookie, parseCookies, setCookie, clearCookie, SESSION_COOKIE } from './cookies.mjs';

test('secret is 256 bits and hash is its sha256', () => {
  const { value, hash } = newCookieSecret();
  assert.equal(Buffer.from(value, 'base64url').length, 32);
  assert.equal(hash, crypto.createHash('sha256').update(value, 'utf8').digest('hex'));
  assert.equal(hashCookie(value), hash);
});
test('set and clear carry the __Host- attributes', () => {
  for (const header of [setCookie(SESSION_COOKIE, 'v', { maxAge: 10 }), clearCookie(SESSION_COOKIE)]) {
    for (const attr of ['Secure', 'Path=/', 'HttpOnly', 'SameSite=Lax']) assert.match(header, new RegExp(attr));
    assert.doesNotMatch(header, /Domain/i);
  }
  assert.match(clearCookie(SESSION_COOKIE), /Max-Age=0/);
});
test('parseCookies tolerates junk', () => {
  assert.deepEqual(parseCookies('a=1; b=2;;  c'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies(undefined), {});
});
```

```js
// flow-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createFlowStore } from './flow-store.mjs';

test('take is single-use and keyed by cookie', () => {
  const store = createFlowStore();
  const { cookieValue, flow } = store.start({ provider: 'github', inviteId: 'inv_1' });
  assert.equal(store.take('wrong'), null);
  assert.deepEqual(store.take(cookieValue), flow);
  assert.equal(store.take(cookieValue), null);
});
test('challenge is S256 of the verifier', () => {
  const { flow } = createFlowStore().start({ provider: 'github' });
  const expected = crypto.createHash('sha256').update(flow.pkceVerifier).digest('base64url');
  assert.equal(flow.codeChallenge, expected);
});
test('expires and caps', () => {
  let t = 0;
  const store = createFlowStore({ now: () => new Date(t), ttlMs: 1000, maxEntries: 2 });
  const a = store.start({ provider: 'github' });
  store.start({ provider: 'github' });
  assert.throws(() => store.start({ provider: 'github' }), { code: 'FLOW_CAP' });
  t = 2000;
  assert.equal(store.take(a.cookieValue), null); // expired
  assert.doesNotThrow(() => store.start({ provider: 'github' })); // sweep freed room
});
```

- [ ] **Step 2:** Run `timeout 60 node --test sigil/relay/v1/oauth/cookies.test.mjs sigil/relay/v1/oauth/flow-store.test.mjs`. Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

```js
// cookies.mjs
import crypto from 'node:crypto';

export const SESSION_COOKIE = '__Host-sigil_session';
export const FLOW_COOKIE = '__Host-sigil_oauth';

export const hashCookie = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

export function newCookieSecret() {
  const value = crypto.randomBytes(32).toString('base64url');
  return { value, hash: hashCookie(value) };
}

export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

const ATTRS = 'Secure; Path=/; HttpOnly; SameSite=Lax';
export const setCookie = (name, value, { maxAge }) => `${name}=${value}; Max-Age=${maxAge}; ${ATTRS}`;
// A __Host- cookie set without Secure and Path=/ is ignored, and a bare Max-Age=0
// without Path would target /v1/auth; clearing repeats every attribute.
export const clearCookie = (name) => `${name}=; Max-Age=0; ${ATTRS}`;
```

```js
// flow-store.mjs
import crypto from 'node:crypto';
import { newCookieSecret, hashCookie } from './cookies.mjs';

// Process-local, like ticket-store.mjs. A relay restart mid-login costs one retry.
export function createFlowStore({ now = () => new Date(), ttlMs = 600_000, maxEntries = 10_000 } = {}) {
  const entries = new Map(); // sha256(cookie) -> { flow, expiresAt }
  const sweep = () => {
    const t = now().getTime();
    for (const [key, entry] of entries) if (entry.expiresAt <= t) entries.delete(key);
  };
  return {
    start({ provider, inviteId = null }) {
      sweep();
      if (entries.size >= maxEntries) throw Object.assign(new Error('flow store full'), { code: 'FLOW_CAP' });
      const { value, hash } = newCookieSecret();
      const pkceVerifier = crypto.randomBytes(32).toString('base64url');
      const flow = {
        flow_id: `flow_${crypto.randomBytes(8).toString('hex')}`,
        state: crypto.randomBytes(24).toString('base64url'),
        nonce: crypto.randomBytes(24).toString('base64url'),
        pkceVerifier,
        codeChallenge: crypto.createHash('sha256').update(pkceVerifier).digest('base64url'),
        provider,
        inviteId,
      };
      entries.set(hash, { flow, expiresAt: now().getTime() + ttlMs });
      return { cookieValue: value, flow };
    },
    take(cookieValue) {
      if (typeof cookieValue !== 'string' || !cookieValue) return null;
      const key = hashCookie(cookieValue);
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      return entry.expiresAt > now().getTime() ? entry.flow : null;
    },
    size: () => entries.size,
  };
}
```

- [ ] **Step 4:** Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/oauth/cookies.mjs sigil/relay/v1/oauth/cookies.test.mjs sigil/relay/v1/oauth/flow-store.mjs sigil/relay/v1/oauth/flow-store.test.mjs
git commit -m "feat(sigil): oauth cookie helpers and single-use flow store"
```

---

### Task 4: GitHub provider

**Files:**
- Create: `sigil/relay/v1/oauth/providers/github.mjs`
- Test: `sigil/relay/v1/oauth/providers/github.test.mjs`

**Interfaces:**
- Produces: `createGitHubProvider({ clientId, clientSecret, endpoints?, fetchImpl = fetch })` returning `{ name: 'github', issuer: 'https://github.com', authorizeUrl({ state, nonce, codeChallenge, redirectUri }), exchangeCode({ code, codeVerifier, redirectUri }), resolveIdentity({ accessToken }) }`. `resolveIdentity` returns `{ issuer, subject, displayName }`.
- `endpoints` defaults to `{ authorize: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token', api: 'https://api.github.com' }`. Override is only for fake-IdP tests; the wiring module (Task 10) passes it only when `--enable-mock-oauth` is set.
- Errors: throws `Error` with `code: 'PROVIDER_ERROR'` on any non-2xx, missing token, or missing numeric id.

- [ ] **Step 1: Write the failing test** (fake GitHub on a local port)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGitHubProvider } from './github.mjs';

async function fakeGitHub(t, handlers) {
  const server = http.createServer((req, res) => handlers(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, endpoints: { authorize: `${base}/authorize`, tokenUrl: `${base}/token`, api: base } };
}

test('authorize URL pins S256, sends state, requests no scope', () => {
  const p = createGitHubProvider({ clientId: 'cid', clientSecret: 's' });
  const url = new URL(p.authorizeUrl({ state: 'st', nonce: 'n', codeChallenge: 'cc', redirectUri: 'https://x.test/v1/auth/oauth/github/callback' }));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'cc');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.has('scope'), false);
});

test('exchange then resolve uses the numeric id, not login', async (t) => {
  let tokenBody;
  const { endpoints } = await fakeGitHub(t, async (req, res) => {
    if (req.url === '/token') {
      tokenBody = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ access_token: 'gho_x', token_type: 'bearer' }));
    }
    assert.equal(req.headers.authorization, 'Bearer gho_x');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 4242, login: 'octo', name: 'Octo Cat' }));
  });
  const p = createGitHubProvider({ clientId: 'cid', clientSecret: 'sec', endpoints });
  const { accessToken } = await p.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'https://x.test/cb' });
  assert.match(tokenBody, /code_verifier=v/);
  assert.deepEqual(await p.resolveIdentity({ accessToken }), { issuer: 'https://github.com', subject: '4242', displayName: 'Octo Cat' });
});

test('provider failures carry PROVIDER_ERROR', async (t) => {
  const { endpoints } = await fakeGitHub(t, (req, res) => { res.statusCode = 500; res.end('no'); });
  const p = createGitHubProvider({ clientId: 'cid', clientSecret: 'sec', endpoints });
  await assert.rejects(p.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'r' }), { code: 'PROVIDER_ERROR' });
  await assert.rejects(p.resolveIdentity({ accessToken: 't' }), { code: 'PROVIDER_ERROR' });
});

test('a redirect from the provider is refused', async (t) => {
  const { endpoints } = await fakeGitHub(t, (req, res) => { res.statusCode = 302; res.setHeader('location', 'http://127.0.0.1:1/'); res.end(); });
  const p = createGitHubProvider({ clientId: 'cid', clientSecret: 'sec', endpoints });
  await assert.rejects(p.resolveIdentity({ accessToken: 't' }), { code: 'PROVIDER_ERROR' });
});
```

- [ ] **Step 2:** Run `timeout 60 node --test sigil/relay/v1/oauth/providers/github.test.mjs`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```js
import { outboundFetchOptions } from '../../outbound-fetch.mjs';

const DEFAULT_ENDPOINTS = {
  authorize: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  api: 'https://api.github.com',
};
const ISSUER = 'https://github.com';
const providerError = (message) => Object.assign(new Error(message), { code: 'PROVIDER_ERROR' });

export function createGitHubProvider({ clientId, clientSecret, endpoints = DEFAULT_ENDPOINTS, fetchImpl = fetch } = {}) {
  const call = async (url, init) => {
    let response;
    try { response = await fetchImpl(url, { ...init, ...outboundFetchOptions() }); }
    catch { throw providerError('provider unreachable'); }
    if (!response.ok) throw providerError(`provider returned HTTP ${response.status}`);
    try { return await response.json(); } catch { throw providerError('provider returned invalid JSON'); }
  };
  return {
    name: 'github',
    issuer: ISSUER,
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const url = new URL(endpoints.authorize);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.toString();
    },
    async exchangeCode({ code, codeVerifier, redirectUri }) {
      const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, code_verifier: codeVerifier, redirect_uri: redirectUri });
      const json = await call(endpoints.tokenUrl, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body });
      if (typeof json.access_token !== 'string' || !json.access_token) throw providerError('provider returned no access token');
      return { accessToken: json.access_token };
    },
    async resolveIdentity({ accessToken }) {
      const json = await call(`${endpoints.api}/user`, { headers: { accept: 'application/json', authorization: `Bearer ${accessToken}`, 'user-agent': 'sigil-relay' } });
      if (!Number.isSafeInteger(json.id)) throw providerError('provider returned no numeric id');
      return { issuer: ISSUER, subject: String(json.id), displayName: typeof json.name === 'string' && json.name ? json.name : undefined };
    },
  };
}
```

- [ ] **Step 4:** Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/oauth/providers/
git commit -m "feat(sigil): github oauth provider with S256 pkce and numeric-id subject"
```

---

### Task 5: Repository extensions (sessions, identities, invites)

**Files:**
- Modify: `sigil/relay/v1/postgres-repository.mjs:1177` (`createOidcIdentity`), `:1239` (`createHumanSession`)
- Create: `sigil/relay/v1/oauth/invites.mjs`
- Test: `sigil/relay/v1/oauth/invites.pg.test.mjs`, extend `sigil/relay/v1/identity-auth-repository.integration.test.mjs` pattern with a new `sigil/relay/v1/oauth/session-columns.pg.test.mjs`

**Interfaces:**
- `createOidcIdentity({ issuer, subject, humanId, status, now, client = this.pool, verifiedVia = null, endpointId = null })` — adds the three optional fields; `createOidcIdentityWithAudit` is unchanged (it opens its own transaction and does not pass `client`).
- `createHumanSession({ ..., endpointId = null, lastSeenAt = null, identityIssuer = null, identitySubject = null })` — inserts the four columns; step-up callers pass none and keep working.
- `invites.mjs` exports (all take an explicit `client`):
  - `createInvite(client, { name, createdByHumanId, rooms: [{ roomId, role }], target = null /* { humanId, endpointId, issuer, subject } */, ttlMs, now }): { invite_id, token }` — token is 128+ random bits, only `sha256` stored. Validates roles ∈ {member, room_manager}, that the creator manages every room (`lockManagerRows` + role in owner/room_manager), and for a target that the endpoint is `kind='human'`, active, and owned by the target human.
  - `listInvites(client, { now }): Array<{ invite_id, name, rooms, expires_at, state: 'open'|'consumed'|'revoked'|'expired', consumed_by_human_id }>`
  - `revokeInvite(client, { inviteId, actorHumanId, now }): { revoked: boolean }` — the `UPDATE ... WHERE consumed_at IS NULL AND revoked_at IS NULL`; writes `invite.revoked` audit (subject = actor human id) only when a row changed.
  - `hashInviteToken(token): string`

- [ ] **Step 1: Write failing tests** (pg, same skip pattern)

`invites.pg.test.mjs` cases, each using a fixture helper that provisions an operator human + endpoint + a room the operator manages (reuse `provisionHumanTx` with a test wrap key from `key-wrap.test.mjs`, and `repository.createRoom...` per `provision-human.pg.test.mjs`; copy its fixture):
  1. `createInvite` returns a token whose sha256 equals the stored `token_hash`, and the raw token is not stored anywhere in the row.
  2. Rejects `role: 'owner'` with `INVALID_ROLE`; rejects a creator who does not manage a listed room with `ROUTE_NOT_AUTHORIZED`.
  3. Targeted invite rejects an endpoint whose `kind` is `agent` and one owned by a different human.
  4. `revokeInvite` on an open invite sets `revoked_at` and writes one `invite.revoked` audit row; on a consumed invite it returns `{ revoked: false }` and changes nothing.
  5. `listInvites` state is `expired` once `expires_at` has passed and `consumed` with the consumer id after consumption.

`session-columns.pg.test.mjs`: `createHumanSession` with the four new fields inserts and returns them; without them it inserts a step-up row with nulls; a mismatched `(endpointId, humanId)` fails the composite FK; `createOidcIdentity` with `client` participates in the caller's transaction (rolled back with it) and `verifiedVia: 'oauth'` without `endpointId` violates the CHECK.

- [ ] **Step 2:** Run `timeout 60 node --test sigil/relay/v1/oauth/invites.pg.test.mjs sigil/relay/v1/oauth/session-columns.pg.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement the repository edits**

```js
// createOidcIdentity: replace the body, keep the signature's existing fields
async createOidcIdentity({ issuer, subject, humanId, status = 'active', now = new Date(), client = this.pool, verifiedVia = null, endpointId = null } = {}) {
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const result = await client.query(
    `INSERT INTO oidc_identities (issuer, subject, human_id, status, created_at, verified_via, endpoint_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING issuer, subject, human_id, status, created_at, verified_via, endpoint_id`,
    [issuer, subject, humanId, status, timestamp, verifiedVia, endpointId]
  );
  return result.rows[0];
}
```

```js
// createHumanSession: add four optional params and columns
async createHumanSession({ sessionId, humanId, authenticationMethod, assurance, deviceContext = {}, issuedAt = new Date(), expiresAt, now = new Date(), client = this.pool, endpointId = null, lastSeenAt = null, identityIssuer = null, identitySubject = null } = {}) {
  assertAssurance(assurance);
  const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
  const result = await client.query(
    `INSERT INTO human_sessions (session_id, human_id, authentication_method, assurance, device_context, issued_at, expires_at, endpoint_id, last_seen_at, identity_issuer, identity_subject)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING session_id, human_id, authentication_method, assurance, device_context, issued_at, version, expires_at, revoked_at, endpoint_id, last_seen_at, identity_issuer, identity_subject`,
    [sessionId, humanId, authenticationMethod, assurance, JSON.stringify(deviceContext), iso(issuedAt), iso(expiresAt), endpointId, lastSeenAt ? iso(lastSeenAt) : null, identityIssuer, identitySubject]
  );
  return result.rows[0];
}
```

Then write `invites.mjs`:

```js
import crypto from 'node:crypto';
import { lockManagerRows } from '../provision-human.mjs';

const ROLES = new Set(['member', 'room_manager']);
const MANAGER = new Set(['owner', 'room_manager']);
export const hashInviteToken = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });

export async function createInvite(client, { name, createdByHumanId, rooms = [], target = null, ttlMs, now = new Date() }) {
  if (!name) throw fail('INVALID_INVITE', 'invite name is required');
  for (const { role } of rooms) if (!ROLES.has(role)) throw fail('INVALID_ROLE', 'role must be member or room_manager');
  const roomIds = [...new Set(rooms.map((r) => r.roomId))].sort();
  if (roomIds.length) {
    const locked = await lockManagerRows(client, createdByHumanId, roomIds);
    const managed = new Set(locked.filter((r) => r.owner_id === createdByHumanId && r.removed_at === null && MANAGER.has(r.role)).map((r) => r.conversation_id));
    const missing = roomIds.filter((id) => !managed.has(id));
    if (missing.length) throw fail('ROUTE_NOT_AUTHORIZED', `creator does not manage: ${missing.join(', ')}`);
  }
  if (target) {
    const { rows } = await client.query(
      `SELECT e.kind, e.status, e.owner_id FROM endpoints e WHERE e.endpoint_id = $1`, [target.endpointId]);
    const row = rows[0];
    if (!row || row.kind !== 'human' || row.status !== 'active' || row.owner_id !== target.humanId) {
      throw fail('INVALID_TARGET', 'target endpoint must be an active human endpoint owned by the target human');
    }
  }
  const inviteId = `inv_${crypto.randomBytes(12).toString('hex')}`;
  const token = crypto.randomBytes(24).toString('base64url'); // 192 bits
  const expires = new Date(now.getTime() + ttlMs);
  await client.query(
    `INSERT INTO room_invites (invite_id, token_hash, name, created_by_human_id, target_human_id, target_endpoint_id, target_issuer, target_subject, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [inviteId, hashInviteToken(token), name, createdByHumanId, target?.humanId ?? null, target?.endpointId ?? null, target?.issuer ?? null, target?.subject ?? null, now.toISOString(), expires.toISOString()]);
  for (const { roomId, role } of rooms) {
    await client.query(`INSERT INTO room_invite_rooms (invite_id, room_id, role) VALUES ($1,$2,$3)`, [inviteId, roomId, role]);
  }
  await client.query(
    `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, object_type, object_id, outcome, created_at)
     VALUES ($1,'invite.created',$2,$2,'room_invite',$3,'success',$4)`,
    [`audit_${crypto.randomUUID()}`, createdByHumanId, inviteId, now.toISOString()]);
  return { invite_id: inviteId, token };
}

export async function listInvites(client, { now = new Date() } = {}) {
  const { rows } = await client.query(
    `SELECT i.invite_id, i.name, i.expires_at, i.consumed_at, i.consumed_by_human_id, i.revoked_at,
            COALESCE(json_agg(json_build_object('room_id', r.room_id, 'role', r.role)) FILTER (WHERE r.room_id IS NOT NULL), '[]') AS rooms
       FROM room_invites i LEFT JOIN room_invite_rooms r ON r.invite_id = i.invite_id
      GROUP BY i.invite_id ORDER BY i.created_at DESC`);
  return rows.map((row) => ({
    invite_id: row.invite_id, name: row.name, rooms: row.rooms, expires_at: row.expires_at, consumed_by_human_id: row.consumed_by_human_id,
    state: row.consumed_at ? 'consumed' : row.revoked_at ? 'revoked' : new Date(row.expires_at) <= now ? 'expired' : 'open',
  }));
}

export async function revokeInvite(client, { inviteId, actorHumanId, now = new Date() }) {
  const { rowCount } = await client.query(
    `UPDATE room_invites SET revoked_at = $2 WHERE invite_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`, [inviteId, now.toISOString()]);
  if (!rowCount) return { revoked: false };
  await client.query(
    `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, object_type, object_id, outcome, created_at)
     VALUES ($1,'invite.revoked',$2,$2,'room_invite',$3,'success',$4)`,
    [`audit_${crypto.randomUUID()}`, actorHumanId, inviteId, now.toISOString()]);
  return { revoked: true };
}
```

If the `audit_events` columns differ from the `provision-human.mjs` insert (they do not; it is the same shape), copy that insert exactly.

- [ ] **Step 4:** Run the Step 2 command, then `timeout 60 node --test sigil/relay/v1/identity-auth-routes.test.mjs sigil/relay/v1/identity-auth-repository.integration.test.mjs`. Expected: all PASS (step-up behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/oauth/invites.mjs sigil/relay/v1/oauth/invites.pg.test.mjs sigil/relay/v1/oauth/session-columns.pg.test.mjs
git commit -m "feat(sigil): invite repository and client-aware identity/session inserts"
```

---

### Task 6: Login transaction (callback decision)

**Files:**
- Create: `sigil/relay/v1/oauth/login-tx.mjs`
- Test: `sigil/relay/v1/oauth/login-tx.pg.test.mjs`

**Interfaces:**
- Consumes: `provisionHumanTx`, `addHumanToRoomsTx`, `lockManagerRows` (`provision-human.mjs`); `repository.createOidcIdentity`/`createHumanSession` (Task 5, `client` form); `hashInviteToken` (Task 5).
- Produces: `completeLogin({ repository, identity: { issuer, subject, displayName }, inviteToken, flowId, sessionId /* sha256(cookie) */, wrapKey, authenticationMethod = 'oauth_github', now }): Promise<{ outcome: 'login' | 'denied' | 'invite_required' | 'invite_expired', human_id?, endpoint_id?, audit: { type, subjectId } }>`.
  The caller (Task 9) writes nothing to the audit table itself for these outcomes; `completeLogin` writes `oauth_login.success`, `invite.redeemed`, `oauth_login.denied`, `oidc_identity.reactivated` inside the transaction where the outcome commits, and writes `oauth_login.denied` after rollback for denials (separate small transaction) using the audit subject rules in spec §Errors and abuse handling.
- Constants: `SESSION_ABSOLUTE_MS = 7 * 24 * 3600_000`.

Decision order (spec §Callback decision): (1) verified row lookup; (2) usable invite → link; (3) `invite_required`.

- [ ] **Step 1: Write failing tests** (pg; one `it` per bullet, each against a real disposable DB)

Fixture helpers in the test file: `makeOperator()` (provision a human with `provisionHumanTx` and `kind='human'` endpoint), `makeRoom(operator)`, `makeInviteFor(operator, opts)` (call `createInvite` from Task 5, return `token`), `identity(n) = { issuer: 'https://github.com', subject: String(n), displayName: 'G' + n }`.

Required cases (assert on DB rows, not just return values):
  1. **First contact**: open invite with two rooms (`member`, `room_manager`), unknown identity → `outcome: 'login'`; afterwards exactly one new human, one endpoint, one key, one `oidc_identities` row with `verified_via='oauth'` and the new `endpoint_id`, one `human_sessions` row with `session_id = sessionId`, `authentication_method='oauth_github'`, `last_seen_at` set, and invite `consumed_at`/`consumed_by_human_id` both set. Attribute rows are `unverified`.
  2. **Atomicity**: make `addHumanToRoomsTx` fail by revoking the creator's manager role on one room first → `invite_expired`; no new human/endpoint/key/identity/session rows; invite unconsumed.
  3. **Returning**: after case 1, a second `completeLogin` with a fresh `sessionId` and **no** invite → `login`, same `endpoint_id`, invite untouched. With an unrelated open *non-targeted* invite on the flow it is ignored and not consumed.
  4. **No invite / bad invite**: unknown identity, no token → `invite_required`; expired, revoked, consumed, and unknown-token cases → `invite_expired`.
  5. **Concurrent redemption**: two `completeLogin` calls with the same token and different identities via `Promise.all` → exactly one `login`, the other `invite_expired`; one human created.
  6. **Overlapping rooms, opposite order**: two invites with rooms `[A,B]` and `[B,A]` redeemed concurrently both succeed (no deadlock, `timeout 30` guard via `t.signal`/test timeout).
  7. **Targeted `--self`**: invite pinned to `(github, 7)` for the operator's own human/endpoint. Identity `(github, 8)` → `denied`, invite unconsumed, no identity row. Identity `(github, 7)` → `login` as the operator's endpoint, **no second human**, invite consumed with `consumed_by_human_id = operator`.
  8. **Targeted for existing human** (`human add` human with rooms): redemption links to that endpoint, adds listed rooms via `addHumanToRoomsTx`, creates no human.
  9. **Cross-target denial**: a verified row for human H and a flow carrying a targeted invite whose `target_human_id` ≠ H → `denied`, invite unconsumed.
  10. **Revoked identity**: row `status='revoked'` and no invite → `denied`. With a pinned targeted invite for the same `(issuer, subject)` and same human → `login`, row back to `active`, `oidc_identity.reactivated` audited, earlier revoked sessions stay revoked. With a mismatched pin or a suspended human → `denied`.
  11. **Suspended human / endpoint** with a verified row → `denied`, never falls through to linking even when an invite is supplied.
  12. **Suspension race**: start a returning login holding its row locks (use a second client that `UPDATE humans SET status='suspended'` inside a `Promise.race` with a short delay); assert the final state is either `denied`, or `login` followed by the suspension sweep revoking the session — never a live session for a suspended human. (Use `human-suspension.pg.test.mjs` for the suspend call.)
  13. **Planted unverified row**: a row with `verified_via IS NULL` for the identity is ignored by step 1 (invite still links; if the PK collides, `completeLogin` returns `denied` rather than throwing). Document the collision result in the test name.
  14. **Audit**: `oauth_login.denied` for a known human uses the human id; for an unknown identity uses `flow:<flowId>`; no audit row contains the subject or a hash of it.

- [ ] **Step 2:** Run `timeout 60 node --test sigil/relay/v1/oauth/login-tx.pg.test.mjs`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```js
import crypto from 'node:crypto';
import { provisionHumanTx, addHumanToRoomsTx, lockManagerRows } from '../provision-human.mjs';
import { hashInviteToken } from './invites.mjs';

export const SESSION_ABSOLUTE_MS = 7 * 24 * 3600_000;
const MANAGER = new Set(['owner', 'room_manager']);

const audit = (client, { type, subjectId, actorHumanId = null, objectType = null, objectId = null, outcome = 'success', now }) =>
  client.query(
    `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, object_type, object_id, outcome, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [`audit_${crypto.randomUUID()}`, type, subjectId, actorHumanId, objectType, objectId, outcome, now.toISOString()]);

class Abort extends Error { constructor(outcome, humanId = null) { super(outcome); this.outcome = outcome; this.humanId = humanId; } }

async function lockInvite(client, tokenHash, now) {
  const { rows } = await client.query(
    `SELECT * FROM room_invites WHERE token_hash = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > $2 FOR UPDATE`,
    [tokenHash, now.toISOString()]);
  if (!rows[0]) throw new Abort('invite_expired');
  const { rows: rooms } = await client.query(`SELECT room_id, role FROM room_invite_rooms WHERE invite_id = $1 ORDER BY room_id`, [rows[0].invite_id]);
  return { invite: rows[0], rooms: rooms.map((r) => ({ roomId: r.room_id, role: r.role })) };
}

async function recheckCreator(client, invite, rooms) {
  if (!rooms.length) return;
  const roomIds = rooms.map((r) => r.roomId);
  const locked = await lockManagerRows(client, invite.created_by_human_id, roomIds);
  const managed = new Set(locked.filter((r) => r.owner_id === invite.created_by_human_id && r.removed_at === null && MANAGER.has(r.role)).map((r) => r.conversation_id));
  if (roomIds.some((id) => !managed.has(id))) throw new Abort('invite_expired');
}

// Takes human then endpoint FOR SHARE (suspension updates humans first), requires both active.
async function lockActiveHumanEndpoint(client, humanId, endpointId) {
  const h = await client.query(`SELECT status FROM humans WHERE human_id = $1 FOR SHARE`, [humanId]);
  const e = await client.query(`SELECT status, kind, owner_id FROM endpoints WHERE endpoint_id = $1 FOR SHARE`, [endpointId]);
  return h.rows[0]?.status === 'active' && e.rows[0]?.status === 'active' && e.rows[0]?.kind === 'human' && e.rows[0]?.owner_id === humanId;
}

function pinMatches(invite, identity) {
  return invite.target_issuer === identity.issuer && invite.target_subject === identity.subject;
}

async function newSession(repository, client, { sessionId, humanId, endpointId, identity, authenticationMethod, now }) {
  return repository.createHumanSession({
    sessionId, humanId, authenticationMethod, assurance: 'standard', issuedAt: now,
    expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS), now, client,
    endpointId, lastSeenAt: now, identityIssuer: identity.issuer, identitySubject: identity.subject,
  });
}

export async function completeLogin({ repository, identity, inviteToken = null, flowId, sessionId, wrapKey, authenticationMethod = 'oauth_github', now = new Date() }) {
  const tokenHash = inviteToken ? hashInviteToken(inviteToken) : null;
  try {
    return await repository.withTransaction(async (client) => {
      const { rows: [row] } = await client.query(
        `SELECT * FROM oidc_identities WHERE issuer = $1 AND subject = $2 AND verified_via = 'oauth' FOR UPDATE`,
        [identity.issuer, identity.subject]);
      if (row) return existing(client, row);
      if (!tokenHash) throw new Abort('invite_required');
      return link(client);
    });
  } catch (error) {
    if (!(error instanceof Abort)) throw error;
    if (error.outcome === 'denied') {
      // Rolled back above; the denial is recorded on its own.
      await repository.withTransaction((c) => audit(c, {
        type: 'oauth_login.denied', subjectId: error.humanId ?? `flow:${flowId}`, actorHumanId: error.humanId, outcome: 'denied', now }));
    }
    return { outcome: error.outcome, audit: null };
  }

  async function existing(client, row) {
    // A targeted invite aimed at a different human is denied whatever the row's state.
    let locked = null;
    if (tokenHash) {
      const { rows: [inv] } = await client.query(`SELECT * FROM room_invites WHERE token_hash = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > $2`, [tokenHash, now.toISOString()]);
      if (inv?.target_human_id && inv.target_human_id !== row.human_id) throw new Abort('denied', row.human_id);
      if (inv?.target_human_id) locked = inv;
    }
    const active = await lockActiveHumanEndpoint(client, row.human_id, row.endpoint_id);
    if (!active) throw new Abort('denied', row.human_id);
    if (row.status === 'active') {
      await newSession(repository, client, { sessionId, humanId: row.human_id, endpointId: row.endpoint_id, identity, authenticationMethod, now });
      await audit(client, { type: 'oauth_login.success', subjectId: row.human_id, actorHumanId: row.human_id, now });
      return { outcome: 'login', human_id: row.human_id, endpoint_id: row.endpoint_id };
    }
    if (row.status === 'revoked' && locked && pinMatches(locked, identity)) {
      const { invite, rooms } = await lockInvite(client, tokenHash, now);
      if (!(invite.target_human_id === row.human_id && pinMatches(invite, identity))) throw new Abort('denied', row.human_id);
      await recheckCreator(client, invite, rooms);
      await client.query(`UPDATE oidc_identities SET status = 'active' WHERE issuer = $1 AND subject = $2`, [identity.issuer, identity.subject]);
      await newSession(repository, client, { sessionId, humanId: row.human_id, endpointId: row.endpoint_id, identity, authenticationMethod, now });
      await consume(client, invite, row.human_id);
      await audit(client, { type: 'oidc_identity.reactivated', subjectId: `${identity.issuer}|${identity.subject}`, actorHumanId: row.human_id, now });
      return { outcome: 'login', human_id: row.human_id, endpoint_id: row.endpoint_id };
    }
    throw new Abort('denied', row.human_id);
  }

  async function link(client) {
    const { invite, rooms } = await lockInvite(client, tokenHash, now);
    await recheckCreator(client, invite, rooms);
    let humanId; let endpointId;
    if (invite.target_human_id) {
      if (!pinMatches(invite, identity)) throw new Abort('denied');
      if (!(await lockActiveHumanEndpoint(client, invite.target_human_id, invite.target_endpoint_id))) throw new Abort('denied');
      humanId = invite.target_human_id; endpointId = invite.target_endpoint_id;
      if (rooms.length) await addHumanToRoomsTx(client, { endpointId, memberships: rooms, actorHumanId: invite.created_by_human_id, repository, now });
    } else {
      const attributes = [{ kind: 'name', value: invite.name, source: 'operator' }];
      if (identity.displayName) attributes.push({ kind: 'name', value: identity.displayName, source: identity.issuer === 'https://github.com' ? 'github' : 'provider' });
      const provisioned = await provisionHumanTx(client, { displayName: invite.name, attributes, wrapKey, now });
      humanId = provisioned.human_id; endpointId = provisioned.endpoint_id;
      if (rooms.length) await addHumanToRoomsTx(client, { endpointId, memberships: rooms, actorHumanId: invite.created_by_human_id, repository, now });
    }
    try {
      await repository.createOidcIdentity({ issuer: identity.issuer, subject: identity.subject, humanId, now, client, verifiedVia: 'oauth', endpointId });
    } catch (error) {
      if (error.code === '23505') throw new Abort('denied'); // unverified row planted on the same pair
      throw error;
    }
    await newSession(repository, client, { sessionId, humanId, endpointId, identity, authenticationMethod, now });
    await consume(client, invite, humanId);
    await audit(client, { type: 'invite.redeemed', subjectId: humanId, actorHumanId: humanId, objectType: 'room_invite', objectId: invite.invite_id, now });
    await audit(client, { type: 'oauth_login.success', subjectId: humanId, actorHumanId: humanId, now });
    return { outcome: 'login', human_id: humanId, endpoint_id: endpointId };
  }

  async function consume(client, invite, humanId) {
    await client.query(`UPDATE room_invites SET consumed_at = $2, consumed_by_human_id = $3 WHERE invite_id = $1`, [invite.invite_id, now.toISOString(), humanId]);
  }
}
```

Notes the implementer must respect: `addHumanToRoomsTx` for a `ROUTE_NOT_AUTHORIZED` error must map to `invite_expired` (wrap it: `catch (e) { if (e.code === 'ROUTE_NOT_AUTHORIZED') throw new Abort('invite_expired'); throw e; }` around both calls) — this is what makes case 2 pass. A `denied` that carries no human id writes the audit row under `flow:<flowId>`. `audit_events.actor_human_id` has a foreign key to `humans`; for an unknown identity pass `null`.

- [ ] **Step 4:** Run the Step 2 command. Expected: PASS (all 14 cases). If case 12 flakes, make the suspension client start its `UPDATE` only after the login client has issued `SELECT ... FOR UPDATE` (use `pg_advisory_lock` or a `setImmediate` gate), not a fixed sleep.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/oauth/login-tx.mjs sigil/relay/v1/oauth/login-tx.pg.test.mjs
git commit -m "feat(sigil): oauth callback decision with link, returning login, and reactivation transactions"
```

---

### Task 7: Cookie authenticator and session liveness

**Files:**
- Create: `sigil/relay/v1/oauth/session-auth.mjs`
- Modify: `sigil/relay/v1/liveness.mjs`, `sigil/relay/v1/ticket-store.mjs`
- Test: `sigil/relay/v1/oauth/session-auth.pg.test.mjs`, extend `sigil/relay/v1/liveness.test.mjs`, extend `sigil/relay/v1/ticket-store.test.mjs`

**Interfaces:**
- Produces (`session-auth.mjs`):
  - `SESSION_IDLE_MS = 8 * 3600_000`, `TOUCH_AFTER_MS = 5 * 60_000`
  - `createCookieAuthenticator({ repository, now = () => new Date() }): (request) => Promise<principal | null>` where `principal = { endpoint_id, owner_id, human_id, session_id, display_name }`. Reads only `Cookie`, never `Authorization`.
  - `loadSessionRow(repository, sessionId, client?) -> { session_id, endpoint_id, human_id, expires_at, revoked_at, last_seen_at, identity_status, endpoint_kind, endpoint_status, human_status, display_name } | null` — one join over `human_sessions`, `endpoints`, `humans`, `oidc_identities` (on the identity pair). Rows with `endpoint_id IS NULL` return null.
- `liveness.mjs`: `isSocketLive(snapshot, session, now)` additionally requires `session.identity_status === 'active'` and `now - Date.parse(session.last_seen_at) < SESSION_IDLE_MS` when `session` is given. Keep the existing `revoked_at` and `expires_at` checks.
- `ticket-store.mjs`: `issue({ endpoint_id, owner_id, human_id, session_id = null })`; `redeem` returns `session_id` too; new `revokeSession(session_id)` deletes unredeemed tickets carrying it. The existing per-endpoint cap logic is unchanged.

- [ ] **Step 1: Write failing tests**

`session-auth.pg.test.mjs` (fixture: operator via Task 6 helpers, a completed login for a session cookie):
  1. Valid cookie → principal with the endpoint, owner, human, session ids and `display_name`.
  2. No cookie, unknown cookie, `Authorization: Bearer <valid agent token>` only → `null`.
  3. A step-up session row (null `endpoint_id`) → `null` even with a valid hash.
  4. Revoked session, expired session, `last_seen_at` older than 8 h, revoked identity, suspended human, suspended endpoint, non-`human` endpoint kind → each `null`.
  5. `last_seen_at` is rewritten only when the stored value is more than 5 minutes old (assert unchanged after a request 1 minute later, updated after 6 minutes; inject `now`).

`liveness.test.mjs`: with a `session` argument, `identity_status: 'revoked'` fails; `last_seen_at` 9 h old fails; 1 h old passes; no `session` argument behaves as before.

`ticket-store.test.mjs`: `issue` with `session_id` round-trips through `redeem`; `revokeSession(id)` makes an unredeemed ticket unredeemable and leaves other sessions' tickets.

- [ ] **Step 2:** Run `timeout 60 node --test sigil/relay/v1/oauth/session-auth.pg.test.mjs sigil/relay/v1/liveness.test.mjs sigil/relay/v1/ticket-store.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// session-auth.mjs
import { parseCookies, hashCookie, SESSION_COOKIE } from './cookies.mjs';

export const SESSION_IDLE_MS = 8 * 3600_000;
export const TOUCH_AFTER_MS = 5 * 60_000;

export async function loadSessionRow(repository, sessionId, client = repository.pool) {
  const { rows } = await client.query(
    `SELECT s.session_id, s.endpoint_id, s.human_id, s.expires_at, s.revoked_at, s.last_seen_at,
            i.status AS identity_status, e.kind AS endpoint_kind, e.status AS endpoint_status,
            e.display_name, h.status AS human_status
       FROM human_sessions s
       JOIN endpoints e ON e.endpoint_id = s.endpoint_id
       JOIN humans h ON h.human_id = s.human_id
       JOIN oidc_identities i ON i.issuer = s.identity_issuer AND i.subject = s.identity_subject
      WHERE s.session_id = $1 AND s.endpoint_id IS NOT NULL`, [sessionId]);
  return rows[0] ?? null;
}

export function sessionIsUsable(row, nowMs) {
  return Boolean(row)
    && !row.revoked_at
    && Date.parse(row.expires_at) > nowMs
    && nowMs - Date.parse(row.last_seen_at) < SESSION_IDLE_MS
    && row.identity_status === 'active'
    && row.endpoint_kind === 'human' && row.endpoint_status === 'active' && row.human_status === 'active';
}

export function createCookieAuthenticator({ repository, now = () => new Date() }) {
  return async function authenticate(request) {
    const value = parseCookies(request.headers?.cookie)[SESSION_COOKIE];
    if (!value) return null;
    const sessionId = hashCookie(value);
    const row = await loadSessionRow(repository, sessionId);
    const at = now();
    if (!sessionIsUsable(row, at.getTime())) return null;
    if (at.getTime() - Date.parse(row.last_seen_at) > TOUCH_AFTER_MS) {
      await repository.pool.query(`UPDATE human_sessions SET last_seen_at = $2 WHERE session_id = $1 AND revoked_at IS NULL`, [sessionId, at.toISOString()]);
    }
    return { endpoint_id: row.endpoint_id, owner_id: row.human_id, human_id: row.human_id, session_id: sessionId, display_name: row.display_name };
  };
}
```

`liveness.mjs`: add after the existing `expires_at` check inside `if (session) { ... }`:

```js
    if (session.identity_status !== undefined && session.identity_status !== 'active') return false;
    if (session.last_seen_at && now - Date.parse(session.last_seen_at) >= 8 * 3600_000) return false;
```

`ticket-store.mjs`: store `session_id` on the entry (`entries.set(digest(ticket), { endpoint_id, owner_id, human_id, session_id, expiresAt })`), return it from `redeem`, and add:

```js
    revokeSession(sessionId) {
      if (!sessionId) return 0;
      let n = 0;
      for (const [key, entry] of entries) if (entry.session_id === sessionId) { entries.delete(key); n += 1; }
      return n;
    },
```

Read the current `issue`/`redeem` bodies before editing (`sigil/relay/v1/ticket-store.mjs`, 37 lines) and keep the cap logic byte-for-byte.

- [ ] **Step 4:** Run the Step 2 command plus `timeout 60 node --test sigil/relay/v1/http-server.rooms-stream.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/oauth/session-auth.mjs sigil/relay/v1/oauth/session-auth.pg.test.mjs sigil/relay/v1/liveness.mjs sigil/relay/v1/liveness.test.mjs sigil/relay/v1/ticket-store.mjs sigil/relay/v1/ticket-store.test.mjs
git commit -m "feat(sigil): cookie authenticator, session-aware liveness, session tickets"
```

---

### Task 8: Stream server, sessions follow the socket

**Files:**
- Modify: `sigil/relay/v1/stream-server.mjs`
- Test: `sigil/relay/v1/stream-server.session.test.mjs`

**Interfaces:**
- `createStreamServer({ ..., publicServer = null, publicOrigin = null })`. When `publicServer` is given, a second `WebSocketServer({ server: publicServer, path: '/v1/stream' })` attaches to the **same** socket indexes with a ticket-only handler: requires `Origin === publicOrigin`, requires a valid `ticket`, otherwise `socket.close(1008, 'unauthorized')`. It never calls `authenticateRequest`.
- Socket info becomes `{ endpointId, ownerId, sessionId }`; `sessionId` is `null` for bearer sockets and ticket sockets from token mode.
- New methods: `closeSession(sessionId, code = 1008)` closes every open socket tagged with it; `revalidate({ humanId })` additionally loads each cookie socket's session row (`repository.sessionLiveness(sessionId)`, added to `postgres-repository.mjs` as a thin wrapper over `loadSessionRow`) and closes sockets whose session fails `isSocketLive(snapshot, session)`.
- Liveness at upgrade and in `recheck` passes the session: `isSocketLive(snapshot, session)`.

- [ ] **Step 1: Write failing tests**

Use two real `http.createServer()` instances plus `ws` clients, as `http-server.rooms-stream.test.mjs` does. Cases:
  1. Public listener upgrade with a valid ticket and `Origin: <publicOrigin>` connects; `notifyRoom(endpointId, ...)` reaches it (shared indexes).
  2. Public upgrade with no ticket, bearer `Authorization`, `sigil-bearer.` subprotocol, with and without `Origin`: closes 1008 each time. The same bearer upgrade still works on the loopback server.
  3. Public upgrade with a ticket but `Origin` missing or wrong: 1008.
  4. A ticket carrying `session_id` tags the socket; `closeSession(id)` closes it and leaves another session's socket open.
  5. With a stub repository whose `sessionLiveness` returns a revoked session, `revalidate({ humanId })` closes the socket; an idle-expired `last_seen_at` closes it in the periodic pass (drive `livenessIntervalMs: 20`).
  6. Token-mode browser sockets (ticket with `session_id: null`) are unaffected by session checks.

- [ ] **Step 2:** Run `timeout 60 node --test sigil/relay/v1/stream-server.session.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement**

Refactor `handleConnection(socket, request)` into `handleConnection(socket, request, { ticketOnly })`. In the `ticketOnly` branch:

```js
    if (ticketOnly) {
      // Redeem first so a ticket is spent even when the origin check fails.
      const spent = ticketParam !== null ? (ticketStore?.redeem(ticketParam) ?? null) : null;
      if (publicOrigin === null || request.headers.origin !== publicOrigin || !spent) return socket.close(1008, 'unauthorized');
      principal = spent;
    }
```

Register the second server:

```js
  const publicWss = publicServer ? new WebSocketServer({ server: publicServer, path: '/v1/stream' }) : null;
  publicWss?.on('connection', (socket, request) => {
    handleConnection(socket, request, { ticketOnly: true }).catch(() => socket.close(1008, 'unauthorized'));
  });
```

`socketInfo.set(socket, { endpointId, ownerId, sessionId: principal?.session_id ?? null })`. Add `sessionSockets` (`Map<sessionId, Set<socket>>`) populated in `register` when `sessionId` is non-null and cleaned on close. For session liveness:

```js
  const liveSession = async (sessionId) => {
    if (!sessionId || typeof repository?.sessionLiveness !== 'function') return null; // null = nothing to check
    try { return (await repository.sessionLiveness(sessionId)) ?? false; } catch { return false; }
  };
```

`false` (read failed or row gone) fails the socket closed; `null` skips the session check. In `recheck`, evaluate `isSocketLive(snapshot, session)` per socket using `liveSession(info.sessionId)`. `close()` also closes `publicWss`. Add to `postgres-repository.mjs`:

```js
  async sessionLiveness(sessionId, client = this.pool) {
    const { loadSessionRow } = await import('./oauth/session-auth.mjs');
    return loadSessionRow(this, sessionId, client);
  }
```

(Use a static top-level import if it creates no cycle: `session-auth.mjs` only imports `cookies.mjs`, so a static import is fine.)

- [ ] **Step 4:** Run the Step 2 command and `timeout 60 node --test sigil/relay/v1/http-server.rooms-stream.test.mjs sigil/relay/v1/liveness.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/stream-server.mjs sigil/relay/v1/stream-server.session.test.mjs sigil/relay/v1/postgres-repository.mjs
git commit -m "feat(sigil): ticket-only public stream endpoint and session-bound sockets"
```

---

### Task 9: CSRF gate and public listener allowlist

**Files:**
- Create: `sigil/relay/v1/oauth/csrf.mjs`, `sigil/relay/v1/oauth/public-listener.mjs`
- Test: `sigil/relay/v1/oauth/csrf.test.mjs`, `sigil/relay/v1/oauth/public-listener.test.mjs`

**Interfaces:**
- `csrf.mjs`:
  - `checkCookieCsrf(request, publicOrigin): boolean` — for non-GET/HEAD requests: `Origin === publicOrigin` and `X-Sigil-CSRF === '1'`; GET/HEAD always pass.
  - `checkStartOrigin(request, publicOrigin): boolean` — `Origin === publicOrigin` and `Sec-Fetch-Site` absent or `'same-origin'`.
- `public-listener.mjs`: `createPublicListener({ publicOrigin, authenticateCookie, handleOAuthPublicRoute, handleOAuthSessionRoute, handleRoomRoute, roomRouteContext, logger }) -> http.Server`. Dispatch:
  1. Parse `new URL(request.url, 'http://x')`. Reject (404) any raw URL containing `%2f`, `%2F`, `%5c`, `%5C`, or a backslash, and any path whose decoded segments include `..`, `.`, or an empty segment (other than the leading one) — match on exact segments, not a prefix.
  2. Allowlist table (method + exact segment pattern): `POST /v1/auth/oauth/:provider/start`, `GET /v1/auth/oauth/:provider/callback` → `handleOAuthPublicRoute` (no credential). `GET /v1/auth/me`, `POST /v1/auth/logout` → authenticate cookie (401 if none), CSRF check on POST (403), then `handleOAuthSessionRoute`. `/v1/rooms`, `/v1/rooms/*`, `GET /v1/mentions` → authenticate cookie (401), CSRF (403 for non-GET), then `handleRoomRoute({ principal, ... })`.
  3. Everything else, every method: `404 {"code":"NOT_FOUND"}` before any handler runs. `Authorization` is never read.

- [ ] **Step 1: Write failing tests**

`csrf.test.mjs`: table-driven. `checkCookieCsrf`: POST with right origin + header passes; missing header, wrong origin, missing origin fail; GET passes with neither. `checkStartOrigin`: foreign origin, missing origin, `Sec-Fetch-Site: cross-site` fail; `same-origin` and absent `Sec-Fetch-Site` pass.

`public-listener.test.mjs`: start the listener on port 0 with stub handlers that record calls. Assert, for each, that **no handler ran** and status is 404:
  `/approve`, `/v1/health`, `/v1/approval-challenges/x/assertion`, `/v1/agentmail/webhook/x`, `/v1/federation/envelopes`, `/v1/federation/directory/x`, `/v1/envelopes`, `/v1/endpoint-tokens`, `/v1/identities`, `/v1/capability-grants`, `/v1/auth/login`, `/v1/rooms/../federation/envelopes`, `/v1/rooms/%2e%2e/federation/envelopes`, `/v1/rooms%2Ffoo`, `/v1/auth/oauth/github/start` with GET, `/v1/auth/oauth/github/callback` with POST, and `DELETE /v1/rooms/r1`'s equivalent unsupported method if `handleRoomRoute` is method-agnostic (keep the methods `GET, POST` only for rooms, matching `browser-cors.mjs`).
  Plus: `Authorization: Bearer <anything>` on `/v1/rooms` → 401 and the authenticator stub was called with cookie-only semantics; cookie + POST without `X-Sigil-CSRF` → 403; start/callback reach their handler with no credential; `me`/`logout` with no cookie → 401.

- [ ] **Step 2:** Run `timeout 60 node --test sigil/relay/v1/oauth/csrf.test.mjs sigil/relay/v1/oauth/public-listener.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement**

```js
// csrf.mjs
const SAFE = new Set(['GET', 'HEAD']);
export function checkCookieCsrf(request, publicOrigin) {
  if (SAFE.has(request.method)) return true;
  return request.headers.origin === publicOrigin && request.headers['x-sigil-csrf'] === '1';
}
export function checkStartOrigin(request, publicOrigin) {
  if (request.headers.origin !== publicOrigin) return false;
  const site = request.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin';
}
```

```js
// public-listener.mjs
import http from 'node:http';
import { checkCookieCsrf } from './csrf.mjs';

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
const notFound = (response) => json(response, 404, { code: 'NOT_FOUND', message: 'Not found', details: {} });

// Returns the matched route name or null. Matches exact segments on the parsed path.
export function matchPublicRoute(method, rawUrl) {
  if (/%2f|%5c|\\/i.test(rawUrl.split('?')[0])) return null;
  let pathname;
  try { pathname = new URL(rawUrl, 'http://x').pathname; } catch { return null; }
  const segments = pathname.split('/').slice(1);
  if (segments.some((s, i) => s === '..' || s === '.' || (s === '' && i !== segments.length - 1))) return null;
  const [a, b, c, d, e] = segments;
  if (a !== 'v1') return null;
  if (b === 'auth' && c === 'oauth' && d && e === 'start' && segments.length === 5) return method === 'POST' ? 'oauth_public' : null;
  if (b === 'auth' && c === 'oauth' && d && e === 'callback' && segments.length === 5) return method === 'GET' ? 'oauth_public' : null;
  if (b === 'auth' && c === 'me' && segments.length === 3) return method === 'GET' ? 'oauth_session' : null;
  if (b === 'auth' && c === 'logout' && segments.length === 3) return method === 'POST' ? 'oauth_session' : null;
  if (b === 'rooms') return method === 'GET' || method === 'POST' ? 'rooms' : null;
  if (b === 'mentions' && segments.length === 2) return method === 'GET' ? 'rooms' : null;
  return null;
}

export function createPublicListener({ publicOrigin, authenticateCookie, handleOAuthPublicRoute, handleOAuthSessionRoute, handleRoomRoute, roomRouteContext = () => ({}), logger = null }) {
  return http.createServer(async (request, response) => {
    try {
      const route = matchPublicRoute(request.method, request.url);
      if (!route) return notFound(response);
      const parsedUrl = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
      if (route === 'oauth_public') {
        if (await handleOAuthPublicRoute({ request, response, parsedUrl })) return;
        return notFound(response);
      }
      const principal = await authenticateCookie(request);
      if (!principal) return json(response, 401, { code: 'UNAUTHENTICATED', message: 'Authentication required', details: {} });
      if (!checkCookieCsrf(request, publicOrigin)) return json(response, 403, { code: 'CSRF_REJECTED', message: 'Forbidden', details: {} });
      const handler = route === 'oauth_session' ? handleOAuthSessionRoute : handleRoomRoute;
      if (await handler({ request, response, parsedUrl, principal, ...roomRouteContext() })) return;
      return notFound(response);
    } catch (error) {
      logger?.error?.({ event: 'public_listener.failed', error: error?.message });
      if (!response.headersSent) json(response, 500, { code: 'INTERNAL', message: 'Internal error', details: {} });
      else response.end();
    }
  });
}
```

`handleRoomRoute` takes `{ request, response, parsedUrl, principal, repository, registry, requestId, now, readBody, stream, inboxDepthLimit, systemIdentity, logger, ticketStore, humanSigner, buildAcceptOptions }` (see `http-server.mjs:446`). `roomRouteContext()` supplies the non-request fields; add `requestId: crypto.randomUUID()` per request inside `createPublicListener` if `handleRoomRoute` reads it (check `room-routes.mjs` for `requestId`). `handleRoomRoute` returns truthy when it handled the request; a falsy return becomes 404.

- [ ] **Step 4:** Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/oauth/csrf.mjs sigil/relay/v1/oauth/csrf.test.mjs sigil/relay/v1/oauth/public-listener.mjs sigil/relay/v1/oauth/public-listener.test.mjs
git commit -m "feat(sigil): cookie-only public listener with in-code route allowlist and csrf checks"
```

---

### Task 10: OAuth routes (start, callback, me, logout)

**Files:**
- Create: `sigil/relay/v1/oauth/oauth-routes.mjs`
- Test: `sigil/relay/v1/oauth/oauth-routes.test.mjs` (stub repository, fake provider), `sigil/relay/v1/oauth/oauth-routes.pg.test.mjs` (real DB, fake GitHub)

**Interfaces:**
- Produces `createOAuthRoutes({ repository, providers /* name -> provider */, flowStore, ticketStore, stream /* closeSession */, publicOrigin, wrapKey, operatorHumanId /* owner of --room-human-identity */, now, readBody, logger }) -> { handleOAuthPublicRoute, handleOAuthSessionRoute }`.
- `redirectUri = ${publicOrigin}/v1/auth/oauth/${provider}/callback`.
- `start` (`POST /v1/auth/oauth/{provider}/start`, JSON `{ invite? }` or form-encoded `invite=`): 404 unknown provider; 403 unless `checkStartOrigin`; 501 without `repository.withTransaction`; with an invite token validates via a plain read of `room_invites` (unknown/expired/revoked/consumed → `302 /login?error=invite_expired`, provider not contacted); rate limits (below); `flowStore.start({ provider, inviteId: token })` — store the **token** (not the id) as `inviteToken` on the flow so the callback can pass it to `completeLogin`; sets `FLOW_COOKIE` (`maxAge 600`); `302` to `provider.authorizeUrl`.
- `callback`: requires `FLOW_COOKIE`; `flowStore.take` (single use) and exact `state` match, else `302 /login?error=denied` with **no** audit row; `?error=` → `/login?error=denied` (flow already consumed, flow cookie cleared); `exchangeCode` + `resolveIdentity` (a thrown `PROVIDER_ERROR` → `/login?error=provider_error`); per-identity limiter; new session secret via `newCookieSecret()`; `completeLogin`; on `login` set `SESSION_COOKIE` (`maxAge` 7 days), clear `FLOW_COOKIE`, **revoke any session the browser presented** (`UPDATE human_sessions SET revoked_at = now WHERE session_id = sha256(presented cookie) AND revoked_at IS NULL`), then `302 /`. Outcomes map: `denied → denied`, `invite_required → invite_required`, `invite_expired → invite_expired`. The redirect target is a constant; no parameter selects it.
- `me`: `{ human_id, endpoint_id, display_name, is_operator }`; `is_operator = principal.human_id === operatorHumanId`.
- `logout`: revokes the session row, `stream.closeSession(session_id)`, `ticketStore.revokeSession(session_id)`, writes `human_session.revoked`, responds 204 with `Set-Cookie: clearCookie(SESSION_COOKIE)`.
- Rate limits via `repository.reserveRateLimit(scopeKind, scopeId, windowStart, limit)` (60 s windows, `windowStart = new Date(Math.floor(nowMs/60000)*60000).toISOString()`): per `invite_id` (limit 10/min) on `start` and callback with an invite → scope `invite`; per `issuer|subject` (limit 10/min) after the provider verifies → scope `oauth_provider_subject`; global `start` ceiling (60/min) → scope `oauth_start`, scope id `global`; flows carrying a `--self` invite (a targeted invite with `target_human_id = operatorHumanId`) skip the global ceiling. Exceeded → `429`.

- [ ] **Step 1: Write failing tests**

`oauth-routes.test.mjs` (stub repo/provider/flow store; call handlers with `http` mock req/res built from `node:http` `IncomingMessage`/`ServerResponse` pairs, or run `createPublicListener` on port 0 and use `fetch` with `redirect: 'manual'` — prefer the latter, it exercises the real wire):
  1. `start` with foreign `Origin`, no `Origin`, and `Sec-Fetch-Site: cross-site` → 403 and no `Set-Cookie`.
  2. `start` unknown provider → 404; no database → 501.
  3. `start` with a bad invite → `302 /login?error=invite_expired`, provider `authorizeUrl` never called.
  4. `start` OK → 302 to the provider URL containing `code_challenge_method=S256`, `Set-Cookie: __Host-sigil_oauth=...; ... Max-Age=600`.
  5. `callback`: no flow cookie → `/login?error=denied`, and the audit stub was **not** called; wrong `state`; replayed flow cookie; `?error=access_denied`; provider throws `PROVIDER_ERROR` → `provider_error`.
  6. `callback` success: sets `__Host-sigil_session`, clears the flow cookie, 302 to `/`; presented old session cookie is revoked.
  7. `me` shape and `is_operator` true/false; `logout` clears the cookie with all attributes and calls `closeSession` and `revokeSession`.
  8. Global ceiling exhausted → `429` for a normal flow, but a `--self`-targeted flow still starts.

`oauth-routes.pg.test.mjs`: full flow against the real DB with a fake GitHub (Task 4's helper): operator `invite create --self`-equivalent (call `createInvite` with a target) → `start` with the token → follow the provider redirect by calling `callback` with the state and a code the fake accepts → `me` with the issued cookie shows the operator and `is_operator: true`. Then an invited guest flow shows `is_operator: false`. Rate-limit rows land with the three new `scope_kind` values without a CHECK violation, and the flow-store cap holds (`FLOW_CAP` → 503).

- [ ] **Step 2:** Run `timeout 60 node --test sigil/relay/v1/oauth/oauth-routes.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** `oauth-routes.mjs` following the contract above. Skeleton with the non-obvious parts written out:

```js
import { newCookieSecret, hashCookie, parseCookies, setCookie, clearCookie, SESSION_COOKIE, FLOW_COOKIE } from './cookies.mjs';
import { checkStartOrigin } from './csrf.mjs';
import { completeLogin, SESSION_ABSOLUTE_MS } from './login-tx.mjs';
import { hashInviteToken } from './invites.mjs';

const LIMITS = { invite: 10, oauth_provider_subject: 10, oauth_start: 60 };
const redirect = (response, location, headers = {}) => { response.writeHead(302, { location, ...headers }); response.end(); };
const loginError = (response, code, headers) => redirect(response, `/login?error=${code}`, headers);

export function createOAuthRoutes({ repository, providers, flowStore, ticketStore, stream, publicOrigin, wrapKey, operatorHumanId, now = () => new Date(), readBody, logger = null }) {
  const redirectUri = (name) => `${publicOrigin}/v1/auth/oauth/${name}/callback`;
  const quota = async (scopeKind, scopeId) => {
    const ms = now().getTime();
    const windowStart = new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
    const result = await repository.reserveRateLimit(scopeKind, scopeId, windowStart, LIMITS[scopeKind]);
    return result?.allowed !== false;
  };
  const readInviteToken = async (request) => {
    const raw = await readBody(request, 4096);
    const type = request.headers['content-type'] ?? '';
    if (type.includes('application/json')) { try { return JSON.parse(raw)?.invite ?? null; } catch { return null; } }
    return new URLSearchParams(raw).get('invite');
  };
  const peekInvite = async (token) => {
    const { rows } = await repository.pool.query(
      `SELECT invite_id, target_human_id FROM room_invites WHERE token_hash = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > $2`,
      [hashInviteToken(token), now().toISOString()]);
    return rows[0] ?? null;
  };

  async function start(request, response, providerName) {
    const provider = providers[providerName];
    if (!provider) return notFound(response);
    if (!repository?.withTransaction) return json(response, 501, { code: 'NOT_IMPLEMENTED' });
    if (!checkStartOrigin(request, publicOrigin)) return json(response, 403, { code: 'CSRF_REJECTED' });
    const token = await readInviteToken(request);
    let invite = null;
    if (token) {
      invite = await peekInvite(token);
      if (!invite) return loginError(response, 'invite_expired');
      if (!(await quota('invite', invite.invite_id))) return json(response, 429, { code: 'RATE_LIMITED' });
    }
    const isSelf = invite?.target_human_id && invite.target_human_id === operatorHumanId;
    if (!isSelf && !(await quota('oauth_start', 'global'))) return json(response, 429, { code: 'RATE_LIMITED' });
    let started;
    try { started = flowStore.start({ provider: providerName, inviteId: token }); }
    catch (error) { if (error.code === 'FLOW_CAP') return json(response, 503, { code: 'BUSY' }); throw error; }
    const { cookieValue, flow } = started;
    return redirect(response, provider.authorizeUrl({ state: flow.state, nonce: flow.nonce, codeChallenge: flow.codeChallenge, redirectUri: redirectUri(providerName) }),
      { 'set-cookie': setCookie(FLOW_COOKIE, cookieValue, { maxAge: 600 }) });
  }

  async function callback(request, response, providerName, parsedUrl) {
    const flowCookie = parseCookies(request.headers.cookie)[FLOW_COOKIE];
    const flow = flowStore.take(flowCookie);
    const clearFlow = { 'set-cookie': clearCookie(FLOW_COOKIE) };
    // No valid flow: unattributable, so no audit row.
    if (!flow || flow.provider !== providerName || parsedUrl.searchParams.get('state') !== flow.state) return loginError(response, 'denied', clearFlow);
    if (parsedUrl.searchParams.get('error')) return loginError(response, 'denied', clearFlow);
    const provider = providers[flow.provider];
    const inviteRow = flow.inviteId ? await peekInvite(flow.inviteId) : null;
    if (inviteRow && !(await quota('invite', inviteRow.invite_id))) return json(response, 429, { code: 'RATE_LIMITED' });
    let identity;
    try {
      const { accessToken } = await provider.exchangeCode({ code: parsedUrl.searchParams.get('code') ?? '', codeVerifier: flow.pkceVerifier, redirectUri: redirectUri(flow.provider) });
      identity = await provider.resolveIdentity({ accessToken, expectedNonce: flow.nonce });
    } catch (error) {
      logger?.warn?.({ event: 'oauth.provider_failed', flow_id: flow.flow_id, code: error?.code });
      return loginError(response, 'provider_error', clearFlow);
    }
    if (!(await quota('oauth_provider_subject', `${identity.issuer}|${identity.subject}`))) return json(response, 429, { code: 'RATE_LIMITED' });
    const session = newCookieSecret();
    const result = await completeLogin({ repository, identity, inviteToken: flow.inviteId, flowId: flow.flow_id, sessionId: session.hash, wrapKey, authenticationMethod: `oauth_${flow.provider}`, now: now() });
    if (result.outcome !== 'login') return loginError(response, result.outcome, clearFlow);
    const presented = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (presented) await repository.pool.query(`UPDATE human_sessions SET revoked_at = $2 WHERE session_id = $1 AND revoked_at IS NULL`, [hashCookie(presented), now().toISOString()]);
    response.writeHead(302, { location: '/', 'set-cookie': [clearCookie(FLOW_COOKIE), setCookie(SESSION_COOKIE, session.value, { maxAge: SESSION_ABSOLUTE_MS / 1000 })] });
    return response.end();
  }

  return {
    async handleOAuthPublicRoute({ request, response, parsedUrl }) {
      const [, , , providerName, action] = parsedUrl.pathname.split('/');
      if (action === 'start') { await start(request, response, providerName); return true; }
      if (action === 'callback') { await callback(request, response, providerName, parsedUrl); return true; }
      return false;
    },
    async handleOAuthSessionRoute({ request, response, parsedUrl, principal }) {
      if (parsedUrl.pathname === '/v1/auth/me') {
        json(response, 200, { human_id: principal.human_id, endpoint_id: principal.endpoint_id, display_name: principal.display_name, is_operator: principal.human_id === operatorHumanId });
        return true;
      }
      if (parsedUrl.pathname === '/v1/auth/logout') {
        await repository.pool.query(`UPDATE human_sessions SET revoked_at = $2 WHERE session_id = $1 AND revoked_at IS NULL`, [principal.session_id, now().toISOString()]);
        stream?.closeSession(principal.session_id);
        ticketStore?.revokeSession(principal.session_id);
        await repository.recordAuditEvent?.({ eventType: 'human_session.revoked', subjectId: principal.session_id, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, outcome: 'success', now: now() });
        response.writeHead(204, { 'set-cookie': clearCookie(SESSION_COOKIE) });
        response.end();
        return true;
      }
      return false;
    },
  };
}
```

Define `json` and `notFound` locally (import from a shared tiny helper, or duplicate the three lines from `public-listener.mjs`; prefer exporting them from `public-listener.mjs` and importing here). The `me` handler's `display_name` comes from the authenticator's `endpoints.display_name`; the operator's endpoint `display_name` is set by the seed (verify with the pg test: open item 3).

- [ ] **Step 4:** Run `timeout 60 node --test sigil/relay/v1/oauth/oauth-routes.test.mjs sigil/relay/v1/oauth/oauth-routes.pg.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/oauth/oauth-routes.mjs sigil/relay/v1/oauth/oauth-routes.test.mjs sigil/relay/v1/oauth/oauth-routes.pg.test.mjs
git commit -m "feat(sigil): oauth start, callback, me, and logout routes with rate limits"
```

---

### Task 11: Wire `relay up`

**Files:**
- Create: `sigil/relay/v1/oauth/wiring.mjs`
- Modify: `sigil/cli/sigil.mjs` (flag parsing near `:192`/`:313-340`, help text), `sigil/relay/v1/relay-config.mjs` if it owns flag validation
- Test: `sigil/relay/v1/oauth/wiring.test.mjs`, `sigil/relay/v1/oauth/relay-up.pg.test.mjs`

**Interfaces:**
- `validateOAuthConfig({ publicOrigin, port, publicPort, roomKeyWrapKey, roomHumanIdentity, providers, oidcIssuerAllowlist })` throws `Error` with the offending flag named when: `publicOrigin` is not `https:`; `port` is 0/unset with `--public-origin`; `roomKeyWrapKey` or `roomHumanIdentity` missing; any provider issuer is in `oidcIssuerAllowlist`.
- `resolvePublicPort({ port, publicPort })` → `publicPort ?? (port ? port + 2 : 0)`.
- `buildOAuthStack({ repository, publicOrigin, wrapKey, operatorHumanId, ticketStore, stream, roomRouteContext, env, enableMockOAuth, logger }) -> { listener, providers, flowStore }` builds GitHub from `GITHUB_OAUTH_CLIENT_ID`/`GITHUB_OAUTH_CLIENT_SECRET` (error naming the missing variable), the cookie authenticator, the routes, and `createPublicListener`.
- In `cmdRelayUp`: when `--public-origin` is set, call `validateOAuthConfig`, build the stack, `listen` the public listener on `127.0.0.1:${resolvePublicPort(...)}`, pass `publicServer`/`publicOrigin` to `createStreamServer`, add `--public-origin` to the browser-origin allowlist (`allowedOrigins`), print the proxy table and the bound public port, and close the listener on shutdown. `--browser-origin` stays accepted for the Vite dev server. Without `--public-origin` nothing changes.
- Flags added to help text: `--public-origin`, `--public-port`, `--enable-mock-oauth` (test-only, guarded like `--enable-mock-oidc`).

- [ ] **Step 1: Write failing tests**

`wiring.test.mjs`: each `validateOAuthConfig` failure names its flag; `http:` origin rejected; `resolvePublicPort` cases (`{port:0}` → 0, `{port:4000}` → 4002, explicit wins); GitHub issuer in the allowlist → throws; missing env var named.

`relay-up.pg.test.mjs`: spawn `relay up` the way `sigil/cli/*.test.mjs` do for `--room-key-wrap-key` (copy that spawn helper) with `--public-origin https://rooms.test --port <free>` against the disposable DB; assert the output contains the proxy table and public port; a direct request to the public port for `/v1/health` and `/v1/envelopes` returns 404; the main port is unchanged (bearer-only).

- [ ] **Step 2:** Run `timeout 60 node --test sigil/relay/v1/oauth/wiring.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** `wiring.mjs` (pure functions above, no I/O besides constructing objects) and the minimal `sigil.mjs` edit: one `if (publicOrigin) { ... }` block after the stream server is created at `:336`, plus flag parsing lines beside the existing `opt(args, [...])` calls. Proxy table output:

```
Public origin: https://rooms.test
Cookie-only listener: 127.0.0.1:<publicPort>
Proxy table (dedicated hostname required):
  /v1/*        -> 127.0.0.1:<publicPort>   (includes the /v1/stream upgrade)
  everything else -> sigil-rooms-web --auth-mode cookie
Set-Cookie, Origin, and Host must pass through unchanged.
```

Operator human id: look it up from `--room-human-identity`'s endpoint via `repository.lookupTrustedEndpoint(endpointId).owner_id` (the foundation's definition of operator).

- [ ] **Step 4:** Run the Step 2 command and `timeout 60 node --test sigil/relay/v1/oauth/relay-up.pg.test.mjs sigil/cli/cli-wrappers.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/oauth/wiring.mjs sigil/relay/v1/oauth/wiring.test.mjs sigil/relay/v1/oauth/relay-up.pg.test.mjs sigil/cli/sigil.mjs
git commit -m "feat(sigil): wire public listener and oauth stack into relay up"
```

---

### Task 12: Operator CLI (invites, identity revoke, NOTIFY)

**Files:**
- Create: `sigil/cli/oauth-commands.mjs`
- Modify: `sigil/cli/sigil.mjs` (command dispatch beside `:1848`), `sigil/relay/v1/oauth/wiring.mjs` (NOTIFY listener)
- Test: `sigil/cli/oauth-commands.test.mjs`, `sigil/cli/oauth-commands.pg.test.mjs`

**Interfaces:**
- Commands (the CLI takes `--identity` itself, as `human-commands.mjs` does):
  - `sigil relay invite create --name <name> --room <id>:<role> [--room ...]` (24 h)
  - `sigil relay invite create --self --provider github --login <name>` (10 min, pinned)
  - `sigil relay invite create --human <human_id> --provider github --login <name> [--endpoint <id>] [--room <id>:<role> ...]` (24 h)
  - `sigil relay invite list`, `sigil relay invite revoke <invite_id>`
  - `sigil relay identity revoke --provider github (--login <name> | --subject <id>)`
- `resolveGitHubId(login, { fetchImpl, apiBase }) -> string` — `GET ${apiBase}/users/${login}` with `outboundFetchOptions()`; throws on non-200, non-integer `id`, or `login` mismatch (case-insensitive). Never prints a raw id as input.
- Output of `create`: the link `<public-origin>/invite#<token>`; `--public-origin` flag required on the command (or env `SIGIL_PUBLIC_ORIGIN`).
- `identity revoke`: one transaction: `UPDATE oidc_identities SET status='revoked' ... WHERE verified_via='oauth'` (error if no row), `UPDATE human_sessions SET revoked_at = now WHERE identity_issuer=$1 AND identity_subject=$2 AND revoked_at IS NULL AND expires_at > now()`, audit `oidc_identity.revoked` with subject `<issuer>|<subject>`, and `SELECT pg_notify('sigil_identity', $1)` with the fixed-size JSON `{"type":"identity.revoked","human_id":"..."}`.
- Relay side (`wiring.mjs`): the relay `LISTEN`s on the channel the foundation uses for NOTIFY (read `room-notify.mjs`/`admin-notify.mjs` for the channel name and reuse its connection; do not open a second listener channel if the foundation's payload dispatcher accepts a new `type`). On `identity.revoked` it calls `stream.revalidate({ humanId })`.

- [ ] **Step 1: Write failing tests**
  - Unit: `resolveGitHubId` with a fake API (200 with matching login → id string; 404; non-integer id; mismatched login; timeout) and argument parsing for all five commands (missing `--provider`, both `--login` and `--subject`, bad `--room` role, `--self` with `--room`).
  - pg: `--self` creates a 10-minute pinned invite for the operator's human/endpoint with `target_subject` from the fake API; `--human` for a `human add` human with two human endpoints requires `--endpoint`; `invite list` shows states; `invite revoke` on a consumed invite changes nothing; `identity revoke` revokes the identity and exactly its live sessions (500 sessions revoke without a NOTIFY payload error; assert the payload byte length is under 200), and a socket held open by the identity closes via `revalidate` (use a stub `stream` recording the call).
  - pg: after `identity revoke`, `completeLogin` for that identity with no invite is `denied`; with a fresh pinned `--self` invite it reactivates (ties to Task 6 case 10).

- [ ] **Step 2:** Run `timeout 60 node --test sigil/cli/oauth-commands.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** `oauth-commands.mjs` exporting `cmdInviteCreate`, `cmdInviteList`, `cmdInviteRevoke`, `cmdIdentityRevoke`, `resolveGitHubId`, reusing `createInvite`/`listInvites`/`revokeInvite` from Task 5 and the connection/identity helpers `human-commands.mjs` uses (read its top 40 lines and copy the repository bootstrap). Dispatch in `sigil.mjs` beside the `human` commands:

```js
    else if (command === 'invite' && sub === 'create') await cmdInviteCreate(rest);
    else if (command === 'invite' && sub === 'list') await cmdInviteList(rest);
    else if (command === 'invite' && sub === 'revoke') await cmdInviteRevoke(rest);
    else if (command === 'identity' && sub === 'revoke') await cmdIdentityRevoke(rest);
```

Match the real argument shape of the `relay` dispatch at `:1848` (the `human` commands show it) before editing; if the dispatcher keys on `command === 'human'`, mirror that exactly.

- [ ] **Step 4:** Run the Step 2 command and `timeout 60 node --test sigil/cli/oauth-commands.pg.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/cli/oauth-commands.mjs sigil/cli/oauth-commands.test.mjs sigil/cli/oauth-commands.pg.test.mjs sigil/cli/sigil.mjs sigil/relay/v1/oauth/wiring.mjs
git commit -m "feat(sigil): operator invite and identity-revoke commands with fixed-size NOTIFY"
```

---

### Task 13: Static server `--auth-mode`

**Files:**
- Modify: `packages/sigil-rooms-web/serve/server.mjs` (config at `:50-52`, CSP at `:28`, index handling at `:59-65`), `packages/sigil-rooms-web/serve/` CLI entry (`sigil-rooms-web.mjs:33`)
- Test: `packages/sigil-rooms-web/serve/server.test.mjs` (extend)

**Interfaces:**
- `--auth-mode cookie|token` (default `token`). `config.json` gains `authMode`. In `cookie` mode `relayUrl` and `streamUrl` are not required and are ignored; `--public-origin <https url>` is required and sets CSP `connect-src 'self' wss://<host>`. Every `index.html` response carries `Referrer-Policy: same-origin` (both modes).

- [ ] **Step 1: Write failing tests**
  1. `token` mode: unchanged `config.json` and CSP (existing tests keep passing).
  2. `cookie` mode: `config.json` is `{ "authMode": "cookie" }` plus nothing that requires relay URLs; CSP `connect-src` equals `'self' wss://rooms.test`; `--auth-mode cookie` without `--public-origin` exits non-zero naming the flag.
  3. `/login` and `/invite` (extensionless) return `index.html` with `Referrer-Policy: same-origin`; never `no-referrer`.
  4. POST is still rejected.

- [ ] **Step 2:** Run `timeout 60 node --test packages/sigil-rooms-web/serve/server.test.mjs`. Expected: new cases FAIL.

- [ ] **Step 3: Implement.** Read `server.mjs` fully first (about 80 lines). Add `authMode` and `publicOrigin` options to the server factory, branch the config payload and CSP builder on `authMode`, and add the header in the `index.html` response path. Parse the two flags in the entry script beside the existing `relayUrl`/`streamUrl` flags and fail fast on a bad combination.

- [ ] **Step 4:** Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sigil-rooms-web/serve
git commit -m "feat(sigil-rooms-web): cookie auth mode with same-origin referrer policy"
```

---

### Task 14: Web client cookie mode

**Files:**
- Modify: `packages/sigil-rooms-web/src/config.ts`, `src/api/client.ts:37-47`, `src/auth/AuthContext.tsx` (or the file exporting `AuthContext`), `src/App.tsx:82`, `src/live/useLive.ts:12`, `src/live/socket.ts:62` (stream URL derivation), `src/rooms/RoomList.tsx:41`, `src/rooms/RoomHeader.tsx:16,27`, `src/rooms/useSend.ts:73`, roster component hiding the invocation-mode control from non-owners
- Create: `src/pages/LoginPage.tsx`, `src/pages/InvitePage.tsx`
- Test: co-located `*.test.tsx` per the existing client test setup (find it with `ls packages/sigil-rooms-web/src/**/*.test.*`)

**Interfaces:**
- `config.ts`: `loadConfig` returns `{ authMode: 'token', relayUrl, streamUrl } | { authMode: 'cookie' }`; a missing `authMode` means `token`.
- `createClient`: in cookie mode needs no token, sends `credentials: 'same-origin'` on every request and `X-Sigil-CSRF: 1` on every non-GET, uses relative URLs, and on any 401 calls an injected `onUnauthorized()`; token mode is byte-for-byte unchanged.
- `AuthContext` exposes `{ mode, session: { human_id, endpoint_id, display_name, is_operator } | null, token | null, loading }`. All five "has token" checks read a single `isLoggedIn` derived from it.
- `LiveSocket` in cookie mode builds `wss://${location.host}` and appends `/v1/stream` itself as today; `useLive` connects only after `GET /v1/auth/me` succeeds.
- `/login` (button "Continue with GitHub" → `POST /v1/auth/oauth/github/start` via a real `<form method="post">`, so the browser follows the 302; shows `?error=` copy for `denied`, `invite_required`, `invite_expired`, `provider_error`, never revealing whether an identity is linked) and `/invite` (reads the token from `location.hash`, renders a form posting `invite=<token>` to `start`, then clears the fragment with `history.replaceState`). `App.tsx` switches on `location.pathname`.
- Create room hidden when `!is_operator`; roster invocation-mode control hidden from non-owners; header shows **Stop room** to the operator and **Stop my runs** to others (same `POST /v1/rooms/{id}/stop`); `getSender()` is not read in cookie mode (`endpoint_id` comes from the session).

- [ ] **Step 1: Write failing tests**
  1. `client`: cookie mode sends `credentials: 'same-origin'`, adds `X-Sigil-CSRF: 1` on POST only, never sends `Authorization`; 401 calls `onUnauthorized`; token mode unchanged (existing tests untouched).
  2. `App`: cookie mode with no session renders `LoginPage` and no `TokenGate`; after `me` resolves renders the room list; token mode still renders `TokenGate`.
  3. `RoomList`/`RoomHeader`: non-operator sees no Create room and sees "Stop my runs"; operator sees "Stop room".
  4. `InvitePage` posts the token as a form field and removes the fragment.
  5. `useSend`/`isManager` use `session.endpoint_id` in cookie mode and never call `getSender()`.

- [ ] **Step 2:** Run the client tests (`cat packages/sigil-rooms-web/package.json | grep '"test"'` for the command, wrapped in `timeout 60`). Expected: new cases FAIL.

- [ ] **Step 3: Implement** in the order: `config.ts` → `client.ts` → `AuthContext` → pages → `App.tsx` switch → the four consumer sites. For each consumer, replace `!token` with `!isLoggedIn` and keep the token path for `authMode === 'token'`.

- [ ] **Step 4:** Run the client tests plus the package type check (`npx tsc --noEmit -p packages/sigil-rooms-web`, wrapped in `timeout 60`). Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/sigil-rooms-web
git commit -m "feat(sigil-rooms-web): cookie-mode login, invite page, and operator-gated controls"
```

---

### Task 15: End to end, proxy checks, Origin check in a browser, docs

**Files:**
- Create: `sigil/integration/oauth-login.e2e.test.mjs` (fits the existing `sigil/integration` directory), `sigil/integration/fixtures/loopback-tls/` (generated cert, gitignored key), `docs/superpowers/plans/2026-10-13-oauth-login-manual-smoke.md`
- Modify: `STATUS.md`, `README`/relay docs that list `relay up` flags, `CHANGELOG.md`

**Interfaces:** none produced; this task proves the topology.

- [ ] **Step 1: Write the e2e test** (Postgres, in-process). Build the one-origin topology behind a loopback TLS proxy (a small `https` server using a throwaway self-signed cert from `node:crypto`/`openssl` at test start, forwarding `/v1/*` incl. WebSocket upgrades to the public port and everything else to the static server). Steps asserted:
  1. Operator invite redeemed through `start` → fake GitHub → `callback`; `me` returns the operator.
  2. Guest invite (one room, `member`) redeemed; guest posts a signed message through the composer route; the owner sees it.
  3. A router answer from an **owner-only** agent (`invokable_by='owner'`) triggered by the guest is refused.
  4. Through the proxy `/v1/endpoint-tokens`, `/v1/identities`, `/v1/envelopes`, `/v1/federation/envelopes`, `/v1/health`, and `/approve` all return 404.
  5. `Set-Cookie` with `__Host-` survives; `Origin` and `Host` arrive unchanged (the stub records them).
  6. A WebSocket upgrade with a ticket through the proxy succeeds; logout closes it.

- [ ] **Step 2: Add the Playwright check** (spec §Testing, `Origin` under `Referrer-Policy: same-origin`): serve the built client in cookie mode behind the loopback TLS proxy, open `/invite#<token>`, submit the form, and have the relay stub record the `Origin` header of the `start` request. Assert it equals `--public-origin`. If it does not, stop and report: the spec's Origin check design depends on this result.

- [ ] **Step 3: Run**

```bash
timeout 120 node --test sigil/integration/oauth-login.e2e.test.mjs
```

Expected: PASS. (`timeout 120` here because the e2e spins up Postgres fixtures; if it exceeds that, abort per the project's hang rule and report the file.)

- [ ] **Step 4: Manual smoke checklist.** Write `2026-10-13-oauth-login-manual-smoke.md` with real-GitHub steps: create an OAuth App with the Tailscale hostname callback (open item 1: if GitHub rejects the hostname, record the fallback domain), set `GITHUB_OAUTH_CLIENT_ID/SECRET`, `relay up --public-origin`, `tailscale serve` table, `invite create --self --provider github --login <name>` (open item 4: confirm `api.github.com` is reachable, 60/h unauthenticated), complete login on a phone over the tailnet, `invite create --name Guest --room <id>:member`, guest login, `invite revoke`, `identity revoke`, confirm the guest's open tab drops.

- [ ] **Step 5: Update docs and commit.** Add the new flags and commands to the relay help and README, add a `STATUS.md` entry (state: implemented, unpushed or PR number; note the deferred router-pick race remains), and a `CHANGELOG.md` line.

```bash
git add sigil/integration docs/superpowers/plans/2026-10-13-oauth-login-manual-smoke.md STATUS.md CHANGELOG.md README.md
git commit -m "test(sigil): oauth login e2e through a loopback tls proxy and manual smoke checklist"
```

- [ ] **Step 6: Final gate.** One background full-suite run only (`run_in_background`), then push in the background and verify the real `git push` exit code.

---

## Self-review

**Spec coverage.**

| Spec section | Task |
| --- | --- |
| Origin topology: second listener, allowlist, ticket-only stream | 8, 9, 11 |
| Mode signal, CSP, dev server | 13 |
| Web client contract | 14 |
| `/v1/auth/me` incl. `is_operator` | 10 |
| Provider interface, S256, GitHub numeric id | 4 |
| Flow state and cookie binding | 3, 10 |
| Routes before/after the gate | 9, 10 |
| Callback decision, linking, reactivation | 6 |
| Invites incl. `--self`, `--human`, revoke, list | 5, 12 |
| Browser session, idle/absolute expiry, sockets follow session | 5, 7, 8 |
| Identity revoke CLI + fixed-size NOTIFY | 12 |
| CSRF and `start` origin check | 9 |
| Rate limits, scope-kind CHECK | 1, 10 |
| Audit rules (no flow cookie, no subject hash) | 6, 10 |
| Data / migration | 1 |
| Config flags and startup assertions | 11 |
| Testing bullets | per task; e2e + Playwright in 15 |
| Module placement | file structure + Global Constraints |
| Open items 1–4 | 15 Step 4, Task 0, Task 10 pg test |

**Deviations to confirm.** (1) The cookie authenticator does one indexed join per request and keeps no cache (spec says "through the foundation's cache"). The existing cache is keyed by `endpoint_id`, which cannot hold per-session state, and a cache would add invalidation surface for the NOTIFY path. `revalidate` still closes live sockets. (2) `completeLogin` writes the denial audit row in a second transaction after rollback, because the first one aborts. (3) The NOTIFY channel name is taken from the foundation's `room-notify.mjs` at implementation time (Task 12 says to read it); this plan does not guess it.

**Placeholder scan.** No "TBD"/"later". Tasks 5, 8, 11, 12, 13, 14 give interfaces and the behavior-defining code, and name the exact file regions to read before editing because the surrounding code is large and unchanged; they do not defer decisions.

**Type consistency.** `completeLogin` returns `{ outcome, human_id, endpoint_id }`, consumed by Task 10 via `result.outcome`. `createHumanSession` fields `endpointId|lastSeenAt|identityIssuer|identitySubject` (Task 5) match the call in Task 6. `principal.session_id` is the SHA-256 hex produced by `hashCookie` in Tasks 7 and 10, and the same value tags sockets (Task 8) and keys `revokeSession` (Task 7). `FLOW_COOKIE`/`SESSION_COOKIE` constants come from Task 3 everywhere. `flow.inviteId` holds the raw invite **token** (Task 10 `start`), passed as `inviteToken` to `completeLogin`; the field name is historical, keep it.
