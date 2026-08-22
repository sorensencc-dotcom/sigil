# Sigil Endpoint Directory & Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the endpoint directory/trust spec — invite-code and OIDC-match on-ramps into a mutual-confirmation `directory_links` table, enforced in the existing envelope-accept transaction — in `C:\dev\sigil-repo`.

**Architecture:** Follows the gap-closure design's established shape exactly: new DB-backed checks are loaded inside `acceptEnvelopeAsync`'s single repository transaction (`accept-envelope.mjs`), `validateEnvelope` stays untouched (the directory-link check runs beside the existing capability/replay/quota checks, not inside `validateEnvelope`), and `PostgresRepository`/`memory-repository.mjs` stay behaviorally equivalent. New HTTP routes in `http-server.mjs` follow the existing route-matching-if-chain style. Confirmation and rate-limit scopes reuse the existing `quota_usage` table (new `scope_kind` values) rather than a new table.

**Tech Stack:** Node.js (`node --test`), `pg`, existing repo conventions (no new dependencies).

**Spec:** `docs/specs/sigil-endpoint-directory-trust-spec-v1.0.md` (this plan implements it in full; §3/§4/§5/§6/§7/§8/§10 map to tasks below).

## Global Constraints

- New DB-backed checks run inside `acceptEnvelopeAsync`'s existing `repository.withTransaction` call in `accept-envelope.mjs` — never a second transaction, never inside `validateEnvelope` (spec §8, matching gap-closure design §3).
- All new migrations are idempotent: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS` (matches existing `sigil/migrations/*.sql` convention).
- Every new DB-backed behavior is implemented and tested against **both** `PostgresRepository` (`sigil/relay/v1/postgres-repository.mjs`) and `memory-repository.mjs` (`sigil/cli/memory-repository.mjs`) so the CLI dev path and the production path never silently diverge (spec §11, last bullet).
- Expiry bounds: 24h default, deployment-configurable within `[1h, 7d]` (spec §7, §12).
- Rate-limit scopes: `directory_invite_create`, `directory_invite_redeem`, `directory_match_create`, `directory_match_attempt` — dedicated, not reusing the existing `endpoint`/`owner`/`conversation` scopes (spec §6, §12).
- Confirmation and endpoint-nomination routes require `principal?.human_id` (an authenticated human session, per `sigil-plugin-connector-auth-spec-v1.0.md` §5.4) — endpoint bearer-token auth alone is never sufficient, matching the existing `/v1/identities`, `/v1/account-links` route guard pattern in `http-server.mjs`.
- Test files are colocated `*.test.mjs` next to source, following existing repo convention.

---

## File Structure

New files this plan creates:

- `sigil/migrations/012_directory_trust.sql` — `directory_invites`, `directory_match_requests`, `directory_links`, `oidc_issuer_allowlist` tables; `quota_usage.scope_kind` CHECK widened.
- `sigil/relay/v1/directory-trust.mjs`, `directory-trust.test.mjs` — pure helpers: code hashing, expiry bounds validation, partial-unique-conflict error shaping. Kept separate from the repository so the logic that doesn't need a DB connection is unit-testable without one (matches the existing `validate-envelope.mjs` / repository split).

Modified files: `sigil/relay/v1/postgres-repository.mjs`, `sigil/cli/memory-repository.mjs`, `sigil/relay/v1/accept-envelope.mjs`, `sigil/relay/v1/http-server.mjs`, `sigil/relay/v1/relay-config.mjs`, `sigil/relay/v1/auth-policy.mjs`, `sigil/contracts/v1/errors-and-states.json`, `sigil/relay/v1/accept-envelope.test.mjs`, `sigil/relay/v1/http-server.test.mjs`, `sigil/relay/v1/postgres-repository.integration.test.mjs`, `sigil/integration/vertical-slice.test.mjs`.

---

## Task 1: Migration — directory tables + widened rate-limit scopes + error codes

**Files:**
- Create: `sigil/migrations/012_directory_trust.sql`
- Modify: `sigil/contracts/v1/errors-and-states.json`

**Interfaces:**
- Produces: the four new tables and columns every later task's repository methods query against; the `DIRECTORY_LINK_REQUIRED` error code every later task's HTTP/accept-envelope code returns.

- [ ] **Step 1: Write the migration**

```sql
-- sigil/migrations/012_directory_trust.sql
-- Endpoint directory/trust spec (docs/specs/sigil-endpoint-directory-trust-spec-v1.0.md).
-- All four tables ship together: directory_links FKs into both
-- directory_invites and directory_match_requests as its optional source.

CREATE TABLE IF NOT EXISTS oidc_issuer_allowlist (
  issuer TEXT PRIMARY KEY,
  display_label TEXT NOT NULL,
  discovery_url TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  assurance_level TEXT NOT NULL DEFAULT 'standard' CHECK (assurance_level = 'standard'),
  added_by TEXT,
  added_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS directory_invites (
  invite_id TEXT PRIMARY KEY,
  issuer_endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  issuer_human_id TEXT NOT NULL REFERENCES humans(human_id),
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'redeemed', 'expired', 'revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_by_human_id TEXT REFERENCES humans(human_id),
  redeemed_at TIMESTAMPTZ,
  home_relay TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS directory_invites_code_hash_idx ON directory_invites(code_hash);

CREATE TABLE IF NOT EXISTS directory_match_requests (
  request_id TEXT PRIMARY KEY,
  issuer_endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  issuer_human_id TEXT NOT NULL REFERENCES humans(human_id),
  issuer TEXT NOT NULL REFERENCES oidc_issuer_allowlist(issuer),
  match_target_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'matched', 'consumed', 'expired', 'revoked')),
  matched_human_id TEXT REFERENCES humans(human_id),
  matched_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  home_relay TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS directory_match_requests_target_idx ON directory_match_requests(issuer, match_target_hash);

CREATE TABLE IF NOT EXISTS directory_links (
  link_id TEXT PRIMARY KEY,
  endpoint_a TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  endpoint_b TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  human_a TEXT NOT NULL REFERENCES humans(human_id),
  human_b TEXT NOT NULL REFERENCES humans(human_id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked', 'expired')),
  initiated_via TEXT NOT NULL CHECK (initiated_via IN ('invite', 'oidc_match')),
  source_invite_id TEXT REFERENCES directory_invites(invite_id),
  source_request_id TEXT REFERENCES directory_match_requests(request_id),
  a_confirmed_at TIMESTAMPTZ,
  b_confirmed_at TIMESTAMPTZ,
  a_confirmed_by TEXT REFERENCES humans(human_id),
  b_confirmed_by TEXT REFERENCES humans(human_id),
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT REFERENCES humans(human_id),
  home_relay TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (endpoint_a <> endpoint_b),
  CHECK (human_a <> human_b)
);

CREATE UNIQUE INDEX IF NOT EXISTS directory_links_active_pair_idx
  ON directory_links(endpoint_a, endpoint_b) WHERE status IN ('pending', 'active');

-- Reverse-direction lookup (sender/recipient order is not fixed at query
-- time; spec §4 fixes storage order only, the accept-transaction check
-- looks up both directions).
CREATE INDEX IF NOT EXISTS directory_links_endpoint_b_idx ON directory_links(endpoint_b, endpoint_a);

-- Widen the existing rolling-window rate-limit scope set (design §8) to
-- cover the four directory abuse-surface scopes (spec §6). Constraint is
-- dropped/re-added by name since Postgres has no ADD CONSTRAINT IF NOT
-- EXISTS for CHECK constraints; re-running this migration is still safe
-- because DROP CONSTRAINT IF EXISTS makes the drop itself idempotent.
ALTER TABLE quota_usage DROP CONSTRAINT IF EXISTS quota_usage_scope_kind_check;
ALTER TABLE quota_usage ADD CONSTRAINT quota_usage_scope_kind_check
  CHECK (scope_kind IN ('endpoint', 'owner', 'conversation',
                         'directory_invite_create', 'directory_invite_redeem',
                         'directory_match_create', 'directory_match_attempt'));
```

- [ ] **Step 2: Add the new error code**

In `sigil/contracts/v1/errors-and-states.json`, add `"DIRECTORY_LINK_REQUIRED"` to the `errors` array, immediately after `"QUOTA_EXCEEDED"`:

```json
    "RATE_LIMITED",
    "QUOTA_EXCEEDED",
    "DIRECTORY_LINK_REQUIRED",
    "VERSION_UNSUPPORTED",
```

- [ ] **Step 3: Verify the migration applies cleanly**

Run: `node -e "import('pg').then(async ({default: pg}) => { const pool = new pg.Pool({connectionString: process.env.SIGIL_TEST_DATABASE_URL}); const fs = await import('node:fs/promises'); const files = (await fs.readdir('sigil/migrations')).filter(f => f.endsWith('.sql')).sort(); await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public'); for (const f of files) await pool.query(await fs.readFile('sigil/migrations/' + f, 'utf8')); console.log('OK', files.length, 'migrations applied'); await pool.end(); })"` (requires `SIGIL_TEST_DATABASE_URL` set to a disposable local PostgreSQL 16 instance, same as the existing `npm run test:live` gate)

Expected: `OK 12 migrations applied`, no errors.

- [ ] **Step 4: Commit**

```bash
git add sigil/migrations/012_directory_trust.sql sigil/contracts/v1/errors-and-states.json
git commit -m "feat(migrations): add directory/trust tables and DIRECTORY_LINK_REQUIRED error code"
```

---

## Task 2: Config + pure helpers — expiry bounds, rate-limit defaults, code hashing

**Files:**
- Create: `sigil/relay/v1/directory-trust.mjs`
- Create: `sigil/relay/v1/directory-trust.test.mjs`
- Modify: `sigil/relay/v1/relay-config.mjs`
- Modify: `sigil/relay/v1/auth-policy.mjs`

**Interfaces:**
- Produces: `generateInviteCode()` → `{ code, codeHash }`; `hashMatchTarget(value)` → string; `boundedDirectoryExpiry({ now, expiresAt })` → `Date` (throws `DIRECTORY_EXPIRY_INVALID`); `DEFAULT_DIRECTORY_RATE_LIMITS` (from `relay-config.mjs`); `DEFAULT_DIRECTORY_EXPIRY_MS`, `DIRECTORY_EXPIRY_MIN_MS`, `DIRECTORY_EXPIRY_MAX_MS` (from `auth-policy.mjs`).
- Consumes: nothing new (uses `node:crypto` only).

- [ ] **Step 1: Write the failing tests**

```javascript
// sigil/relay/v1/directory-trust.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateInviteCode, hashMatchTarget } from './directory-trust.mjs';
import { boundedDirectoryExpiry, DIRECTORY_EXPIRY_MIN_MS, DIRECTORY_EXPIRY_MAX_MS } from './auth-policy.mjs';

test('generateInviteCode returns a high-entropy code and its sha256 hash', () => {
  const { code, codeHash } = generateInviteCode();
  assert.equal(typeof code, 'string');
  assert.ok(code.length >= 32);
  assert.equal(codeHash.length, 64);
  assert.notEqual(code, codeHash);
});

test('generateInviteCode never repeats across calls', () => {
  const first = generateInviteCode();
  const second = generateInviteCode();
  assert.notEqual(first.code, second.code);
});

test('hashMatchTarget is deterministic and never returns the raw value', () => {
  const a = hashMatchTarget('person@example.com');
  const b = hashMatchTarget('person@example.com');
  assert.equal(a, b);
  assert.notEqual(a, 'person@example.com');
});

test('boundedDirectoryExpiry defaults to 24h from now', () => {
  const now = new Date('2026-08-21T00:00:00Z');
  const expiry = boundedDirectoryExpiry({ now });
  assert.equal(expiry.toISOString(), '2026-08-22T00:00:00.000Z');
});

test('boundedDirectoryExpiry accepts a value within [1h, 7d]', () => {
  const now = new Date('2026-08-21T00:00:00Z');
  const expiry = boundedDirectoryExpiry({ now, expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000) });
  assert.equal(expiry.getTime(), now.getTime() + 2 * 60 * 60 * 1000);
});

test('boundedDirectoryExpiry rejects below the 1h floor', () => {
  const now = new Date('2026-08-21T00:00:00Z');
  assert.throws(() => boundedDirectoryExpiry({ now, expiresAt: new Date(now.getTime() + 30 * 60 * 1000) }), { code: 'DIRECTORY_EXPIRY_INVALID' });
});

test('boundedDirectoryExpiry rejects above the 7d ceiling', () => {
  const now = new Date('2026-08-21T00:00:00Z');
  assert.throws(() => boundedDirectoryExpiry({ now, expiresAt: new Date(now.getTime() + DIRECTORY_EXPIRY_MAX_MS + 1) }), { code: 'DIRECTORY_EXPIRY_INVALID' });
});

test('boundedDirectoryExpiry rejects a non-positive duration', () => {
  const now = new Date('2026-08-21T00:00:00Z');
  assert.throws(() => boundedDirectoryExpiry({ now, expiresAt: now }), { code: 'DIRECTORY_EXPIRY_INVALID' });
});

test('DIRECTORY_EXPIRY_MIN_MS and MAX_MS match spec §7 bounds', () => {
  assert.equal(DIRECTORY_EXPIRY_MIN_MS, 60 * 60 * 1000);
  assert.equal(DIRECTORY_EXPIRY_MAX_MS, 7 * 24 * 60 * 60 * 1000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test sigil/relay/v1/directory-trust.test.mjs`
Expected: FAIL — `directory-trust.mjs` and the new `auth-policy.mjs` exports don't exist yet.

- [ ] **Step 3: Implement the pure helpers**

```javascript
// sigil/relay/v1/directory-trust.mjs
import crypto from 'node:crypto';

// High-entropy, single-use invite code (spec §3.1). Only the hash is ever
// persisted (spec §3.1 step 1: "stores its hash (never the code itself)").
export function generateInviteCode() {
  const code = crypto.randomBytes(24).toString('base64url');
  return { code, codeHash: crypto.createHash('sha256').update(code).digest('hex') };
}

// Match target (a provider-verified attribute value, spec §3.2 step 1) is
// hashed the same way an invite code is -- never stored or compared in the
// clear, so a leaked directory_match_requests row doesn't leak the target.
export function hashMatchTarget(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
```

Add to `sigil/relay/v1/auth-policy.mjs` (after `boundedTokenExpiry`, following its exact shape):

```javascript
export const DIRECTORY_EXPIRY_DEFAULT_MS = 24 * 60 * 60 * 1000;
export const DIRECTORY_EXPIRY_MIN_MS = 60 * 60 * 1000;
export const DIRECTORY_EXPIRY_MAX_MS = 7 * 24 * 60 * 60 * 1000;

// Bounds invite/match-request expiry to spec §7's [1h, 7d] range, same
// shape as boundedTokenExpiry above.
export function boundedDirectoryExpiry({ now = new Date(), expiresAt } = {}) {
  const issued = now instanceof Date ? now : new Date(now);
  const expiry = expiresAt ? (expiresAt instanceof Date ? expiresAt : new Date(expiresAt)) : new Date(issued.getTime() + DIRECTORY_EXPIRY_DEFAULT_MS);
  const durationMs = expiry.getTime() - issued.getTime();
  if (Number.isNaN(expiry.getTime()) || durationMs < DIRECTORY_EXPIRY_MIN_MS || durationMs > DIRECTORY_EXPIRY_MAX_MS) {
    throw Object.assign(new Error('Directory invite/match expiry must be between 1 hour and 7 days'), { code: 'DIRECTORY_EXPIRY_INVALID' });
  }
  return expiry;
}
```

Add to `sigil/relay/v1/relay-config.mjs` (after `DEFAULT_HEARTBEAT`, following the existing `DEFAULT_RATE_LIMITS` shape):

```javascript
// Dedicated directory abuse-surface scopes (spec §6) -- distinct from
// DEFAULT_RATE_LIMITS above, which only covers ordinary envelope delivery.
export const DEFAULT_DIRECTORY_RATE_LIMITS = Object.freeze({
  directory_invite_create: 20,
  directory_invite_redeem: 10,
  directory_match_create: 20,
  directory_match_attempt: 10,
});

export function resolveDirectoryRateLimits(overrides = {}) {
  return { ...DEFAULT_DIRECTORY_RATE_LIMITS, ...overrides };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test sigil/relay/v1/directory-trust.test.mjs`
Expected: all 8 PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/directory-trust.mjs sigil/relay/v1/directory-trust.test.mjs sigil/relay/v1/relay-config.mjs sigil/relay/v1/auth-policy.mjs
git commit -m "feat(directory): add expiry bounds, rate-limit defaults, and code-hashing helpers"
```

---

## Task 3: Repository — invite create/redeem (Postgres + memory)

**Files:**
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Modify: `sigil/cli/memory-repository.mjs`
- Create: `sigil/relay/v1/postgres-repository.directory-invites.test.mjs`

**Interfaces:**
- Consumes: `generateInviteCode`, `hashMatchTarget` (`directory-trust.mjs`, Task 2); `boundedDirectoryExpiry` (`auth-policy.mjs`, Task 2).
- Produces: `repository.createDirectoryInvite({ issuerEndpointId, issuerHumanId, expiresAt, homeRelay, now })` → `{ invite_id, code, expires_at }` (plaintext `code` returned once, never again); `repository.redeemDirectoryInvite({ code, redeemerEndpointId, redeemerHumanId, homeRelay, now })` → `{ link_id, status: 'pending' }` or throws `INVITE_UNAVAILABLE` (generic, spec §3.1.4) / `ENDPOINT_OWNERSHIP_MISMATCH`. Later tasks (5, 7) call both.

- [ ] **Step 1: Write the failing test**

```javascript
// sigil/relay/v1/postgres-repository.directory-invites.test.mjs
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

test('directory invite create/redeem lifecycle', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  const ids = { a: `usr_a_${suffix}`, b: `usr_b_${suffix}`, epA: `ep_a_${suffix}`, epB: `ep_b_${suffix}`, epOther: `ep_other_${suffix}` };
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.a}', 'active', NOW()), ('${ids.b}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.epA}', '${ids.a}', 'claude', 'install_a', 'A', 'active', NOW()),
             ('${ids.epB}', '${ids.b}', 'codex', 'install_b', 'B', 'active', NOW()),
             ('${ids.epOther}', '${ids.a}', 'claude', 'install_other', 'Other', 'active', NOW());
  `);
  const repository = new PostgresRepository({ pool });

  const invite = await repository.createDirectoryInvite({ issuerEndpointId: ids.epA, issuerHumanId: ids.a, homeRelay: 'relay.local', now: new Date('2026-08-21T00:00:00Z') });
  assert.equal(typeof invite.code, 'string');
  assert.equal(typeof invite.invite_id, 'string');

  const redeemed = await repository.redeemDirectoryInvite({ code: invite.code, redeemerEndpointId: ids.epB, redeemerHumanId: ids.b, homeRelay: 'relay.local', now: new Date('2026-08-21T01:00:00Z') });
  assert.equal(typeof redeemed.link_id, 'string');
  assert.equal(redeemed.status, 'pending');

  const link = await pool.query('SELECT * FROM directory_links WHERE link_id = $1', [redeemed.link_id]);
  assert.equal(link.rows[0].b_confirmed_at !== null, true);
  assert.equal(link.rows[0].a_confirmed_at, null);
  assert.equal(link.rows[0].initiated_via, 'invite');

  await assert.rejects(
    () => repository.redeemDirectoryInvite({ code: invite.code, redeemerEndpointId: ids.epB, redeemerHumanId: ids.b, homeRelay: 'relay.local', now: new Date('2026-08-21T02:00:00Z') }),
    { code: 'INVITE_UNAVAILABLE' }
  );

  const secondInvite = await repository.createDirectoryInvite({ issuerEndpointId: ids.epA, issuerHumanId: ids.a, homeRelay: 'relay.local', now: new Date('2026-08-21T00:00:00Z') });
  await assert.rejects(
    () => repository.redeemDirectoryInvite({ code: secondInvite.code, redeemerEndpointId: ids.epOther, redeemerHumanId: ids.a, homeRelay: 'relay.local', now: new Date('2026-08-21T00:30:00Z') }),
    { code: 'INVITE_UNAVAILABLE' }
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SIGIL_TEST_DATABASE_URL=<local pg url> node --test sigil/relay/v1/postgres-repository.directory-invites.test.mjs`
Expected: FAIL — `repository.createDirectoryInvite is not a function`.

- [ ] **Step 3: Implement in `postgres-repository.mjs`**

Add imports at the top (alongside the existing `import { assertAssurance } from './auth-policy.mjs';`):

```javascript
import { generateInviteCode } from './directory-trust.mjs';
```

Add methods to the `PostgresRepository` class (near `createEndpointWithAudit`, same file):

```javascript
  async createDirectoryInvite({ issuerEndpointId, issuerHumanId, expiresAt, homeRelay, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const { code, codeHash } = generateInviteCode();
    const inviteId = `invite_${crypto.randomUUID()}`;
    const result = await this.pool.query(
      `INSERT INTO directory_invites (invite_id, issuer_endpoint_id, issuer_human_id, code_hash, status, expires_at, home_relay, created_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
       RETURNING invite_id, expires_at`,
      [inviteId, issuerEndpointId, issuerHumanId, codeHash, expiresAt.toISOString(), homeRelay, timestamp]
    );
    return { invite_id: result.rows[0].invite_id, code, expires_at: result.rows[0].expires_at };
  }
  // Spec §3.1 step 3/4: single generic error for wrong/expired/revoked/
  // unknown code, and an explicit endpoint-ownership check (round 1 review
  // finding) before any code check is treated as successful.
  async redeemDirectoryInvite({ code, redeemerEndpointId, redeemerHumanId, homeRelay, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    return this.withTransaction(async (client) => {
      const ownership = await client.query('SELECT owner_id FROM endpoints WHERE endpoint_id = $1', [redeemerEndpointId]);
      if (!ownership.rows[0] || ownership.rows[0].owner_id !== redeemerHumanId) {
        throw Object.assign(new Error('Invite code is invalid or expired'), { code: 'INVITE_UNAVAILABLE' });
      }
      const invite = await client.query(
        `SELECT * FROM directory_invites WHERE code_hash = $1 AND status = 'pending' AND expires_at > $2 FOR UPDATE`,
        [codeHash, timestamp]
      );
      if (!invite.rows[0]) throw Object.assign(new Error('Invite code is invalid or expired'), { code: 'INVITE_UNAVAILABLE' });
      const row = invite.rows[0];
      await client.query(`UPDATE directory_invites SET status = 'redeemed', redeemed_by_human_id = $1, redeemed_at = $2 WHERE invite_id = $3`, [redeemerHumanId, timestamp, row.invite_id]);
      const [endpointA, endpointB] = [row.issuer_endpoint_id, redeemerEndpointId].sort();
      const [humanA, humanB] = endpointA === row.issuer_endpoint_id ? [row.issuer_human_id, redeemerHumanId] : [redeemerHumanId, row.issuer_human_id];
      const aConfirmedAt = endpointA === row.issuer_endpoint_id ? null : timestamp;
      const bConfirmedAt = endpointA === row.issuer_endpoint_id ? timestamp : null;
      const bConfirmedBy = endpointA === row.issuer_endpoint_id ? redeemerHumanId : row.issuer_human_id;
      const aConfirmedBy = endpointA === row.issuer_endpoint_id ? null : row.issuer_human_id;
      let link;
      try {
        link = await client.query(
          `INSERT INTO directory_links (link_id, endpoint_a, endpoint_b, human_a, human_b, status, initiated_via, source_invite_id, a_confirmed_at, b_confirmed_at, a_confirmed_by, b_confirmed_by, home_relay, created_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', 'invite', $6, $7, $8, $9, $10, $11, $12)
           RETURNING link_id, status`,
          [`link_${crypto.randomUUID()}`, endpointA, endpointB, humanA, humanB, row.invite_id, aConfirmedAt, bConfirmedAt, aConfirmedBy, bConfirmedBy, homeRelay, timestamp]
        );
      } catch (error) {
        if (error.code === '23505') throw Object.assign(new Error('A directory link already exists or is pending between these endpoints'), { code: 'DIRECTORY_LINK_CONFLICT' });
        throw error;
      }
      return { link_id: link.rows[0].link_id, status: link.rows[0].status };
    });
  }
```

- [ ] **Step 4: Implement in `memory-repository.mjs`**

Add near the top of `createMemoryRepository`, after the existing `const acknowledgements = new Map();`:

```javascript
  const directoryInvites = new Map(); // code -> invite row (memory repo has no separate hash step -- single process, nothing to hide from itself)
  const directoryLinks = new Map();
```

Add methods to the returned object (near `acknowledgeEndpoint`):

```javascript
    async createDirectoryInvite({ issuerEndpointId, issuerHumanId, expiresAt, homeRelay, now = new Date() }) {
      const inviteId = `invite_${crypto.randomUUID()}`;
      const code = crypto.randomBytes(24).toString('base64url');
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      directoryInvites.set(code, { invite_id: inviteId, issuer_endpoint_id: issuerEndpointId, issuer_human_id: issuerHumanId, status: 'pending', expires_at: expiresAt.toISOString(), home_relay: homeRelay, created_at: timestamp });
      return { invite_id: inviteId, code, expires_at: expiresAt.toISOString() };
    },
    async redeemDirectoryInvite({ code, redeemerEndpointId, redeemerHumanId, homeRelay, now = new Date() }) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const invite = directoryInvites.get(code);
      if (!invite || invite.status !== 'pending' || invite.expires_at <= timestamp) {
        throw Object.assign(new Error('Invite code is invalid or expired'), { code: 'INVITE_UNAVAILABLE' });
      }
      invite.status = 'redeemed'; invite.redeemed_by_human_id = redeemerHumanId; invite.redeemed_at = timestamp;
      const [endpointA, endpointB] = [invite.issuer_endpoint_id, redeemerEndpointId].sort();
      const pairKey = `${endpointA}:${endpointB}`;
      const existing = [...directoryLinks.values()].find((l) => l.endpoint_a === endpointA && l.endpoint_b === endpointB && (l.status === 'pending' || l.status === 'active'));
      if (existing) throw Object.assign(new Error('A directory link already exists or is pending between these endpoints'), { code: 'DIRECTORY_LINK_CONFLICT' });
      const linkId = `link_${crypto.randomUUID()}`;
      const [humanA, humanB] = endpointA === invite.issuer_endpoint_id ? [invite.issuer_human_id, redeemerHumanId] : [redeemerHumanId, invite.issuer_human_id];
      const link = {
        link_id: linkId, endpoint_a: endpointA, endpoint_b: endpointB, human_a: humanA, human_b: humanB, status: 'pending', initiated_via: 'invite',
        a_confirmed_at: endpointA === invite.issuer_endpoint_id ? null : timestamp,
        b_confirmed_at: endpointA === invite.issuer_endpoint_id ? timestamp : null,
        a_confirmed_by: endpointA === invite.issuer_endpoint_id ? null : invite.issuer_human_id,
        b_confirmed_by: endpointA === invite.issuer_endpoint_id ? redeemerHumanId : invite.issuer_human_id,
        revoked_at: null, home_relay: homeRelay, created_at: timestamp
      };
      directoryLinks.set(linkId, link);
      return { link_id: linkId, status: 'pending' };
    },
```

(The memory repository's `directoryLinks` map is also consumed by Task 5's confirm/revoke/lookup methods and Task 6's accept-envelope enforcement — declared here once, used by both.)

- [ ] **Step 5: Run test to verify it passes**

Run: `SIGIL_TEST_DATABASE_URL=<local pg url> node --test sigil/relay/v1/postgres-repository.directory-invites.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sigil/relay/v1/postgres-repository.mjs sigil/cli/memory-repository.mjs sigil/relay/v1/postgres-repository.directory-invites.test.mjs
git commit -m "feat(directory): invite create/redeem in postgres and memory repositories"
```

---

## Task 4: Repository — OIDC match request create/match/nominate (Postgres + memory)

**Files:**
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Modify: `sigil/cli/memory-repository.mjs`
- Create: `sigil/relay/v1/postgres-repository.directory-match.test.mjs`

**Interfaces:**
- Consumes: `hashMatchTarget` (`directory-trust.mjs`, Task 2).
- Produces: `repository.createDirectoryMatchRequest({ issuerEndpointId, issuerHumanId, issuer, matchTarget, expiresAt, homeRelay, now })` → `{ request_id }`; `repository.claimDirectoryMatch({ issuer, matchTarget, matchedHumanId, now })` → `{ request_id }` or `null` if no pending row matches (spec §3.2 step 2, atomic claim); `repository.nominateDirectoryLinkEndpoint({ requestId, nominatedEndpointId, nominatedHumanId, homeRelay, now })` → `{ link_id, status: 'pending' }` (spec §3.2 step 3).

- [ ] **Step 1: Write the failing test**

```javascript
// sigil/relay/v1/postgres-repository.directory-match.test.mjs
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

test('directory OIDC match lifecycle, including single-winner concurrency', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  const ids = { a: `usr_a_${suffix}`, b: `usr_b_${suffix}`, c: `usr_c_${suffix}`, epA: `ep_a_${suffix}`, epB: `ep_b_${suffix}` };
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.a}', 'active', NOW()), ('${ids.b}', 'active', NOW()), ('${ids.c}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.epA}', '${ids.a}', 'claude', 'install_a', 'A', 'active', NOW()),
             ('${ids.epB}', '${ids.b}', 'codex', 'install_b', 'B', 'active', NOW());
    INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, added_at) VALUES ('https://accounts.example.com', 'Example', TRUE, NOW());
  `);
  const repository = new PostgresRepository({ pool });
  const now = new Date('2026-08-21T00:00:00Z');

  const request = await repository.createDirectoryMatchRequest({ issuerEndpointId: ids.epA, issuerHumanId: ids.a, issuer: 'https://accounts.example.com', matchTarget: 'target@example.com', expiresAt: new Date(now.getTime() + 60 * 60 * 1000), homeRelay: 'relay.local', now });
  assert.equal(typeof request.request_id, 'string');

  const [claimByB, claimByC] = await Promise.all([
    repository.claimDirectoryMatch({ issuer: 'https://accounts.example.com', matchTarget: 'target@example.com', matchedHumanId: ids.b, now }),
    repository.claimDirectoryMatch({ issuer: 'https://accounts.example.com', matchTarget: 'target@example.com', matchedHumanId: ids.c, now })
  ]);
  const winners = [claimByB, claimByC].filter((r) => r !== null);
  assert.equal(winners.length, 1);

  const nominated = await repository.nominateDirectoryLinkEndpoint({ requestId: request.request_id, nominatedEndpointId: ids.epB, nominatedHumanId: ids.b, homeRelay: 'relay.local', now });
  assert.equal(typeof nominated.link_id, 'string');
  assert.equal(nominated.status, 'pending');

  const link = await pool.query('SELECT * FROM directory_links WHERE link_id = $1', [nominated.link_id]);
  assert.equal(link.rows[0].initiated_via, 'oidc_match');
  assert.equal(link.rows[0].b_confirmed_at !== null, true);

  const nonMatch = await repository.claimDirectoryMatch({ issuer: 'https://accounts.example.com', matchTarget: 'nobody@example.com', matchedHumanId: ids.c, now });
  assert.equal(nonMatch, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SIGIL_TEST_DATABASE_URL=<local pg url> node --test sigil/relay/v1/postgres-repository.directory-match.test.mjs`
Expected: FAIL — methods don't exist yet.

- [ ] **Step 3: Implement in `postgres-repository.mjs`**

Add `import { hashMatchTarget } from './directory-trust.mjs';` alongside the `generateInviteCode` import from Task 3.

Add methods:

```javascript
  async createDirectoryMatchRequest({ issuerEndpointId, issuerHumanId, issuer, matchTarget, expiresAt, homeRelay, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const requestId = `dreq_${crypto.randomUUID()}`;
    await this.pool.query(
      `INSERT INTO directory_match_requests (request_id, issuer_endpoint_id, issuer_human_id, issuer, match_target_hash, status, expires_at, home_relay, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)`,
      [requestId, issuerEndpointId, issuerHumanId, issuer, hashMatchTarget(matchTarget), expiresAt.toISOString(), homeRelay, timestamp]
    );
    return { request_id: requestId };
  }
  // Spec §3.2 step 2: single-client row-locking claim, same pattern as
  // lookupActiveCapabilityGrants's FOR UPDATE. Only the first caller to
  // reach this transaction for a given pending row wins; a second caller
  // for the same (issuer, target) sees no pending row and gets null, never
  // an error -- the caller maps null to the same generic non-match failure
  // as an invalid invite (spec §3.2 step 4).
  async claimDirectoryMatch({ issuer, matchTarget, matchedHumanId, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const targetHash = hashMatchTarget(matchTarget);
    return this.withTransaction(async (client) => {
      const candidate = await client.query(
        `SELECT request_id FROM directory_match_requests
         WHERE issuer = $1 AND match_target_hash = $2 AND status = 'pending' AND expires_at > $3
         FOR UPDATE SKIP LOCKED LIMIT 1`,
        [issuer, targetHash, timestamp]
      );
      if (!candidate.rows[0]) return null;
      await client.query(`UPDATE directory_match_requests SET status = 'matched', matched_human_id = $1, matched_at = $2 WHERE request_id = $3`, [matchedHumanId, timestamp, candidate.rows[0].request_id]);
      return { request_id: candidate.rows[0].request_id };
    });
  }
  async nominateDirectoryLinkEndpoint({ requestId, nominatedEndpointId, nominatedHumanId, homeRelay, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const ownership = await client.query('SELECT owner_id FROM endpoints WHERE endpoint_id = $1', [nominatedEndpointId]);
      if (!ownership.rows[0] || ownership.rows[0].owner_id !== nominatedHumanId) {
        throw Object.assign(new Error('Match request is invalid or already consumed'), { code: 'MATCH_UNAVAILABLE' });
      }
      const request = await client.query(`SELECT * FROM directory_match_requests WHERE request_id = $1 AND status = 'matched' AND matched_human_id = $2 FOR UPDATE`, [requestId, nominatedHumanId]);
      if (!request.rows[0]) throw Object.assign(new Error('Match request is invalid or already consumed'), { code: 'MATCH_UNAVAILABLE' });
      const row = request.rows[0];
      await client.query(`UPDATE directory_match_requests SET status = 'consumed', consumed_at = $1 WHERE request_id = $2`, [timestamp, requestId]);
      const [endpointA, endpointB] = [row.issuer_endpoint_id, nominatedEndpointId].sort();
      const [humanA, humanB] = endpointA === row.issuer_endpoint_id ? [row.issuer_human_id, nominatedHumanId] : [nominatedHumanId, row.issuer_human_id];
      let link;
      try {
        link = await client.query(
          `INSERT INTO directory_links (link_id, endpoint_a, endpoint_b, human_a, human_b, status, initiated_via, source_request_id, a_confirmed_at, b_confirmed_at, a_confirmed_by, b_confirmed_by, home_relay, created_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', 'oidc_match', $6, $7, $8, $9, $10, $11, $12)
           RETURNING link_id, status`,
          [`link_${crypto.randomUUID()}`, endpointA, endpointB, humanA, humanB, row.request_id,
            endpointA === row.issuer_endpoint_id ? null : timestamp,
            endpointA === row.issuer_endpoint_id ? timestamp : null,
            endpointA === row.issuer_endpoint_id ? null : row.issuer_human_id,
            endpointA === row.issuer_endpoint_id ? nominatedHumanId : row.issuer_human_id,
            homeRelay, timestamp]
        );
      } catch (error) {
        if (error.code === '23505') throw Object.assign(new Error('A directory link already exists or is pending between these endpoints'), { code: 'DIRECTORY_LINK_CONFLICT' });
        throw error;
      }
      return { link_id: link.rows[0].link_id, status: link.rows[0].status };
    });
  }
```

- [ ] **Step 4: Implement in `memory-repository.mjs`**

Add near `directoryInvites`/`directoryLinks`:

```javascript
  const directoryMatchRequests = new Map();
```

Add methods (single-process, so "concurrency" reduces to first-write-wins on a synchronous `Map.set`, which is equivalent to `SKIP LOCKED` behavior for a non-parallel in-memory store):

```javascript
    async createDirectoryMatchRequest({ issuerEndpointId, issuerHumanId, issuer, matchTarget, expiresAt, homeRelay, now = new Date() }) {
      const requestId = `dreq_${crypto.randomUUID()}`;
      directoryMatchRequests.set(requestId, { request_id: requestId, issuer_endpoint_id: issuerEndpointId, issuer_human_id: issuerHumanId, issuer, match_target: matchTarget, status: 'pending', expires_at: expiresAt.toISOString(), home_relay: homeRelay, created_at: (now instanceof Date ? now : new Date(now)).toISOString() });
      return { request_id: requestId };
    },
    async claimDirectoryMatch({ issuer, matchTarget, matchedHumanId, now = new Date() }) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const candidate = [...directoryMatchRequests.values()].find((r) => r.issuer === issuer && r.match_target === matchTarget && r.status === 'pending' && r.expires_at > timestamp);
      if (!candidate) return null;
      candidate.status = 'matched'; candidate.matched_human_id = matchedHumanId; candidate.matched_at = timestamp;
      return { request_id: candidate.request_id };
    },
    async nominateDirectoryLinkEndpoint({ requestId, nominatedEndpointId, nominatedHumanId, homeRelay, now = new Date() }) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const request = directoryMatchRequests.get(requestId);
      if (!request || request.status !== 'matched' || request.matched_human_id !== nominatedHumanId) {
        throw Object.assign(new Error('Match request is invalid or already consumed'), { code: 'MATCH_UNAVAILABLE' });
      }
      request.status = 'consumed'; request.consumed_at = timestamp;
      const [endpointA, endpointB] = [request.issuer_endpoint_id, nominatedEndpointId].sort();
      const existing = [...directoryLinks.values()].find((l) => l.endpoint_a === endpointA && l.endpoint_b === endpointB && (l.status === 'pending' || l.status === 'active'));
      if (existing) throw Object.assign(new Error('A directory link already exists or is pending between these endpoints'), { code: 'DIRECTORY_LINK_CONFLICT' });
      const linkId = `link_${crypto.randomUUID()}`;
      const [humanA, humanB] = endpointA === request.issuer_endpoint_id ? [request.issuer_human_id, nominatedHumanId] : [nominatedHumanId, request.issuer_human_id];
      directoryLinks.set(linkId, {
        link_id: linkId, endpoint_a: endpointA, endpoint_b: endpointB, human_a: humanA, human_b: humanB, status: 'pending', initiated_via: 'oidc_match',
        a_confirmed_at: endpointA === request.issuer_endpoint_id ? null : timestamp,
        b_confirmed_at: endpointA === request.issuer_endpoint_id ? timestamp : null,
        a_confirmed_by: endpointA === request.issuer_endpoint_id ? null : request.issuer_human_id,
        b_confirmed_by: endpointA === request.issuer_endpoint_id ? nominatedHumanId : request.issuer_human_id,
        revoked_at: null, home_relay: homeRelay, created_at: timestamp
      });
      return { link_id: linkId, status: 'pending' };
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `SIGIL_TEST_DATABASE_URL=<local pg url> node --test sigil/relay/v1/postgres-repository.directory-match.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sigil/relay/v1/postgres-repository.mjs sigil/cli/memory-repository.mjs sigil/relay/v1/postgres-repository.directory-match.test.mjs
git commit -m "feat(directory): OIDC match request create/claim/nominate in postgres and memory repositories"
```

---

## Task 5: Repository — link confirmation, revocation, and lookup

**Files:**
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Modify: `sigil/cli/memory-repository.mjs`
- Create: `sigil/relay/v1/postgres-repository.directory-links.test.mjs`

**Interfaces:**
- Consumes: `directoryLinks` map (Task 3/4, memory repo only).
- Produces: `repository.confirmDirectoryLink({ linkId, confirmingHumanId, now })` → `{ link_id, status }` or throws `CONFIRMATION_ACTOR_MISMATCH`; `repository.revokeDirectoryLink({ linkId, revokingHumanId, now })` → `{ link_id, status: 'revoked' }` or throws `LINK_UNAVAILABLE`; `repository.lookupActiveDirectoryLink(endpointIdA, endpointIdB, client)` → row or `null` (consumed by Task 6's accept-envelope enforcement — takes `client` as its 3rd/last positional arg matching `lookupActiveCapabilityGrants`'s no-default-pool convention, since it participates in the accept transaction).

- [ ] **Step 1: Write the failing test**

```javascript
// sigil/relay/v1/postgres-repository.directory-links.test.mjs
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

test('directory link confirmation, revocation, and lookup', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  const ids = { a: `usr_a_${suffix}`, b: `usr_b_${suffix}`, epA: `ep_a_${suffix}`, epB: `ep_b_${suffix}` };
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.a}', 'active', NOW()), ('${ids.b}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.epA}', '${ids.a}', 'claude', 'install_a', 'A', 'active', NOW()),
             ('${ids.epB}', '${ids.b}', 'codex', 'install_b', 'B', 'active', NOW());
  `);
  const repository = new PostgresRepository({ pool });
  const now = new Date('2026-08-21T00:00:00Z');
  const invite = await repository.createDirectoryInvite({ issuerEndpointId: ids.epA, issuerHumanId: ids.a, expiresAt: new Date(now.getTime() + 60 * 60 * 1000), homeRelay: 'relay.local', now });
  const { link_id: linkId } = await repository.redeemDirectoryInvite({ code: invite.code, redeemerEndpointId: ids.epB, redeemerHumanId: ids.b, homeRelay: 'relay.local', now });

  await assert.rejects(
    () => repository.confirmDirectoryLink({ linkId, confirmingHumanId: ids.b, now }),
    { code: 'CONFIRMATION_ACTOR_MISMATCH' }
  );

  const confirmed = await repository.confirmDirectoryLink({ linkId, confirmingHumanId: ids.a, now });
  assert.equal(confirmed.status, 'active');

  const noneBeforeConfirm = await pool.connect();
  try {
    const found = await repository.lookupActiveDirectoryLink(ids.epA, ids.epB, noneBeforeConfirm);
    assert.equal(found.link_id, linkId);
    const reversed = await repository.lookupActiveDirectoryLink(ids.epB, ids.epA, noneBeforeConfirm);
    assert.equal(reversed.link_id, linkId);
  } finally { noneBeforeConfirm.release(); }

  const revoked = await repository.revokeDirectoryLink({ linkId, revokingHumanId: ids.b, now });
  assert.equal(revoked.status, 'revoked');

  const afterRevoke = await pool.connect();
  try {
    const gone = await repository.lookupActiveDirectoryLink(ids.epA, ids.epB, afterRevoke);
    assert.equal(gone, null);
  } finally { afterRevoke.release(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SIGIL_TEST_DATABASE_URL=<local pg url> node --test sigil/relay/v1/postgres-repository.directory-links.test.mjs`
Expected: FAIL — methods don't exist yet.

- [ ] **Step 3: Implement in `postgres-repository.mjs`**

```javascript
  // Confirmation is actor-bound (spec §5): confirmingHumanId must equal
  // human_a or human_b of the row, never inferred from endpoint-key auth.
  async confirmDirectoryLink({ linkId, confirmingHumanId, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const current = await client.query('SELECT * FROM directory_links WHERE link_id = $1 FOR UPDATE', [linkId]);
      if (!current.rows[0]) throw Object.assign(new Error('Directory link not found'), { code: 'LINK_UNAVAILABLE' });
      const row = current.rows[0];
      if (row.status !== 'pending') return { link_id: linkId, status: row.status };
      if (confirmingHumanId !== row.human_a && confirmingHumanId !== row.human_b) {
        throw Object.assign(new Error('Confirming human is not a party to this link'), { code: 'CONFIRMATION_ACTOR_MISMATCH' });
      }
      const isA = confirmingHumanId === row.human_a;
      if (isA && row.a_confirmed_at) return { link_id: linkId, status: row.status };
      if (!isA && row.b_confirmed_at) return { link_id: linkId, status: row.status };
      const otherConfirmed = isA ? row.b_confirmed_at : row.a_confirmed_at;
      const nextStatus = otherConfirmed ? 'active' : 'pending';
      const result = await client.query(
        isA
          ? `UPDATE directory_links SET a_confirmed_at = $1, a_confirmed_by = $2, status = $3 WHERE link_id = $4 RETURNING link_id, status`
          : `UPDATE directory_links SET b_confirmed_at = $1, b_confirmed_by = $2, status = $3 WHERE link_id = $4 RETURNING link_id, status`,
        [timestamp, confirmingHumanId, nextStatus, linkId]
      );
      return result.rows[0];
    });
  }
  // Unilateral (spec §5): either party revokes without the other's consent.
  async revokeDirectoryLink({ linkId, revokingHumanId, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const current = await client.query('SELECT * FROM directory_links WHERE link_id = $1 FOR UPDATE', [linkId]);
      if (!current.rows[0]) throw Object.assign(new Error('Directory link not found'), { code: 'LINK_UNAVAILABLE' });
      const row = current.rows[0];
      if (row.status === 'revoked') return { link_id: linkId, status: 'revoked', duplicate: true };
      if (revokingHumanId !== row.human_a && revokingHumanId !== row.human_b) {
        throw Object.assign(new Error('Revoking human is not a party to this link'), { code: 'CONFIRMATION_ACTOR_MISMATCH' });
      }
      const result = await client.query(`UPDATE directory_links SET status = 'revoked', revoked_at = $1, revoked_by = $2 WHERE link_id = $3 RETURNING link_id, status`, [timestamp, revokingHumanId, linkId]);
      return { ...result.rows[0], duplicate: false };
    });
  }
  // No `client = this.pool` default -- same reasoning as
  // lookupActiveCapabilityGrants: this participates in accept-envelope's
  // transaction (Task 6) and must run on that transaction's client.
  async lookupActiveDirectoryLink(endpointIdA, endpointIdB, client) {
    const result = await client.query(
      `SELECT link_id, status FROM directory_links
       WHERE status = 'active' AND ((endpoint_a = $1 AND endpoint_b = $2) OR (endpoint_a = $2 AND endpoint_b = $1))`,
      [endpointIdA, endpointIdB]
    );
    return result.rows[0] ?? null;
  }
```

- [ ] **Step 4: Implement in `memory-repository.mjs`**

```javascript
    async confirmDirectoryLink({ linkId, confirmingHumanId, now = new Date() }) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const link = directoryLinks.get(linkId);
      if (!link) throw Object.assign(new Error('Directory link not found'), { code: 'LINK_UNAVAILABLE' });
      if (link.status !== 'pending') return { link_id: linkId, status: link.status };
      if (confirmingHumanId !== link.human_a && confirmingHumanId !== link.human_b) {
        throw Object.assign(new Error('Confirming human is not a party to this link'), { code: 'CONFIRMATION_ACTOR_MISMATCH' });
      }
      const isA = confirmingHumanId === link.human_a;
      if (isA && link.a_confirmed_at) return { link_id: linkId, status: link.status };
      if (!isA && link.b_confirmed_at) return { link_id: linkId, status: link.status };
      if (isA) { link.a_confirmed_at = timestamp; link.a_confirmed_by = confirmingHumanId; } else { link.b_confirmed_at = timestamp; link.b_confirmed_by = confirmingHumanId; }
      link.status = (link.a_confirmed_at && link.b_confirmed_at) ? 'active' : 'pending';
      return { link_id: linkId, status: link.status };
    },
    async revokeDirectoryLink({ linkId, revokingHumanId, now = new Date() }) {
      const link = directoryLinks.get(linkId);
      if (!link) throw Object.assign(new Error('Directory link not found'), { code: 'LINK_UNAVAILABLE' });
      if (link.status === 'revoked') return { link_id: linkId, status: 'revoked', duplicate: true };
      if (revokingHumanId !== link.human_a && revokingHumanId !== link.human_b) {
        throw Object.assign(new Error('Revoking human is not a party to this link'), { code: 'CONFIRMATION_ACTOR_MISMATCH' });
      }
      link.status = 'revoked'; link.revoked_at = (now instanceof Date ? now : new Date(now)).toISOString(); link.revoked_by = revokingHumanId;
      return { link_id: linkId, status: 'revoked', duplicate: false };
    },
    async lookupActiveDirectoryLink(endpointIdA, endpointIdB) {
      const found = [...directoryLinks.values()].find((l) => l.status === 'active' && ((l.endpoint_a === endpointIdA && l.endpoint_b === endpointIdB) || (l.endpoint_a === endpointIdB && l.endpoint_b === endpointIdA)));
      return found ? { link_id: found.link_id, status: found.status } : null;
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `SIGIL_TEST_DATABASE_URL=<local pg url> node --test sigil/relay/v1/postgres-repository.directory-links.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sigil/relay/v1/postgres-repository.mjs sigil/cli/memory-repository.mjs sigil/relay/v1/postgres-repository.directory-links.test.mjs
git commit -m "feat(directory): actor-bound confirmation, unilateral revocation, and active-link lookup"
```

---

## Task 6: Enforcement — gate direct envelope delivery on an active directory link

**Files:**
- Modify: `sigil/relay/v1/accept-envelope.mjs`
- Modify: `sigil/relay/v1/accept-envelope.test.mjs`

**Interfaces:**
- Consumes: `repository.lookupActiveDirectoryLink(endpointIdA, endpointIdB, client)` (Task 5).
- Produces: nothing new consumed by later tasks — this is the enforcement point itself (spec §8).

- [ ] **Step 1: Write the failing test**

Add to `sigil/relay/v1/accept-envelope.test.mjs`, after the existing `fakeTransactionalRepository` helper (extend it to support `lookupActiveDirectoryLink`, then add tests):

```javascript
test('direct envelope with no active directory link is rejected DIRECTORY_LINK_REQUIRED', async () => {
  const repository = fakeTransactionalRepository();
  repository.lookupActiveDirectoryLink = async () => null;
  repository.lookupActiveCapabilityGrants = async () => [];
  repository.lookupCapabilityRegistration = async () => null;
  repository.reserveRateLimit = async () => ({ count: 1, allowed: true });
  repository.countOpenDeliveries = async () => 0;
  repository.lookupAcceptedMessageId = async () => null;
  repository.lookupIdempotency = async () => null;
  repository.persistAcceptedEnvelope = async () => { throw new Error('must not persist a rejected envelope'); };
  const { acceptEnvelopeAsync } = await import('./accept-envelope.mjs');
  const result = await acceptEnvelopeAsync(envelope, { ...options, repository, idempotency: undefined });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'DIRECTORY_LINK_REQUIRED');
});

test('direct envelope with an active directory link is accepted', async () => {
  const repository = fakeTransactionalRepository();
  repository.lookupActiveDirectoryLink = async () => ({ link_id: 'link_1', status: 'active' });
  repository.lookupActiveCapabilityGrants = async () => [];
  repository.lookupCapabilityRegistration = async () => null;
  repository.reserveRateLimit = async () => ({ count: 1, allowed: true });
  repository.countOpenDeliveries = async () => 0;
  repository.lookupAcceptedMessageId = async () => null;
  repository.lookupIdempotency = async () => null;
  repository.persistAcceptedEnvelope = async () => ({ message_id: envelope.message_id, duplicate: false });
  const { acceptEnvelopeAsync } = await import('./accept-envelope.mjs');
  const result = await acceptEnvelopeAsync(envelope, { ...options, repository, idempotency: undefined });
  assert.equal(result.status, 202);
});

test('broadcast envelope (no recipient.endpoint_id) is never checked against directory_links', async () => {
  const repository = fakeTransactionalRepository();
  let called = false;
  repository.lookupActiveDirectoryLink = async () => { called = true; return null; };
  repository.lookupActiveCapabilityGrants = async () => [];
  repository.lookupCapabilityRegistration = async () => ({ capability: 'sigil.core/broadcast_message' });
  repository.reserveRateLimit = async () => ({ count: 1, allowed: true });
  repository.countOpenDeliveries = async () => 0;
  repository.lookupAcceptedMessageId = async () => null;
  repository.lookupIdempotency = async () => null;
  repository.persistAcceptedEnvelope = async () => ({ message_id: 'msg_broadcast', duplicate: false });
  const broadcastEnvelope = { ...envelope, recipient: undefined, broadcast_scope: { conversation_id: envelope.conversation_id }, capabilities: ['sigil.core/broadcast_message'] };
  const { acceptEnvelopeAsync } = await import('./accept-envelope.mjs');
  await acceptEnvelopeAsync(broadcastEnvelope, { ...options, repository, idempotency: undefined, broadcastAuthorizer: () => true });
  assert.equal(called, false);
});
```

- [ ] **Step 2: Run tests to verify the first two fail**

Run: `node --test sigil/relay/v1/accept-envelope.test.mjs`
Expected: the two new non-broadcast tests FAIL (envelope currently accepted regardless of directory link — no check exists yet); the broadcast test passes trivially (no code path calls the not-yet-existing method either way).

- [ ] **Step 3: Implement the check in `accept-envelope.mjs`**

Insert into `acceptWithRepository`, immediately after the existing inbox-depth-limit block (`if (envelope.recipient?.endpoint_id) { ... QUOTA_EXCEEDED ... }`) and before `const result = validateEnvelope(...)`:

```javascript
    // Directory-link gate (spec §8): a direct envelope (recipient.endpoint_id
    // set -- validateEnvelope's hasRecipient/hasBroadcast XOR guarantees a
    // broadcast envelope never reaches here) requires an active
    // directory_links row between sender and recipient. Broadcast delivery
    // is deliberately never checked here -- it's gated by conversation
    // membership instead (spec §8), which validateEnvelope's
    // broadcastAuthorizer already covers.
    if (envelope.recipient?.endpoint_id && repository.lookupActiveDirectoryLink) {
      const link = await repository.lookupActiveDirectoryLink(envelope.sender.endpoint_id, envelope.recipient.endpoint_id, client);
      if (!link) throw reject('DIRECTORY_LINK_REQUIRED', 'No active directory link between sender and recipient', { sender_endpoint_id: envelope.sender.endpoint_id, recipient_endpoint_id: envelope.recipient.endpoint_id });
    }
```

Add `'DIRECTORY_LINK_REQUIRED': 403` to the `statusByCode` map, and `'DIRECTORY_LINK_REQUIRED'` to `AUDITED_REJECTION_CODES` (both near the top of the file):

```javascript
const AUDITED_REJECTION_CODES = new Set(['CAPABILITY_DENIED', 'REPLAY_DETECTED', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'DIRECTORY_LINK_REQUIRED']);
```

```javascript
  QUOTA_EXCEEDED: 429,
  DIRECTORY_LINK_REQUIRED: 403
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test sigil/relay/v1/accept-envelope.test.mjs`
Expected: all PASS, including the pre-existing tests (the check is a no-op when `repository.lookupActiveDirectoryLink` is undefined, so the legacy no-repository path and any existing fake-repository tests that don't define it are unaffected).

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/accept-envelope.mjs sigil/relay/v1/accept-envelope.test.mjs
git commit -m "feat(directory): gate direct envelope delivery on an active directory link"
```

---

## Task 7: HTTP routes — invite, match, confirm, revoke

**Files:**
- Modify: `sigil/relay/v1/http-server.mjs`
- Modify: `sigil/relay/v1/http-server.test.mjs`

**Interfaces:**
- Consumes: `repository.createDirectoryInvite`, `.redeemDirectoryInvite` (Task 3); `.createDirectoryMatchRequest`, `.claimDirectoryMatch`, `.nominateDirectoryLinkEndpoint` (Task 4); `.confirmDirectoryLink`, `.revokeDirectoryLink` (Task 5); `boundedDirectoryExpiry` (Task 2, `auth-policy.mjs`); `assertAllowedIssuer` (existing `auth-policy.mjs`, reused as-is against a `Set` built from `oidc_issuer_allowlist` rows — see Step 3).
- Produces: `POST /v1/directory/invites`, `POST /v1/directory/invites/redeem`, `POST /v1/directory/matches`, `POST /v1/directory/matches/:requestId/nominate`, `POST /v1/directory/links/:linkId/confirm`, `POST /v1/directory/links/:linkId/revoke` — routes later exercised by Task 8's integration test.

- [ ] **Step 1: Write the failing tests**

Add to `sigil/relay/v1/http-server.test.mjs` (following the existing file's pattern of building a server with a fake `repository` object and issuing raw `http.request` calls — read the top of that file for the exact `startServer`/`request` test helpers already defined there and reuse them verbatim):

```javascript
test('POST /v1/directory/invites requires an authenticated human context', async () => {
  const { server, baseUrl } = await startServer({ authenticate: async () => ({ endpoint_id: 'ep_a' }) });
  try {
    const response = await request(baseUrl, 'POST', '/v1/directory/invites', {});
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'HUMAN_CONTEXT_REQUIRED');
  } finally { server.close(); }
});

test('POST /v1/directory/invites issues a code once', async () => {
  const repository = { createDirectoryInvite: async () => ({ invite_id: 'invite_1', code: 'plaintext-code', expires_at: '2026-08-22T00:00:00Z' }), recordAuditEvent: async () => {} };
  const { server, baseUrl } = await startServer({ authenticate: async () => ({ endpoint_id: 'ep_a', human_id: 'usr_a' }), repository, relayOrigin: 'https://relay.local' });
  try {
    const response = await request(baseUrl, 'POST', '/v1/directory/invites', {});
    assert.equal(response.status, 201);
    assert.equal(response.body.code, 'OK');
    assert.equal(response.body.invite.code, 'plaintext-code');
  } finally { server.close(); }
});

test('POST /v1/directory/invites/redeem maps INVITE_UNAVAILABLE to a generic 404', async () => {
  const repository = { redeemDirectoryInvite: async () => { throw Object.assign(new Error('Invite code is invalid or expired'), { code: 'INVITE_UNAVAILABLE' }); } };
  const { server, baseUrl } = await startServer({ authenticate: async () => ({ endpoint_id: 'ep_b', human_id: 'usr_b' }), repository });
  try {
    const response = await request(baseUrl, 'POST', '/v1/directory/invites/redeem', { code: 'wrong' });
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'INVITE_UNAVAILABLE');
  } finally { server.close(); }
});

test('POST /v1/directory/links/:linkId/confirm requires human context and forwards actor mismatch', async () => {
  const repository = { confirmDirectoryLink: async () => { throw Object.assign(new Error('Confirming human is not a party to this link'), { code: 'CONFIRMATION_ACTOR_MISMATCH' }); } };
  const { server, baseUrl } = await startServer({ authenticate: async () => ({ endpoint_id: 'ep_c', human_id: 'usr_c' }), repository });
  try {
    const response = await request(baseUrl, 'POST', '/v1/directory/links/link_1/confirm', {});
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'CONFIRMATION_ACTOR_MISMATCH');
  } finally { server.close(); }
});

test('POST /v1/directory/links/:linkId/revoke succeeds for either party', async () => {
  const repository = { revokeDirectoryLink: async () => ({ link_id: 'link_1', status: 'revoked' }), recordAuditEvent: async () => {} };
  const { server, baseUrl } = await startServer({ authenticate: async () => ({ endpoint_id: 'ep_a', human_id: 'usr_a' }), repository });
  try {
    const response = await request(baseUrl, 'POST', '/v1/directory/links/link_1/revoke', {});
    assert.equal(response.status, 200);
    assert.equal(response.body.link.status, 'revoked');
  } finally { server.close(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test sigil/relay/v1/http-server.test.mjs`
Expected: FAIL — routes return 404 `CONTEXT_NOT_FOUND` (fall through to the existing default handler).

- [ ] **Step 3: Implement the routes in `http-server.mjs`**

Add `import { boundedDirectoryExpiry } from './auth-policy.mjs';` alongside the existing `auth-policy.mjs` import line, and insert the following route block right before the final `response.writeHead(404, ...)` fallback at the bottom of the handler function:

```javascript
    if (request.method === 'POST' && request.url === '/v1/directory/invites') {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      if (!repository?.createDirectoryInvite) return response.writeHead(503).end();
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body = {}; if (raw) { try { body = JSON.parse(raw); } catch { body = {}; } }
      try {
        const expiresAt = boundedDirectoryExpiry({ now, expiresAt: body.expires_at });
        const invite = await repository.createDirectoryInvite({ issuerEndpointId: principal.endpoint_id, issuerHumanId: principal.human_id, expiresAt, homeRelay: resolveRelayOrigin() ?? 'local', now });
        await repository.recordAuditEvent?.({ eventType: 'directory_invite.created', subjectId: invite.invite_id, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'directory_invite', objectId: invite.invite_id, outcome: 'success', now });
        response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', invite }));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'DIRECTORY_EXPIRY_INVALID', message: error.message, details: {} }));
      }
    }
    if (request.method === 'POST' && request.url === '/v1/directory/invites/redeem') {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      if (!repository?.redeemDirectoryInvite) return response.writeHead(503).end();
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body?.code) { response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'code is required', details: {} })); }
      try {
        const link = await repository.redeemDirectoryInvite({ code: body.code, redeemerEndpointId: principal.endpoint_id, redeemerHumanId: principal.human_id, homeRelay: resolveRelayOrigin() ?? 'local', now });
        await repository.recordAuditEvent?.({ eventType: 'directory_link.created', subjectId: link.link_id, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'directory_link', objectId: link.link_id, outcome: 'success', now });
        response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', link }));
      } catch (error) {
        // spec §3.1.4: one generic error for wrong/expired/revoked/unknown --
        // 404 with the same INVITE_UNAVAILABLE code regardless of which.
        response.writeHead(error.code === 'DIRECTORY_LINK_CONFLICT' ? 409 : 404, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'INVITE_UNAVAILABLE', message: error.code === 'DIRECTORY_LINK_CONFLICT' ? error.message : 'Invite code is invalid or expired', details: {} }));
      }
    }
    if (request.method === 'POST' && request.url === '/v1/directory/matches') {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      if (!repository?.createDirectoryMatchRequest) return response.writeHead(503).end();
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body?.issuer || !body?.match_target) { response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'issuer and match_target are required', details: {} })); }
      const normalizedMatch = normalizeIssuerOrRespond(body.issuer, response, requestId);
      if (normalizedMatch.error) return;
      try { assertAllowedIssuer(normalizedMatch.issuer, oidcIssuerAllowList); } catch (error) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      try {
        const expiresAt = boundedDirectoryExpiry({ now, expiresAt: body.expires_at });
        const match = await repository.createDirectoryMatchRequest({ issuerEndpointId: principal.endpoint_id, issuerHumanId: principal.human_id, issuer: normalizedMatch.issuer, matchTarget: body.match_target, expiresAt, homeRelay: resolveRelayOrigin() ?? 'local', now });
        await repository.recordAuditEvent?.({ eventType: 'directory_match_request.created', subjectId: match.request_id, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'directory_match_request', objectId: match.request_id, outcome: 'success', now });
        response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', match }));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'DIRECTORY_EXPIRY_INVALID', message: error.message, details: {} }));
      }
    }
    const nominateMatch = request.url.match(/^\/v1\/directory\/matches\/([^/]+)\/nominate$/);
    if (request.method === 'POST' && nominateMatch) {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      const [, requestIdParam] = nominateMatch;
      if (!repository?.nominateDirectoryLinkEndpoint) return response.writeHead(503).end();
      try {
        const link = await repository.nominateDirectoryLinkEndpoint({ requestId: requestIdParam, nominatedEndpointId: principal.endpoint_id, nominatedHumanId: principal.human_id, homeRelay: resolveRelayOrigin() ?? 'local', now });
        await repository.recordAuditEvent?.({ eventType: 'directory_link.created', subjectId: link.link_id, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'directory_link', objectId: link.link_id, outcome: 'success', now });
        response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', link }));
      } catch (error) {
        response.writeHead(error.code === 'DIRECTORY_LINK_CONFLICT' ? 409 : 404, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'MATCH_UNAVAILABLE', message: error.message, details: {} }));
      }
    }
    const confirmMatch = request.url.match(/^\/v1\/directory\/links\/([^/]+)\/confirm$/);
    if (request.method === 'POST' && confirmMatch) {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      const [, linkId] = confirmMatch;
      if (!repository?.confirmDirectoryLink) return response.writeHead(503).end();
      try {
        const link = await repository.confirmDirectoryLink({ linkId, confirmingHumanId: principal.human_id, now });
        if (link.status === 'active') await repository.recordAuditEvent?.({ eventType: 'directory_link.activated', subjectId: linkId, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'directory_link', objectId: linkId, outcome: 'success', now });
        else await repository.recordAuditEvent?.({ eventType: 'directory_link.confirmed', subjectId: linkId, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'directory_link', objectId: linkId, outcome: 'success', now });
        response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', link }));
      } catch (error) {
        response.writeHead(error.code === 'LINK_UNAVAILABLE' ? 404 : 403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'LINK_UNAVAILABLE', message: error.message, details: {} }));
      }
    }
    const revokeMatch = request.url.match(/^\/v1\/directory\/links\/([^/]+)\/revoke$/);
    if (request.method === 'POST' && revokeMatch) {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      const [, linkId] = revokeMatch;
      if (!repository?.revokeDirectoryLink) return response.writeHead(503).end();
      try {
        const link = await repository.revokeDirectoryLink({ linkId, revokingHumanId: principal.human_id, now });
        if (!link.duplicate) await repository.recordAuditEvent?.({ eventType: 'directory_link.revoked', subjectId: linkId, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'directory_link', objectId: linkId, outcome: 'success', now });
        response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', link }));
      } catch (error) {
        response.writeHead(error.code === 'LINK_UNAVAILABLE' ? 404 : 403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'LINK_UNAVAILABLE', message: error.message, details: {} }));
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test sigil/relay/v1/http-server.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/http-server.mjs sigil/relay/v1/http-server.test.mjs
git commit -m "feat(directory): HTTP routes for invite/match/confirm/revoke"
```

---

## Task 8: Rate limiting on directory routes

**Files:**
- Modify: `sigil/relay/v1/http-server.mjs`
- Modify: `sigil/relay/v1/http-server.test.mjs`

**Interfaces:**
- Consumes: `resolveDirectoryRateLimits` (Task 2, `relay-config.mjs`); `repository.reserveRateLimit(scopeKind, scopeId, windowStart, limit, client)` (existing, unchanged signature — Task 1's migration widened the `scope_kind` CHECK to accept the four new values already).

- [ ] **Step 1: Write the failing test**

Add to `sigil/relay/v1/http-server.test.mjs`:

```javascript
test('POST /v1/directory/invites is rate-limited per issuing endpoint/human', async () => {
  const reservations = [];
  const repository = {
    createDirectoryInvite: async () => ({ invite_id: 'invite_1', code: 'x', expires_at: '2026-08-22T00:00:00Z' }),
    reserveRateLimit: async (scopeKind, scopeId) => { reservations.push({ scopeKind, scopeId }); return { count: 21, allowed: false }; },
    recordAuditEvent: async () => {}
  };
  const { server, baseUrl } = await startServer({ authenticate: async () => ({ endpoint_id: 'ep_a', human_id: 'usr_a' }), repository });
  try {
    const response = await request(baseUrl, 'POST', '/v1/directory/invites', {});
    assert.equal(response.status, 429);
    assert.equal(response.body.code, 'RATE_LIMITED');
    assert.equal(reservations[0].scopeKind, 'directory_invite_create');
  } finally { server.close(); }
});

test('POST /v1/directory/invites/redeem consumes quota on a guessed (invalid) code, not on infra failure', async () => {
  const reservations = [];
  const repository = {
    reserveRateLimit: async (scopeKind, scopeId) => { reservations.push({ scopeKind, scopeId }); return { count: 1, allowed: true }; },
    redeemDirectoryInvite: async () => { throw Object.assign(new Error('Invite code is invalid or expired'), { code: 'INVITE_UNAVAILABLE' }); }
  };
  const { server, baseUrl } = await startServer({ authenticate: async () => ({ endpoint_id: 'ep_b', human_id: 'usr_b' }), repository });
  try {
    await request(baseUrl, 'POST', '/v1/directory/invites/redeem', { code: 'guess' });
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0].scopeKind, 'directory_invite_redeem');
  } finally { server.close(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test sigil/relay/v1/http-server.test.mjs`
Expected: FAIL — routes don't call `reserveRateLimit` yet.

- [ ] **Step 3: Wire rate-limit reservations into the four creation/redemption routes**

Add `import { resolveDirectoryRateLimits } from './relay-config.mjs';` to `http-server.mjs`'s imports, and a shared helper near the top of `createRelayServer` (alongside `recordAttemptAndCheckLimit`):

```javascript
  async function reserveDirectoryQuota(scopeKind, scopeId, nowMsValue) {
    if (!repository?.reserveRateLimit) return { allowed: true };
    const limits = resolveDirectoryRateLimits();
    const windowStart = new Date(Math.floor(nowMsValue / 60_000) * 60_000).toISOString();
    return repository.reserveRateLimit(scopeKind, scopeId, windowStart, limits[scopeKind]);
  }
```

In each of the four route handlers from Task 7, add a reservation check immediately after the `HUMAN_CONTEXT_REQUIRED`/`repository?.<method>` guards and before reading the request body:

`POST /v1/directory/invites` (scope `directory_invite_create`, id `principal.human_id`):
```javascript
      const inviteQuota = await reserveDirectoryQuota('directory_invite_create', principal.human_id, nowMs);
      if (!inviteQuota.allowed) { response.writeHead(429, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'RATE_LIMITED', message: 'directory_invite_create rate limit exceeded', details: {} })); }
```

`POST /v1/directory/invites/redeem` (scope `directory_invite_redeem`, id `principal.human_id` — reserved unconditionally, before the redeem attempt, so a guessed code still consumes quota per spec §6; the reservation happens whether or not the subsequent redeem call throws):
```javascript
      const redeemQuota = await reserveDirectoryQuota('directory_invite_redeem', principal.human_id, nowMs);
      if (!redeemQuota.allowed) { response.writeHead(429, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'RATE_LIMITED', message: 'directory_invite_redeem rate limit exceeded', details: {} })); }
```

`POST /v1/directory/matches` (scope `directory_match_create`, id `principal.human_id`):
```javascript
      const matchQuota = await reserveDirectoryQuota('directory_match_create', principal.human_id, nowMs);
      if (!matchQuota.allowed) { response.writeHead(429, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'RATE_LIMITED', message: 'directory_match_create rate limit exceeded', details: {} })); }
```

`POST /v1/directory/matches/:requestId/nominate` (scope `directory_match_attempt`, id `` `${requestIdParam}:${principal.human_id}` `` — spec §6: "scoped per pending match request *and* per requesting human"):
```javascript
      const nominateQuota = await reserveDirectoryQuota('directory_match_attempt', `${requestIdParam}:${principal.human_id}`, nowMs);
      if (!nominateQuota.allowed) { response.writeHead(429, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'RATE_LIMITED', message: 'directory_match_attempt rate limit exceeded', details: {} })); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test sigil/relay/v1/http-server.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/http-server.mjs sigil/relay/v1/http-server.test.mjs
git commit -m "feat(directory): dedicated rate-limit scopes for invite/match create and redeem/attempt"
```

---

## Task 9: Live PostgreSQL end-to-end test + vertical-slice integration scenario

**Files:**
- Modify: `sigil/integration/vertical-slice.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–8 — this is the full-stack proof, following the existing vertical-slice file's pattern of spinning up a real `createRelayServer` backed by a real `PostgresRepository` against `SIGIL_TEST_DATABASE_URL` and driving it over real HTTP.

- [ ] **Step 1: Read the existing vertical-slice test's server-bootstrap helper**

Open `sigil/integration/vertical-slice.test.mjs` and note how it constructs `createRelayServer` with a live `PostgresRepository`, registers two endpoints/humans, and issues real bearer tokens — reuse that exact setup rather than re-deriving it.

- [ ] **Step 2: Write the failing end-to-end scenario**

Append to `sigil/integration/vertical-slice.test.mjs`, following the file's existing test structure (adjust variable names to match whatever the existing bootstrap helper is actually called there):

```javascript
test('directory trust: invite issued, redeemed, confirmed, then direct delivery succeeds; revocation blocks it again', { skip: !connectionString }, async (t) => {
  const { baseUrl, server, pool, ids, tokenFor } = await bootstrapLiveRelay(t); // reuse existing helper
  t.after(() => server.close());

  const inviteResponse = await fetch(`${baseUrl}/v1/directory/invites`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(ids.epA)}` }, body: '{}' });
  assert.equal(inviteResponse.status, 201);
  const { invite } = await inviteResponse.json();

  const redeemResponse = await fetch(`${baseUrl}/v1/directory/invites/redeem`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(ids.epB)}` }, body: JSON.stringify({ code: invite.code }) });
  assert.equal(redeemResponse.status, 201);
  const { link } = await redeemResponse.json();
  assert.equal(link.status, 'pending');

  const preConfirmDelivery = await fetch(`${baseUrl}/v1/envelopes`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(ids.epA)}` }, body: JSON.stringify(buildDirectEnvelope({ from: ids.epA, to: ids.epB })) });
  assert.equal(preConfirmDelivery.status, 403);
  const preConfirmBody = await preConfirmDelivery.json();
  assert.equal(preConfirmBody.code, 'DIRECTORY_LINK_REQUIRED');

  const confirmResponse = await fetch(`${baseUrl}/v1/directory/links/${link.link_id}/confirm`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(ids.epA)}` }, body: '{}' });
  assert.equal(confirmResponse.status, 200);
  const { link: activated } = await confirmResponse.json();
  assert.equal(activated.status, 'active');

  const postConfirmDelivery = await fetch(`${baseUrl}/v1/envelopes`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(ids.epA)}` }, body: JSON.stringify(buildDirectEnvelope({ from: ids.epA, to: ids.epB })) });
  assert.equal(postConfirmDelivery.status, 202);

  const revokeResponse = await fetch(`${baseUrl}/v1/directory/links/${link.link_id}/revoke`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(ids.epB)}` }, body: '{}' });
  assert.equal(revokeResponse.status, 200);

  const postRevokeDelivery = await fetch(`${baseUrl}/v1/envelopes`, { method: 'POST', headers: { authorization: `Bearer ${tokenFor(ids.epA)}` }, body: JSON.stringify(buildDirectEnvelope({ from: ids.epA, to: ids.epB })) });
  assert.equal(postRevokeDelivery.status, 403);
});
```

If the file has no `buildDirectEnvelope` helper yet, add one near its top (mirroring the shape of the envelope fixture already used elsewhere in this file — same `sender`/`recipient`/`body`/`signature` fields, freshly signed with the caller's known-good test keypair for `from`):

```javascript
function buildDirectEnvelope({ from, to }) {
  // Mirrors the envelope shape already built elsewhere in this file --
  // adjust field names here only if the existing local helper differs.
  return {
    message_id: `msg_${crypto.randomUUID()}`,
    conversation_id: `conv_${crypto.randomUUID()}`,
    protocol: 'sigil/1',
    message_type: 'chat.message',
    sender: { endpoint_id: from, owner_id: ids.a },
    recipient: { endpoint_id: to },
    body: { text: 'hello' },
    context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: `send_${crypto.randomUUID()}`,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    created_at: new Date().toISOString(),
    signature: { algorithm: 'Ed25519', key_id: 'placeholder', value: 'placeholder' }
  };
}
```

Note: this plan's step deliberately leaves envelope signing as "reuse the existing signing helper already present in this file" rather than re-specifying `crypto.sign` here — the executing engineer should locate and reuse it (search the file for `crypto.sign(null,` ) so the test envelope is actually verifiable, not just shaped correctly.

- [ ] **Step 3: Run to verify it fails, then implement any gaps found**

Run: `SIGIL_TEST_DATABASE_URL=<local pg url> node --test sigil/integration/vertical-slice.test.mjs`
Expected: FAIL initially only if this step surfaces an integration gap between Tasks 1–8 (e.g. a field-name mismatch between the fake-repository tests and the real `PostgresRepository` methods) — fix any such gap in the relevant Task's file, not in this test. If Tasks 1–8 were implemented as specified, this test should PASS on the first run once the envelope-building/signing details above are filled in correctly for this repo's actual fixture helpers.

- [ ] **Step 4: Run full test suite**

Run: `npm test && npm run test:live`
Expected: all pass, including every test from Tasks 1–9.

- [ ] **Step 5: Commit**

```bash
git add sigil/integration/vertical-slice.test.mjs
git commit -m "test(integration): end-to-end directory trust — invite, confirm, deliver, revoke"
```

---

## Self-Review Notes (for the executing engineer)

- Spec §3.3 (`oidc_issuer_allowlist` as an admin-manageable table) is implemented as a table in Task 1 and read by Task 7's `POST /v1/directory/matches` via the existing `assertAllowedIssuer(issuer, oidcIssuerAllowList)` helper, which currently takes an in-memory `Set` (`createRelayServer`'s `oidcIssuerAllowList` param), not a DB query. This plan does **not** add a `repository.isOidcIssuerAllowed` DB-backed check — it reuses the existing Set-based mechanism as-is, consistent with how every other OIDC route in `http-server.mjs` already does it. If a deployment wants the DB table to be the actual source of truth (not just an audit record of what's been approved), that's a follow-up task, not part of this plan: flag it to the user rather than silently expanding scope here.
- Spec §7's "expired rows transition lazily and atomically" is satisfied by every read query in Tasks 3–5 filtering `status = 'pending' AND expires_at > $now` inline, rather than a separate sweep — no additional task needed.
- Spec §2's non-goal ("A UI... CLI/connector UX... is implementation detail") means this plan deliberately does not touch `sigil/cli/sigil.mjs`. If CLI commands for `sigil directory invite`/`sigil directory redeem` are wanted, that's a separate follow-up plan.
