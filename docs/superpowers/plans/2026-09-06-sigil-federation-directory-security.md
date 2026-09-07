# Sigil cross-federation directory — security hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four verified security defects (B1 same-owner exemption bypass, B2/E2 unpinned owner-id domains, B3 missing relay-request replay defense) and the Q4 plaintext-invite-code leak on the `feat/cross-federation-directory` branch, before re-review and branch finish.

**Architecture:** All schema changes land in one new migration `019`, additive except two deliberate CHECK-constraint replacements on the empty `federation_directory_links` table. The same-owner delivery exemption is deleted so every federated delivery needs a `federation_directory_links` row (a self-pair row for same-owner traffic). Owner-id domains are pinned on both the redemption handler and the CLI redeemer side. Replay defense adds a `nonce` + `signed_at` to every relay-to-relay signed body: `verifyInboundRelayRequest` enforces a freshness window and nonce format; each handler consumes the nonce inside its own transaction against a `federation_relay_nonces` uniqueness table. Redemption loses durable outbox retry entirely (its body carries the secret invite code); confirmation and revocation keep durable retry but store only `{ link_ref }` and rebuild the signed request each reaper pass.

**Tech Stack:** Node.js (ESM, `node:test`), PostgreSQL 13+, `pg`, Ed25519 via `node:crypto`, JCS canonicalization (`jcs.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-06-sigil-federation-directory-security-design.md` (revision 2, commit `6d0647b`, APPROVED). The plan argues from the spec; executors read both.

## Global Constraints

- Branch: `feat/cross-federation-directory`, off `main` `b11dfc3`. **Do not push.** Integration happens through `superpowers:finishing-a-development-branch` after a re-review of `b11dfc3..HEAD`.
- Baseline before work starts: `node --test` green at **812 pass / 0 fail / 103 skip**; live-DB suite (with `SIGIL_TEST_DATABASE_URL` set) **112 pass**. Every task must keep the non-DB suite green and never reduce the pass count except where this plan explicitly moves or rewrites a named test.
- Migration 018 is **not amended**. All schema changes go in `sigil/migrations/019_federation_directory_security.sql`.
- `019` is additive except for two CHECK-constraint replacements on `federation_directory_links`; the table is empty on this branch (verify with `SELECT count(*) FROM federation_directory_links` → 0 before implementing and again before re-review).
- Nonce format is normative: exactly 16 random bytes, base64url, 22 chars, no padding. Validation regex `^[A-Za-z0-9_-]{22}$`.
- Freshness window config key: `relayRequestFreshnessMs`, default `300_000`, clamped to `[60_000, 3_600_000]` at load.
- Federation is pre-GA and every relay runs this same codebase: the `nonce` / `signed_at` cutover is hard. No transitional tolerance — a peer that omits either field is rejected.
- TDD is mandatory on this branch: every blocker gets a failing test that proves the exploit (or the gap) before the fix.
- Live-DB / Postgres-only tests gate with `{ skip: !process.env.SIGIL_TEST_DATABASE_URL }` and run migrations via `applyMigrations(connectionString, { reset: true })` from `sigil/scripts/apply-migrations.mjs`.
- Run the full suite with a hard timeout per the repo protocol: `timeout 600 node --test` (never bare).
- Commit style: Conventional Commits, `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer. Test-only commits get a `test:` prefix.

---

## File Structure

**New files**

- `sigil/migrations/019_federation_directory_security.sql` — `federation_relay_nonces` table + index; the two `federation_directory_links` CHECK replacements behind `DO`-block name assertions; the pre-019 `directory_redemption` row secret scrub.
- `sigil/relay/v1/relay-request-freshness.test.mjs` — unit tests for the freshness clamp helper (kept out of `relay-config.test.mjs` so that file's `deepEqual` snapshots stay untouched).

**Modified files (responsibility of the change)**

- `sigil/relay/v1/relay-config.mjs` — add `DEFAULT_RELAY_REQUEST_FRESHNESS_MS` and `resolveRelayRequestFreshnessMs(raw)` (clamp + return effective value).
- `sigil/relay/v1/federation-relay-auth.mjs` — after the signature check, enforce `signed_at` freshness and `nonce` format; return `nonce` and `signedAtMs`; accept `{ now, freshnessMs }`.
- `sigil/relay/v1/federation-directory-client.mjs` — the three builders emit `nonce` + `signed_at`, drop `requested_at` / `confirmed_at` / `revoked_at`; new exported pure `assertIssuerResponseIdentity(issuer, issuerDomain)`.
- `sigil/relay/v1/federation-router.mjs` — `buildForwardRequest` emits `nonce` + `signed_at`, drops `forwarded_at`.
- `sigil/relay/v1/accept-federation-directory.mjs` — pin `redeemer.owner_id` domain to `originDomain`; read `signed_at` where `confirmed_at` / `revoked_at` were read; set `initiated_via` for a self-pair.
- `sigil/relay/v1/accept-federated-envelope.mjs` — remove the same-owner exemption branch; consume the nonce as the first statement in the transaction; add `RELAY_REPLAYED: 409` to the catch classifier.
- `sigil/relay/v1/http-server.mjs` — thread `now` + `freshnessMs` into the directory `verifyInboundRelayRequest` call; consume the nonce inside the directory transaction; map `RELAY_REPLAYED` → 409; pass `relayRequestFreshnessMs` through `createRelayServer` options.
- `sigil/relay/v1/federation-reaper.mjs` — rebuild `directory_confirmation` / `directory_revocation` rows through the builders each pass; delete the `directory_redemption` path, `writeRedeemerLink`, and the `PATH_BY_KIND.directory_redemption` key; update the module header comment.
- `sigil/relay/v1/postgres-repository.mjs` — `consumeRelayNonce`, `pruneRelayNonces`; `initiatedVia` column in `createFederationDirectoryLink`.
- `sigil/cli/memory-repository.mjs` — `Map`-backed `consumeRelayNonce` throwing the same `RELAY_REPLAYED`; `initiatedVia` accepted (and defaulted) in `createFederationDirectoryLink`.
- `sigil/cli/sigil.mjs` — call `assertIssuerResponseIdentity` in `cmdFederationInviteRedeem` with a rejection audit; strip `directoryPayload` in `cmdFederationOutbox` `show`; set `initiatedVia: 'self_pair'` when issuer owner equals redeemer owner; delete the `directory_redemption` `enqueueFederationForward` branch and print the re-run message.
- `STATUS.md` — make the replay claim accurate.
- Test files per each task below, plus the timestamp-field test moves called out in Task 5.

---

## Task 1: Migration 019 — nonce table + CHECK replacements + redemption-row scrub

**Files:**
- Create: `sigil/migrations/019_federation_directory_security.sql`
- Test: `sigil/relay/v1/postgres-repository.migration-019.test.mjs` (new)

**Interfaces:**
- Consumes: migration 018's `federation_directory_links` (constraints `federation_directory_links_distinct_owners`, `federation_directory_links_initiated_via_check`), `federation_outbox` (`kind`, `directory_payload`).
- Produces: table `federation_relay_nonces (nonce TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL)` + index `federation_relay_nonces_expires_at_idx`; relaxed CHECK `federation_directory_links_initiated_via_check` allowing `'self_pair'`; relaxed CHECK `federation_directory_links_distinct_owners` allowing equal owners only when `initiated_via = 'self_pair'`.

- [ ] **Step 1: Write the failing test**

Create `sigil/relay/v1/postgres-repository.migration-019.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('019 applies clean, is a no-op on re-run, and creates federation_relay_nonces', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await applyMigrations(connectionString, { reset: true });
  await applyMigrations(connectionString); // re-run must be a no-op

  const cols = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'federation_relay_nonces' ORDER BY column_name`,
  );
  assert.deepEqual(cols.rows.map((r) => r.column_name), ['expires_at', 'nonce']);

  await pool.query(`INSERT INTO federation_relay_nonces (nonce, expires_at) VALUES ('n-dup', now() + interval '5 min')`);
  await assert.rejects(
    pool.query(`INSERT INTO federation_relay_nonces (nonce, expires_at) VALUES ('n-dup', now() + interval '5 min')`),
    /duplicate key/i,
  );
});

test('019 relaxes distinct_owners to permit a self_pair row and still rejects an equal-owner non-self_pair row', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await applyMigrations(connectionString, { reset: true });

  // self_pair row with equal owners is accepted
  await pool.query(`INSERT INTO federation_directory_links
    (id, link_ref, local_owner_id, local_endpoint_id, remote_owner_id, remote_endpoint_id,
     remote_domain, role, initiated_via, status, peer_domain, created_at, updated_at)
    VALUES (gen_random_uuid(), gen_random_uuid(), 'usr_x@home.example', 'ep_a@home.example',
            'usr_x@home.example', 'ep_b@home.example', 'a.example', 'issuer', 'self_pair', 'active',
            'a.example', now(), now())`);

  // equal owners without self_pair is still rejected by the CHECK
  await assert.rejects(
    pool.query(`INSERT INTO federation_directory_links
      (id, link_ref, local_owner_id, local_endpoint_id, remote_owner_id, remote_endpoint_id,
       remote_domain, role, initiated_via, status, peer_domain, created_at, updated_at)
      VALUES (gen_random_uuid(), gen_random_uuid(), 'usr_y@home.example', 'ep_a@home.example',
              'usr_y@home.example', 'ep_b@home.example', 'a.example', 'issuer', 'invite', 'active',
              'a.example', now(), now())`),
    /distinct_owners/i,
  );
});

test('019 scrubs the plaintext code from a pre-019 directory_redemption outbox row', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await applyMigrations(connectionString, { reset: true }); // brings schema to 018-equivalent+
  // Seed a redemption row carrying the secret, as an earlier build would have.
  const ref = (await pool.query(`SELECT gen_random_uuid() AS u`)).rows[0].u;
  await pool.query(
    `INSERT INTO federation_outbox (id, kind, message_id, idempotency_key, recipient_domain, origin_domain, directory_payload, state, attempt_count, next_attempt_at, created_at, updated_at)
     VALUES (gen_random_uuid(), 'directory_redemption', $1, $1, 'a.example', 'b.example',
             $2::jsonb, 'pending', 0, now(), now(), now())`,
    [ref, JSON.stringify({ link_ref: ref, code: 'sigil-fed-invite:a.example:' + ref + ':SECRETSEG', redeemer: { owner_id: 'usr_b@b.example', endpoint_id: 'ep_c@b.example' } })],
  );
  await applyMigrations(connectionString); // 019 runs its scrub UPDATE
  const row = await pool.query(`SELECT directory_payload FROM federation_outbox WHERE message_id = $1`, [ref]);
  assert.equal(row.rows[0].directory_payload.code, undefined, 'the code key must be gone');
  assert.equal(row.rows[0].directory_payload.link_ref, ref, 'the rest of the payload is untouched');
});
```

> Note: the exact `federation_outbox` column list for the seed insert must match migration `017` + `018`. Before writing the seed, run `\d federation_outbox` against the test DB (or read `sigil/migrations/017_*.sql`) and adjust the column names/order in the `INSERT` to match. Do **not** invent columns.

- [ ] **Step 2: Run test to verify it fails**

Run: `SIGIL_TEST_DATABASE_URL=$SIGIL_TEST_DATABASE_URL timeout 300 node --test sigil/relay/v1/postgres-repository.migration-019.test.mjs`
Expected: FAIL — `applyMigrations` errors because `019_federation_directory_security.sql` does not exist, or the `federation_relay_nonces` assertions fail.

- [ ] **Step 3: Write the migration**

Create `sigil/migrations/019_federation_directory_security.sql`:

```sql
-- sigil/migrations/019_federation_directory_security.sql
-- Sub-project #4 security hardening -- design
-- docs/superpowers/specs/2026-09-06-sigil-federation-directory-security-design.md.
-- Additive EXCEPT two deliberate CHECK-constraint replacements on
-- federation_directory_links. That table is empty on this branch, so the
-- ADD CONSTRAINT validation scan carries no lock or backfill cost.

-- 1. Relay-to-relay request replay guard. Mirrors login_jti_replays
--    (migrations 013 / 015): a PRIMARY KEY uniqueness violation on a second
--    insert of the same nonce is mapped to RELAY_REPLAYED in the repository.
CREATE TABLE IF NOT EXISTS federation_relay_nonces (
  nonce      TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS federation_relay_nonces_expires_at_idx
  ON federation_relay_nonces (expires_at);

-- 2. CHECK-constraint replacements. Fail loudly if 018's constraint names are
--    not what this migration expects, rather than letting a silent
--    DROP ... IF EXISTS no-op leave a stale constraint in place.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'federation_directory_links_distinct_owners') THEN
    RAISE EXCEPTION 'migration 019: expected constraint federation_directory_links_distinct_owners not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'federation_directory_links_initiated_via_check') THEN
    RAISE EXCEPTION 'migration 019: expected constraint federation_directory_links_initiated_via_check not found';
  END IF;
END $$;

ALTER TABLE federation_directory_links
  DROP CONSTRAINT federation_directory_links_initiated_via_check;
ALTER TABLE federation_directory_links
  ADD CONSTRAINT federation_directory_links_initiated_via_check
  CHECK (initiated_via IN ('invite', 'oidc_match', 'self_pair'));

ALTER TABLE federation_directory_links
  DROP CONSTRAINT federation_directory_links_distinct_owners;
ALTER TABLE federation_directory_links
  ADD CONSTRAINT federation_directory_links_distinct_owners
  CHECK (local_owner_id <> remote_owner_id OR initiated_via = 'self_pair');

-- 3. Scrub the plaintext invite code from any pre-019 directory_redemption
--    outbox row. This branch is unpushed and pre-GA, so in practice this only
--    affects local dev databases. The rows are left to dead-letter and the
--    operator re-runs the redeem command (design Section 4).
UPDATE federation_outbox
   SET directory_payload = directory_payload - 'code'
 WHERE kind = 'directory_redemption'
   AND directory_payload ? 'code';

DO $$
DECLARE remaining INT;
BEGIN
  SELECT count(*) INTO remaining FROM federation_outbox WHERE kind = 'directory_redemption';
  IF remaining > 0 THEN
    RAISE NOTICE 'migration 019: % directory_redemption outbox row(s) present; operators must re-run those redemptions after upgrade', remaining;
  END IF;
END $$;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `SIGIL_TEST_DATABASE_URL=$SIGIL_TEST_DATABASE_URL timeout 300 node --test sigil/relay/v1/postgres-repository.migration-019.test.mjs`
Expected: PASS (3 tests). Without `SIGIL_TEST_DATABASE_URL` the file reports 3 skipped.

- [ ] **Step 5: Commit**

```bash
git add sigil/migrations/019_federation_directory_security.sql sigil/relay/v1/postgres-repository.migration-019.test.mjs
git commit -m "feat(migrations): 019 federation_relay_nonces + directory-link CHECK relaxations + redemption-code scrub"
```

---

## Task 2: `consumeRelayNonce` / `pruneRelayNonces` on both repositories

**Files:**
- Modify: `sigil/relay/v1/postgres-repository.mjs` (add methods near `consumeLoginJti`, ~line 1031)
- Modify: `sigil/cli/memory-repository.mjs` (add near the other federation-directory methods; add a `federationRelayNonces` Map near line 57)
- Test: `sigil/relay/v1/postgres-repository.relay-nonce.test.mjs` (new, Postgres-gated)
- Test: `sigil/cli/memory-repository.relay-nonce.test.mjs` (new, pure)

**Interfaces:**
- Consumes: `federation_relay_nonces` (Task 1).
- Produces:
  - `async consumeRelayNonce(nonce, { now = new Date(), expiresAt, client = this.pool } = {})` — inserts the nonce; on a uniqueness violation throws `Object.assign(new Error('relay request nonce already seen'), { code: 'RELAY_REPLAYED' })`. No return value on success.
  - `async pruneRelayNonces(now = new Date())` — `DELETE FROM federation_relay_nonces WHERE expires_at < $1`; returns `{ deleted: <rowCount> }`.
  - Memory: same signatures; `consumeRelayNonce` uses a `Map<nonce, expiresAtIso>`; `pruneRelayNonces` sweeps entries with `expiresAt < now`.
  - **`pruneRelayNonces` is deliberately not wired to a scheduler on this branch** (no existing periodic path prunes `login_jti_replays` either). Spec Section 3 accepts this: growth is bounded by the freshness window times request rate. Scheduler wiring is a deferred follow-up — see the TODO in Section 8 / eng-review finding C.

- [ ] **Step 1: Write the failing memory test**

Create `sigil/cli/memory-repository.relay-nonce.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

test('memory consumeRelayNonce: first insert ok, second throws RELAY_REPLAYED', async () => {
  const repo = createMemoryRepository();
  const exp = Date.now() + 300_000;
  await repo.consumeRelayNonce('AAAAAAAAAAAAAAAAAAAAAA', { expiresAt: exp });
  await assert.rejects(
    repo.consumeRelayNonce('AAAAAAAAAAAAAAAAAAAAAA', { expiresAt: exp }),
    (e) => e.code === 'RELAY_REPLAYED',
  );
});

test('memory pruneRelayNonces removes only expired entries', async () => {
  const repo = createMemoryRepository();
  await repo.consumeRelayNonce('N_old_000000000000000000', { expiresAt: Date.now() - 1000 });
  await repo.consumeRelayNonce('N_new_000000000000000000', { expiresAt: Date.now() + 300_000 });
  const { deleted } = await repo.pruneRelayNonces(new Date());
  assert.equal(deleted, 1);
  // the still-valid nonce is still considered seen
  await assert.rejects(
    repo.consumeRelayNonce('N_new_000000000000000000', { expiresAt: Date.now() + 300_000 }),
    (e) => e.code === 'RELAY_REPLAYED',
  );
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `timeout 120 node --test sigil/cli/memory-repository.relay-nonce.test.mjs`
Expected: FAIL — `repo.consumeRelayNonce is not a function`.

- [ ] **Step 3: Implement the memory methods**

In `sigil/cli/memory-repository.mjs`, add near line 57:

```js
  const federationRelayNonces = new Map(); // nonce -> expiresAt ISO (migration 019, replay guard)
```

Add to the returned object (near the other `federation_directory_*` methods):

```js
    async consumeRelayNonce(nonce, { expiresAt } = {}) {
      if (federationRelayNonces.has(nonce)) {
        throw Object.assign(new Error('relay request nonce already seen'), { code: 'RELAY_REPLAYED' });
      }
      const iso = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt).toISOString();
      federationRelayNonces.set(nonce, iso);
    },
    async pruneRelayNonces(now = new Date()) {
      const cutoff = (now instanceof Date ? now : new Date(now)).toISOString();
      let deleted = 0;
      for (const [nonce, exp] of federationRelayNonces) {
        if (exp < cutoff) { federationRelayNonces.delete(nonce); deleted += 1; }
      }
      return { deleted };
    },
```

- [ ] **Step 4: Run the memory test — PASS**

Run: `timeout 120 node --test sigil/cli/memory-repository.relay-nonce.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the Postgres-gated test**

Create `sigil/relay/v1/postgres-repository.relay-nonce.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { PostgresRepository } from './postgres-repository.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('consumeRelayNonce: first ok, duplicate throws RELAY_REPLAYED; pruneRelayNonces clears expired', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  const repo = new PostgresRepository({ pool });
  t.after(() => pool.end());
  await applyMigrations(connectionString, { reset: true });

  const exp = new Date(Date.now() + 300_000);
  await repo.consumeRelayNonce('PGNONCE_0000000000000000', { expiresAt: exp });
  await assert.rejects(
    repo.consumeRelayNonce('PGNONCE_0000000000000000', { expiresAt: exp }),
    (e) => e.code === 'RELAY_REPLAYED',
  );

  await repo.consumeRelayNonce('PGNONCE_expired_00000000', { expiresAt: new Date(Date.now() - 1000) });
  const { deleted } = await repo.pruneRelayNonces(new Date());
  assert.ok(deleted >= 1);
});

test('consumeRelayNonce honours a transaction client and does not burn the nonce on rollback', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  const repo = new PostgresRepository({ pool });
  t.after(() => pool.end());
  await applyMigrations(connectionString, { reset: true });

  await assert.rejects(repo.withTransaction(async (client) => {
    await repo.consumeRelayNonce('PGNONCE_rollback_0000000', { expiresAt: new Date(Date.now() + 300_000), client });
    throw new Error('force rollback');
  }));
  // fresh transaction: the nonce is NOT seen, because the first tx rolled back
  await repo.consumeRelayNonce('PGNONCE_rollback_0000000', { expiresAt: new Date(Date.now() + 300_000) });
});
```

- [ ] **Step 6: Run it and verify it fails**

Run: `SIGIL_TEST_DATABASE_URL=$SIGIL_TEST_DATABASE_URL timeout 300 node --test sigil/relay/v1/postgres-repository.relay-nonce.test.mjs`
Expected: FAIL — `repo.consumeRelayNonce is not a function`.

- [ ] **Step 7: Implement the Postgres methods**

In `sigil/relay/v1/postgres-repository.mjs`, immediately after `consumeLoginJti` (line ~1031):

```js
  // Relay-to-relay replay guard (migration 019). The PRIMARY KEY uniqueness
  // constraint on federation_relay_nonces.nonce makes a second insert fail
  // 23505, mapped here to RELAY_REPLAYED. Callers pass the transaction `client`
  // so a handler that rolls back does not burn the nonce.
  async consumeRelayNonce(nonce, { now = new Date(), expiresAt, client = this.pool } = {}) {
    const expires = expiresAt instanceof Date ? expiresAt.toISOString() : new Date(expiresAt).toISOString();
    try {
      await client.query('INSERT INTO federation_relay_nonces (nonce, expires_at) VALUES ($1, $2)', [nonce, expires]);
    } catch (error) {
      if (error.code === '23505') throw Object.assign(new Error('relay request nonce already seen'), { code: 'RELAY_REPLAYED' });
      throw error;
    }
  }
  async pruneRelayNonces(now = new Date()) {
    const cutoff = (now instanceof Date ? now : new Date(now)).toISOString();
    const r = await this.pool.query('DELETE FROM federation_relay_nonces WHERE expires_at < $1', [cutoff]);
    return { deleted: r.rowCount };
  }
```

- [ ] **Step 8: Run both test files — PASS**

Run: `SIGIL_TEST_DATABASE_URL=$SIGIL_TEST_DATABASE_URL timeout 300 node --test sigil/relay/v1/postgres-repository.relay-nonce.test.mjs sigil/cli/memory-repository.relay-nonce.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 9: Commit**

```bash
git add sigil/relay/v1/postgres-repository.mjs sigil/cli/memory-repository.mjs sigil/relay/v1/postgres-repository.relay-nonce.test.mjs sigil/cli/memory-repository.relay-nonce.test.mjs
git commit -m "feat(relay): consumeRelayNonce / pruneRelayNonces on both repositories"
```

---

## Task 3: Freshness-window config helper

**Files:**
- Modify: `sigil/relay/v1/relay-config.mjs`
- Test: `sigil/relay/v1/relay-request-freshness.test.mjs` (new)

**Interfaces:**
- Produces:
  - `export const DEFAULT_RELAY_REQUEST_FRESHNESS_MS = 300_000;`
  - `export function resolveRelayRequestFreshnessMs(raw)` — returns `DEFAULT_RELAY_REQUEST_FRESHNESS_MS` when `raw` is `undefined` / `null` / not a finite number; otherwise clamps the number to `[60_000, 3_600_000]` and returns it.

- [ ] **Step 1: Write the failing test**

Create `sigil/relay/v1/relay-request-freshness.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RELAY_REQUEST_FRESHNESS_MS, resolveRelayRequestFreshnessMs } from './relay-config.mjs';

test('default when unset or invalid', () => {
  assert.equal(DEFAULT_RELAY_REQUEST_FRESHNESS_MS, 300_000);
  assert.equal(resolveRelayRequestFreshnessMs(undefined), 300_000);
  assert.equal(resolveRelayRequestFreshnessMs(null), 300_000);
  assert.equal(resolveRelayRequestFreshnessMs('nope'), 300_000);
  assert.equal(resolveRelayRequestFreshnessMs(Number.NaN), 300_000);
});

test('clamps to [60_000, 3_600_000]', () => {
  assert.equal(resolveRelayRequestFreshnessMs(1_000), 60_000);
  assert.equal(resolveRelayRequestFreshnessMs(10_000_000), 3_600_000);
  assert.equal(resolveRelayRequestFreshnessMs(120_000), 120_000);
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `timeout 120 node --test sigil/relay/v1/relay-request-freshness.test.mjs`
Expected: FAIL — `resolveRelayRequestFreshnessMs` is not exported.

- [ ] **Step 3: Implement**

Append to `sigil/relay/v1/relay-config.mjs`:

```js
// Relay-to-relay request freshness window (design Section 3). Bounds how long a
// captured signed request stays replayable and gives the nonce table a prune
// horizon. Clamped at load; the effective value is logged once at startup by
// the caller.
export const DEFAULT_RELAY_REQUEST_FRESHNESS_MS = 300_000;
const RELAY_REQUEST_FRESHNESS_MIN_MS = 60_000;
const RELAY_REQUEST_FRESHNESS_MAX_MS = 3_600_000;

export function resolveRelayRequestFreshnessMs(raw) {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_RELAY_REQUEST_FRESHNESS_MS;
  return Math.min(RELAY_REQUEST_FRESHNESS_MAX_MS, Math.max(RELAY_REQUEST_FRESHNESS_MIN_MS, n));
}
```

- [ ] **Step 4: Run it — PASS**

Run: `timeout 120 node --test sigil/relay/v1/relay-request-freshness.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/relay-config.mjs sigil/relay/v1/relay-request-freshness.test.mjs
git commit -m "feat(relay): relayRequestFreshnessMs config helper with clamp"
```

---

## Task 4: `verifyInboundRelayRequest` — freshness + nonce-format checks

**Files:**
- Modify: `sigil/relay/v1/federation-relay-auth.mjs`
- Test: `sigil/relay/v1/federation-relay-auth.test.mjs` (add cases)

**Interfaces:**
- Consumes: nothing new (takes `freshnessMs` and `now` from the caller).
- Produces: `verifyInboundRelayRequest(rawBody, headers, { getPeerByKid, now = new Date(), freshnessMs = 300_000 })` now, after the signature check:
  - requires `parsedBody.signed_at` to be a parseable timestamp within `±freshnessMs` of `now`, else throws `fail('RELAY_REQUEST_STALE', 401, ...)`;
  - requires `parsedBody.nonce` to match `^[A-Za-z0-9_-]{22}$`, else throws `fail('INVALID_FEDERATION_REQUEST', 400, ...)`;
  - return value gains `nonce` (the string) and `signedAtMs` (epoch ms), alongside the existing `{ ok, originDomain, peerRecord, parsedBody }`. It does **not** consume the nonce.
- Order matters: `RELAY_REQUEST_STALE` is checked **before** the nonce-format check (a captured-and-replayed request should read as stale first once the window passes).

- [ ] **Step 1: Add failing tests**

Append to `sigil/relay/v1/federation-relay-auth.test.mjs`. Extend the local `sign` helper usage with a body that carries `nonce` + `signed_at`:

```js
const NONCE_OK = 'abcdefghijklmnopqrstuv'; // 22 chars, base64url alphabet

function signedBody(extra = {}) {
  return { link_ref: '11111111-1111-1111-1111-111111111111', nonce: NONCE_OK, signed_at: new Date('2026-09-06T12:00:00.000Z').toISOString(), ...extra };
}

test('valid request returns nonce and signedAtMs', async () => {
  const { peer, privateKey, kid } = makePeer();
  const body = signedBody();
  const headers = { 'sigil-relay-signature': sign(privateKey, canonicalJsonBytes(body)), 'sigil-relay-key-id': kid };
  const res = await verifyInboundRelayRequest(Buffer.from(JSON.stringify(body)), headers, {
    getPeerByKid: async () => peer, now: new Date('2026-09-06T12:00:10.000Z'), freshnessMs: 300_000,
  });
  assert.equal(res.nonce, NONCE_OK);
  assert.equal(res.signedAtMs, Date.parse(body.signed_at));
});

test('signed_at outside the freshness window -> 401 RELAY_REQUEST_STALE', async () => {
  const { peer, privateKey, kid } = makePeer();
  const body = signedBody();
  const headers = { 'sigil-relay-signature': sign(privateKey, canonicalJsonBytes(body)), 'sigil-relay-key-id': kid };
  await assert.rejects(
    verifyInboundRelayRequest(Buffer.from(JSON.stringify(body)), headers, {
      getPeerByKid: async () => peer, now: new Date('2026-09-06T13:00:00.000Z'), freshnessMs: 300_000,
    }),
    (e) => e.code === 'RELAY_REQUEST_STALE' && e.httpStatus === 401,
  );
});

test('nonce with a wrong length or non-base64url char -> 400 INVALID_FEDERATION_REQUEST', async () => {
  const { peer, privateKey, kid } = makePeer();
  for (const bad of ['tooshort', 'abcdefghijklmnopqrstu+', 'abcdefghijklmnopqrstuvw']) {
    const body = signedBody({ nonce: bad });
    const headers = { 'sigil-relay-signature': sign(privateKey, canonicalJsonBytes(body)), 'sigil-relay-key-id': kid };
    await assert.rejects(
      verifyInboundRelayRequest(Buffer.from(JSON.stringify(body)), headers, {
        getPeerByKid: async () => peer, now: new Date('2026-09-06T12:00:10.000Z'), freshnessMs: 300_000,
      }),
      (e) => e.code === 'INVALID_FEDERATION_REQUEST' && e.httpStatus === 400,
    );
  }
});
```

Also update the **existing** case `'a valid signed request passes and reports originDomain from the kid'` (line ~16): its `body` must now include `nonce: NONCE_OK` and a `signed_at` within a default window of "now" — set `signed_at: new Date().toISOString()` and pass no `now` override (defaults to `new Date()`). The `deepEqual(res.parsedBody, body)` assertion still holds because `parsedBody` echoes the whole body.

- [ ] **Step 2: Run and verify failure**

Run: `timeout 120 node --test sigil/relay/v1/federation-relay-auth.test.mjs`
Expected: FAIL — new freshness/nonce cases reject with the wrong (no) error; possibly the updated existing case also fails until the impl reads the fields.

- [ ] **Step 3: Implement the checks**

In `sigil/relay/v1/federation-relay-auth.mjs`, change the signature and add the checks between step 3 and the return:

```js
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;

export async function verifyInboundRelayRequest(rawBody, headers, { getPeerByKid, now = new Date(), freshnessMs = 300_000 } = {}) {
  // ... steps 1-3 unchanged ...

  // 3b. Freshness: signed_at within +/- freshnessMs of the verifier's clock.
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const signedAtMs = Date.parse(parsedBody.signed_at);
  if (!Number.isFinite(signedAtMs) || Math.abs(nowMs - signedAtMs) > freshnessMs) {
    throw fail('RELAY_REQUEST_STALE', 401, 'signed_at is missing or outside the accepted freshness window');
  }
  // 3c. Nonce format (normative: 16 random bytes, base64url, 22 chars).
  if (typeof parsedBody.nonce !== 'string' || !NONCE_RE.test(parsedBody.nonce)) {
    throw fail('INVALID_FEDERATION_REQUEST', 400, 'nonce must be 22 base64url characters');
  }

  // 4. Return.
  return { ok: true, originDomain: peerRecord.domain, peerRecord, parsedBody, nonce: parsedBody.nonce, signedAtMs };
}
```

- [ ] **Step 4: Run — PASS**

Run: `timeout 120 node --test sigil/relay/v1/federation-relay-auth.test.mjs`
Expected: PASS (all cases, old + new).

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/federation-relay-auth.mjs sigil/relay/v1/federation-relay-auth.test.mjs
git commit -m "feat(relay): verifyInboundRelayRequest enforces signed_at freshness + nonce format"
```

---

## Task 5: Builders emit `nonce` + `signed_at`; handlers read `signed_at`

**Files:**
- Modify: `sigil/relay/v1/federation-directory-client.mjs` (`buildRedemptionRequest`, `buildConfirmationRequest`, `buildRevocationRequest`, plus the `isoOf` helper)
- Modify: `sigil/relay/v1/federation-router.mjs` (`buildForwardRequest`)
- Modify: `sigil/relay/v1/accept-federation-directory.mjs` (`acceptDirectoryConfirmation` line ~184, `acceptDirectoryRevocation` line ~216 — read `signed_at` instead of `confirmed_at` / `revoked_at`)
- Test: `sigil/relay/v1/federation-directory-client.test.mjs` (rewrite the two builder shape tests)
- Test: `sigil/relay/v1/federation-router.test.mjs` (rewrite the `forwarded_at` assertion)
- Test: `sigil/relay/v1/accept-federation-directory.test.mjs` (the Task 9 / Task 17 malformed-timestamp cases for `confirmed_at` / `revoked_at` move to `signed_at`)

**Interfaces:**
- Produces: a shared `newRelayNonce()` helper exported from `federation-directory-client.mjs`:
  `export const newRelayNonce = () => crypto.randomBytes(16).toString('base64url');` (22 chars).
- Every builder body now contains `nonce: <fresh>` and `signed_at: isoOf(now)`; no builder body contains `requested_at` / `confirmed_at` / `revoked_at` / `forwarded_at`.
- Builder call signatures gain an optional `nonce` param (defaulting to `newRelayNonce()`) so tests can pin it; callers in Task 11 pass a fresh one per pass by simply not overriding.
- `acceptDirectoryConfirmation` / `acceptDirectoryRevocation` structural check reads `parsedBody.signed_at` (still via `isoString`).

- [ ] **Step 1: Rewrite the builder shape tests (failing)**

`sigil/relay/v1/federation-directory-client.test.mjs`:

```js
import crypto from 'node:crypto';
// ...
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA';

test('buildConfirmationRequest / buildRevocationRequest shapes carry nonce + signed_at, not confirmed_at/revoked_at', () => {
  const c = buildConfirmationRequest({ linkRef: 'L1', now: NOW, nonce: NONCE }).body;
  assert.deepEqual(c, { link_ref: 'L1', nonce: NONCE, signed_at: '2026-09-02T12:00:00.000Z' });
  const r = buildRevocationRequest({ linkRef: 'L1', now: NOW, nonce: NONCE }).body;
  assert.deepEqual(r, { link_ref: 'L1', nonce: NONCE, signed_at: '2026-09-02T12:00:00.000Z' });
});

test('buildRedemptionRequest body carries nonce + signed_at and no requested_at', () => {
  const { body } = buildRedemptionRequest({
    linkRef: 'L1', code: 'sigil-fed-invite:a.example:L1:SEG',
    redeemer: { owner_id: 'usr_b@b.example', endpoint_id: 'ep_c@b.example' },
    redeemerDomain: 'b.example', now: NOW, nonce: NONCE,
  });
  assert.equal(body.requested_at, undefined);
  assert.equal(body.nonce, NONCE);
  assert.equal(body.signed_at, '2026-09-02T12:00:00.000Z');
});

test('nonce defaults to 22 base64url chars when not provided', () => {
  const { body } = buildConfirmationRequest({ linkRef: 'L1', now: NOW });
  assert.match(body.nonce, /^[A-Za-z0-9_-]{22}$/);
});
```

`sigil/relay/v1/federation-router.test.mjs` line ~50 — replace the `forwarded_at` assertion:

```js
test('buildForwardRequest: canonicalBytes equals JCS of body and carries nonce + signed_at', () => {
  // ... existing arrange ...
  assert.equal(body.forwarded_at, undefined);
  assert.match(body.nonce, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(body.signed_at, '2026-08-30T12:00:05.000Z');
});
```

- [ ] **Step 2: Run and verify failure**

Run: `timeout 120 node --test sigil/relay/v1/federation-directory-client.test.mjs sigil/relay/v1/federation-router.test.mjs`
Expected: FAIL — bodies still carry the old timestamp fields, no `nonce`.

- [ ] **Step 3: Implement the builders**

`sigil/relay/v1/federation-directory-client.mjs`:

```js
export const newRelayNonce = () => crypto.randomBytes(16).toString('base64url');

export function buildRedemptionRequest({ linkRef, code, redeemer, redeemerDomain, now, nonce = newRelayNonce() }) {
  const body = {
    link_ref: linkRef,
    code,
    redeemer: { owner_id: redeemer.owner_id, endpoint_id: redeemer.endpoint_id },
    redeemer_domain: redeemerDomain,
    nonce,
    signed_at: isoOf(now),
  };
  return { body, canonicalBytes: canonicalJsonBytes(body) };
}

export function buildConfirmationRequest({ linkRef, now, nonce = newRelayNonce() }) {
  const body = { link_ref: linkRef, nonce, signed_at: isoOf(now) };
  return { body, canonicalBytes: canonicalJsonBytes(body) };
}

export function buildRevocationRequest({ linkRef, now, nonce = newRelayNonce() }) {
  const body = { link_ref: linkRef, nonce, signed_at: isoOf(now) };
  return { body, canonicalBytes: canonicalJsonBytes(body) };
}
```

`sigil/relay/v1/federation-router.mjs` `buildForwardRequest`:

```js
import { newRelayNonce } from './federation-directory-client.mjs';
// ...
export function buildForwardRequest(envelope, { originDomain, senderKey, senderOwnerId, now, nonce = newRelayNonce() } = {}) {
  const body = {
    origin_domain: originDomain,
    envelope,
    sender_key: { kid: senderKey.kid, alg: senderKey.alg ?? 'Ed25519', publicKey: senderKey.publicKey },
    sender_owner_id: senderOwnerId,
    nonce,
    signed_at: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
  return { body, canonicalBytes: canonicalJsonBytes(body) };
}
```

> `federation-directory-client.mjs` already imports `crypto`. `federation-router.mjs` importing `newRelayNonce` from `federation-directory-client.mjs` is safe: that module already imports `postDirectory` / `readPeerCode` from it, so the dependency edge exists.

- [ ] **Step 4: Update the handlers to read `signed_at`**

`sigil/relay/v1/accept-federation-directory.mjs`:
- Line ~184 (`acceptDirectoryConfirmation` structural check): change `!isoString(parsedBody?.confirmed_at)` → `!isoString(parsedBody?.signed_at)` and the message to `'link_ref must be a uuid and signed_at an ISO timestamp'`.
- Line ~216 (`acceptDirectoryRevocation`): change `!isoString(parsedBody?.revoked_at)` → `!isoString(parsedBody?.signed_at)` and the message likewise.
- `acceptDirectoryRedemption` reads no timestamp — no change there.

- [ ] **Step 5: Move the malformed-timestamp tests**

In `sigil/relay/v1/accept-federation-directory.test.mjs`, find the cases asserting a 400 for a malformed `confirmed_at` / `revoked_at` (Task 9 / Task 17 originals). Change the offending field name in the request body from `confirmed_at` / `revoked_at` to `signed_at`, keep the assertion (`status 400`, `code INVALID_FEDERATION_REQUEST`). Any "happy path" confirmation/revocation body in that file that currently sets `confirmed_at` / `revoked_at` must instead set `signed_at` (and may add a `nonce` — the handler unit does not check it, only the HTTP layer does).

- [ ] **Step 6: Run the affected suites — PASS**

Run: `timeout 300 node --test sigil/relay/v1/federation-directory-client.test.mjs sigil/relay/v1/federation-router.test.mjs sigil/relay/v1/accept-federation-directory.test.mjs sigil/relay/v1/federation-reaper.test.mjs`
Expected: PASS. If `federation-reaper.test.mjs` fails here, it is because it asserts the old builder output — note the failures; Task 11 rewrites that file. If the failures are ONLY about `nonce` / `signed_at` field presence, add `nonce`/`signed_at` tolerance to those assertions now; if they are about the redemption path, leave them for Task 11 and mark this step done with a `TODO(Task 11)` note in the commit body.

- [ ] **Step 7: Commit**

```bash
git add sigil/relay/v1/federation-directory-client.mjs sigil/relay/v1/federation-router.mjs sigil/relay/v1/accept-federation-directory.mjs sigil/relay/v1/federation-directory-client.test.mjs sigil/relay/v1/federation-router.test.mjs sigil/relay/v1/accept-federation-directory.test.mjs
git commit -m "feat(relay): relay-auth signed bodies carry nonce + signed_at; drop per-message timestamps"
```

---

## Task 6: `initiatedVia` write path for self-pair links

**Files:**
- Modify: `sigil/relay/v1/postgres-repository.mjs` (`createFederationDirectoryLink`, line ~1325)
- Modify: `sigil/cli/memory-repository.mjs` (`createFederationDirectoryLink`, line ~476 — store `initiated_via`)
- Modify: `sigil/relay/v1/accept-federation-directory.mjs` (`acceptDirectoryRedemption` step 6 — set `initiatedVia`)
- Modify: `sigil/cli/sigil.mjs` (`cmdFederationInviteRedeem` link write, line ~1107 — set `initiatedVia`)
- Test: `sigil/relay/v1/postgres-repository.directory-federation.test.mjs` (add a self-pair insert case, Postgres-gated)
- Test: `sigil/relay/v1/accept-federation-directory.test.mjs` (add: equal issuer/redeemer owner → link row written with `initiated_via = 'self_pair'`)

**Interfaces:**
- Produces: `createFederationDirectoryLink(row, client)` accepts `row.initiatedVia`; when absent it defaults to `'invite'`. Postgres INSERT adds the `initiated_via` column + placeholder. Memory `stored` object adds `initiated_via: row.initiatedVia ?? 'invite'` and `fdlRowView` must surface it (check `fdlRowView` — if it whitelists fields, add `initiated_via`).
- Rule for callers: `initiatedVia = localOwnerId === remoteOwnerId ? 'self_pair' : 'invite'`.

- [ ] **Step 1: Failing handler test**

In `sigil/relay/v1/accept-federation-directory.test.mjs`:

```js
test('equal issuer/redeemer owner: redemption writes a self_pair issuer-side link', async () => {
  const repo = createMemoryRepository();
  const linkRef = crypto.randomUUID();
  // seed an invite whose issuer owner equals the redeemer owner used in redemptionBody
  await repo.createFederationDirectoryInvite({
    linkRef, issuerEndpointId: 'ep_codex@a.example', issuerOwnerId: 'usr_bob@b.example',
    peerDomain: 'b.example', codeHash: sha256('SEG'), expiresAt: new Date(Date.now() + 3600_000), now: new Date(),
  }, null);
  const res = await acceptDirectoryRedemption(redemptionBody({ linkRef, segment: 'SEG' }), ctx(repo));
  assert.equal(res.status, 202);
  const link = await repo.getFederationDirectoryLinkByRef(linkRef, null, {});
  assert.equal(link.local_owner_id, 'usr_bob@b.example');
  assert.equal(link.remote_owner_id, 'usr_bob@b.example');
  assert.equal(link.initiated_via, 'self_pair');
});
```

- [ ] **Step 2: Run and verify failure**

Run: `timeout 120 node --test sigil/relay/v1/accept-federation-directory.test.mjs`
Expected: FAIL — `link.initiated_via` is `undefined` (memory never stored it) or `'invite'`.

- [ ] **Step 3: Implement the repository param**

Postgres `createFederationDirectoryLink` — add `initiated_via` to the column list and values:

```js
      const r = await client.query(
        `INSERT INTO federation_directory_links
           (link_ref, local_owner_id, local_endpoint_id, remote_owner_id, remote_endpoint_id,
            remote_domain, role, initiated_via, status, local_confirmed_at, remote_confirmed_at, source_invite_id,
            peer_domain, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), now())
         RETURNING *`,
        [row.linkRef, row.localOwnerId, row.localEndpointId, row.remoteOwnerId, row.remoteEndpointId,
          row.remoteDomain, row.role, row.initiatedVia ?? 'invite', row.status, row.localConfirmedAt, row.remoteConfirmedAt,
          row.sourceInviteId, row.peerDomain],
      );
```

Memory `createFederationDirectoryLink` — add to `stored`:

```js
        initiated_via: row.initiatedVia ?? 'invite',
```

`fdlRowView` (`memory-repository.mjs:26`) is an explicit field whitelist and does **not** currently surface `initiated_via` — add `initiated_via: row.initiated_via` to it. Without this, Task 6 Step 1's handler assertion (`link.initiated_via === 'self_pair'`) fails because the getters return `fdlRowView` copies. (Eng-review finding A.)

- [ ] **Step 4: Set `initiatedVia` in `acceptDirectoryRedemption`**

`sigil/relay/v1/accept-federation-directory.mjs` step 6, in the `createFederationDirectoryLink` call:

```js
      link = await repository.createFederationDirectoryLink({
        linkRef: parsedBody.link_ref,
        localOwnerId: invite.issuer_owner_id,
        localEndpointId: invite.issuer_endpoint_id,
        remoteOwnerId: redeemer.owner_id,
        remoteEndpointId: redeemer.endpoint_id,
        remoteDomain: originDomain,
        role: 'issuer',
        initiatedVia: invite.issuer_owner_id === redeemer.owner_id ? 'self_pair' : 'invite',
        status: 'pending',
        localConfirmedAt: null,
        remoteConfirmedAt: now,
        sourceInviteId: invite.invite_id,
        peerDomain: originDomain,
      }, client);
```

- [ ] **Step 5: Set `initiatedVia` in the CLI redeemer-side write**

`sigil/cli/sigil.mjs` `cmdFederationInviteRedeem`, the `createFederationDirectoryLink` call (line ~1107):

```js
          await repository.createFederationDirectoryLink({
            linkRef,
            localOwnerId: redeemer.owner_id,
            localEndpointId: redeemer.endpoint_id,
            remoteOwnerId: issuer.owner_id,
            remoteEndpointId: issuer.endpoint_id,
            remoteDomain: issuerDomain,
            role: 'redeemer',
            initiatedVia: redeemer.owner_id === issuer.owner_id ? 'self_pair' : 'invite',
            status: 'pending',
            localConfirmedAt: now,
            remoteConfirmedAt: null,
            sourceInviteId: null,
            peerDomain: issuerDomain,
          });
```

- [ ] **Step 6: Postgres-gated self-pair insert test**

Add to `sigil/relay/v1/postgres-repository.directory-federation.test.mjs`:

```js
test('createFederationDirectoryLink writes a self_pair row with equal owners', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  const repo = new PostgresRepository({ pool });
  t.after(() => pool.end());
  await applyMigrations(connectionString, { reset: true });
  const linkRef = crypto.randomUUID();
  const row = await repo.createFederationDirectoryLink({
    linkRef, localOwnerId: 'usr_x@home.example', localEndpointId: 'ep_a@home.example',
    remoteOwnerId: 'usr_x@home.example', remoteEndpointId: 'ep_b@home.example',
    remoteDomain: 'a.example', role: 'issuer', initiatedVia: 'self_pair', status: 'active',
    localConfirmedAt: new Date(), remoteConfirmedAt: new Date(), sourceInviteId: null, peerDomain: 'a.example',
  });
  assert.equal(row.local_owner_id, row.remote_owner_id);
});
```

- [ ] **Step 7: Run — PASS**

Run: `SIGIL_TEST_DATABASE_URL=$SIGIL_TEST_DATABASE_URL timeout 300 node --test sigil/relay/v1/accept-federation-directory.test.mjs sigil/relay/v1/postgres-repository.directory-federation.test.mjs`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add sigil/relay/v1/postgres-repository.mjs sigil/cli/memory-repository.mjs sigil/relay/v1/accept-federation-directory.mjs sigil/cli/sigil.mjs sigil/relay/v1/accept-federation-directory.test.mjs sigil/relay/v1/postgres-repository.directory-federation.test.mjs
git commit -m "feat(relay): createFederationDirectoryLink initiatedVia; self_pair on equal owners"
```

---

## Task 7 (ordering-locked): B1 — remove the federated same-owner exemption

**Do this task in one commit. It has a RED half (exploit proof) and a GREEN half (self-pair link authorises same-owner delivery). It depends on Task 1 (`self_pair` CHECK) and Task 6 (`initiatedVia` write path).**

**Files:**
- Modify: `sigil/relay/v1/accept-federated-envelope.mjs` (lines 139-154 — delete the `if (senderOwnerId === recipient.owner_id) { ... } else { ... }` split; run the directory-link lookup unconditionally)
- Test: `sigil/relay/v1/accept-federated-envelope.test.mjs` (rewrite the `'same-owner exemption ... → 202 delivered'` case; add a self-pair-link case)

**Interfaces:**
- Consumes: `repository.getActiveFederationDirectoryLink(recipient.owner_id, senderOwnerId, originDomain, client)` — unchanged signature; already matches a self-pair row because it filters on the `(local_owner_id, remote_owner_id, remote_domain)` triple and `status = 'active'` only.
- Produces: every federated delivery — same-owner and cross-owner alike — now requires an active `federation_directory_links` row. Same-owner with none → `reject('DIRECTORY_LINK_REQUIRED', ...)` → 403.

- [ ] **Step 1: RED — rewrite the exemption test to assert the exploit is now blocked**

In `sigil/relay/v1/accept-federated-envelope.test.mjs`, replace the test at line ~124 (`'same-owner exemption: relay-attested owner == recipient registry owner → 202 delivered'`):

```js
test('B1: same-owner federated delivery with NO directory link → 403 DIRECTORY_LINK_REQUIRED (exemption removed)', async () => {
  const world = worldWithRecipient('usr_chris@primary.example');
  const { body, headers } = forwardPayload(world); // senderOwnerId defaults to usr_chris@primary.example == recipient owner
  const r = await acceptFederatedEnvelope(body, headers, opts9(world));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'DIRECTORY_LINK_REQUIRED');
  const inbox = await world.repo.listInbox(`ep_claude@${RELAY}`, '');
  assert.equal(inbox.length, 0, 'the forged same-owner envelope must not be delivered');
});
```

- [ ] **Step 2: Run — the RED test should FAIL against current code**

Run: `timeout 120 node --test sigil/relay/v1/accept-federated-envelope.test.mjs`
Expected: FAIL — current code takes the exemption and returns 202.

- [ ] **Step 3: GREEN — add the self-pair authorisation test (also failing for now)**

```js
test('B1: same-owner federated delivery WITH an active self-pair link → 202 delivered', async () => {
  const world = worldWithRecipient('usr_chris@primary.example');
  await world.repo.createFederationDirectoryLink({
    linkRef: crypto.randomUUID(),
    localOwnerId: 'usr_chris@primary.example', localEndpointId: `ep_claude@${RELAY}`,
    remoteOwnerId: 'usr_chris@primary.example', remoteEndpointId: `ep_codex@${ORIGIN}`,
    remoteDomain: ORIGIN, role: 'issuer', initiatedVia: 'self_pair', status: 'active',
    localConfirmedAt: new Date(), remoteConfirmedAt: new Date(), sourceInviteId: null, peerDomain: ORIGIN,
  });
  const { body, headers } = forwardPayload(world);
  const r = await acceptFederatedEnvelope(body, headers, opts9(world));
  assert.equal(r.status, 202);
  assert.equal(r.body.code, 'ACCEPTED');
  const inbox = await world.repo.listInbox(`ep_claude@${RELAY}`, '');
  assert.equal(inbox.length, 1);
  assert.equal(world.repo._debugGetEnvelope(inbox[0].message_id).federation_hop, true);
});
```

> Memory `createFederationDirectoryLink` has no owner-distinctness CHECK, so a self-pair row inserts without migration 019 — this is the spec's stated memory-suite path.

- [ ] **Step 4: Implement — delete the exemption branch**

In `sigil/relay/v1/accept-federated-envelope.mjs`, replace lines 139-154 (the `// 8: directory gate.` block) with an unconditional lookup:

```js
    // 8: directory gate (design Section 1 — the same-owner exemption is
    // removed; a self-pair link authorises same-owner cross-federation
    // delivery). sender_owner_id stays informational and is NOT domain-pinned:
    // #3's --federation-owner deliberately lets one owner id live on two
    // relays under a domain that differs from the relay domain.
    const link = typeof repository.getActiveFederationDirectoryLink === 'function'
      ? await repository.getActiveFederationDirectoryLink(recipient.owner_id, senderOwnerId, originDomain, client)
      : null;
    if (!link) {
      throw reject('DIRECTORY_LINK_REQUIRED', 'No active cross-federation directory link authorises this delivery', {
        sender_owner_id: senderOwnerId,
        recipient_endpoint_id: recipientId,
        reason: 'no_active_federation_directory_link',
      });
    }
    // link.status === 'active' — deliver.
```

The `envelope.sender.owner_id === senderOwnerId` consistency check at line 126 is untouched.

- [ ] **Step 5: Run the full envelope suite — PASS**

Run: `timeout 300 node --test sigil/relay/v1/accept-federated-envelope.test.mjs sigil/relay/v1/accept-federated-envelope.pg.test.mjs sigil/relay/v1/federation-regression.test.mjs`
Expected: PASS. Fix any other case in these files that assumed the exemption (search for `same owner`, `same-owner`, `exemption`). `federation-regression.test.mjs:154` ("same owner as the relay-attested sender") is a likely hit — update it to seed a self-pair link or assert `DIRECTORY_LINK_REQUIRED`, matching the case's intent.

- [ ] **Step 6: Commit**

```bash
git add sigil/relay/v1/accept-federated-envelope.mjs sigil/relay/v1/accept-federated-envelope.test.mjs sigil/relay/v1/federation-regression.test.mjs
git commit -m "fix(relay): remove federated same-owner delivery exemption (B1); require a self-pair link"
```

---

## Task 8: B2 — pin `redeemer.owner_id` domain in the redemption handler

**Files:**
- Modify: `sigil/relay/v1/accept-federation-directory.mjs` (`acceptDirectoryRedemption`, the `try` block at lines 65-72)
- Test: `sigil/relay/v1/accept-federation-directory.test.mjs`

**Interfaces:**
- Consumes: `originDomain` (already in `ctx`), `parseFederatedId` (already imported).
- Produces: a redemption whose `redeemer.owner_id` domain ≠ `originDomain` returns `400 INVALID_FEDERATION_REQUEST` ("redeemer ids are malformed or not on the posting domain") and writes no invite/link mutation.

- [ ] **Step 1: RED test**

```js
test('B2: redeemer.owner_id on a foreign domain → 400 and no issuer-side link', async () => {
  const repo = createMemoryRepository();
  const linkRef = crypto.randomUUID();
  await seedInvite(repo, { linkRef, segment: 'SEG' });
  const body = redemptionBody({ linkRef, segment: 'SEG' });
  body.redeemer.owner_id = 'usr_x@third-domain.example'; // endpoint_id stays on b.example
  const res = await acceptDirectoryRedemption(body, ctx(repo));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_FEDERATION_REQUEST');
  assert.equal(await repo.getFederationDirectoryLinkByRef(linkRef, null, {}), null);
  const invite = await repo.getFederationDirectoryInviteByRef(linkRef, null, {});
  assert.equal(invite.status, 'pending', 'the invite must not be marked redeemed');
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `timeout 120 node --test sigil/relay/v1/accept-federation-directory.test.mjs`
Expected: FAIL — current code accepts (202) and writes an issuer-side link with `remote_owner_id = usr_x@third-domain.example`.

- [ ] **Step 3: Implement the pin**

`sigil/relay/v1/accept-federation-directory.mjs`, the redeemer id `try` block:

```js
  try {
    if (parseFederatedId(redeemer.owner_id).domain.toLowerCase() !== String(originDomain).toLowerCase()) {
      throw new Error('owner domain');
    }
    if (parseFederatedId(redeemer.endpoint_id).domain.toLowerCase() !== String(originDomain).toLowerCase()) {
      throw new Error('endpoint domain');
    }
  } catch {
    return respond(400, 'INVALID_FEDERATION_REQUEST', 'redeemer ids are malformed or not on the posting domain', ctx);
  }
```

- [ ] **Step 4: Run — PASS**

Run: `timeout 120 node --test sigil/relay/v1/accept-federation-directory.test.mjs`
Expected: PASS. Confirm no existing case relied on a cross-domain `redeemer.owner_id`.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/accept-federation-directory.mjs sigil/relay/v1/accept-federation-directory.test.mjs
git commit -m "fix(relay): pin redeemer.owner_id domain to the posting relay (B2)"
```

---

## Task 9: E2 — `assertIssuerResponseIdentity` + CLI rejection path

**Files:**
- Modify: `sigil/relay/v1/federation-directory-client.mjs` (new export)
- Modify: `sigil/cli/sigil.mjs` (`cmdFederationInviteRedeem`, after `const issuer = outcome.body?.issuer` and its truthiness check at line ~1090)
- Test: `sigil/relay/v1/federation-directory-client.test.mjs` (unit)
- Test: `sigil/cli/sigil.federation-invite.test.mjs` — locate the existing CLI redeem test file (grep `invite redeem` under `sigil/cli/*.test.mjs`); add an integration case there. If no such file exists, create `sigil/cli/sigil.federation-invite-redeem.test.mjs`.

**Interfaces:**
- Produces:

```js
export function assertIssuerResponseIdentity(issuer, issuerDomain) {
  // Throws Object.assign(new Error('issuer identity domain mismatch'),
  //   { code: 'ISSUER_IDENTITY_DOMAIN_MISMATCH' })
  // unless issuer.owner_id and issuer.endpoint_id are both well-formed
  // federated ids whose domain === issuerDomain (case-insensitive).
}
```

- CLI: on a thrown `ISSUER_IDENTITY_DOMAIN_MISMATCH`, write an audit event (`eventType: 'federation_directory.invite_redeem_rejected'`, `outcome: 'rejected'`, `reason: 'ISSUER_IDENTITY_DOMAIN_MISMATCH'`, `payload: { peer_domain: issuerDomain }`), `console.error` a specific line, set `process.exitCode = 1`, and `return` without reserving quota or writing the link row.

- [ ] **Step 1: Unit test (failing)**

`sigil/relay/v1/federation-directory-client.test.mjs`:

```js
import { assertIssuerResponseIdentity } from './federation-directory-client.mjs';

test('assertIssuerResponseIdentity: accepts matching domain, rejects a foreign one', () => {
  assert.doesNotThrow(() => assertIssuerResponseIdentity(
    { owner_id: 'usr_x@issuer.example', endpoint_id: 'ep_i@issuer.example' }, 'issuer.example',
  ));
  assert.throws(
    () => assertIssuerResponseIdentity({ owner_id: 'usr_x@evil.example', endpoint_id: 'ep_i@issuer.example' }, 'issuer.example'),
    (e) => e.code === 'ISSUER_IDENTITY_DOMAIN_MISMATCH',
  );
  assert.throws(
    () => assertIssuerResponseIdentity({ owner_id: 'not-a-fid', endpoint_id: 'ep_i@issuer.example' }, 'issuer.example'),
    (e) => e.code === 'ISSUER_IDENTITY_DOMAIN_MISMATCH',
  );
});
```

- [ ] **Step 2: Run — verify failure**

Run: `timeout 120 node --test sigil/relay/v1/federation-directory-client.test.mjs`
Expected: FAIL — `assertIssuerResponseIdentity is not a function`.

- [ ] **Step 3: Implement the function**

`sigil/relay/v1/federation-directory-client.mjs` (uses `parseFederatedId` — add the import from `./federated-id.mjs`):

```js
import { parseFederatedId } from './federated-id.mjs';

export function assertIssuerResponseIdentity(issuer, issuerDomain) {
  const want = String(issuerDomain).toLowerCase();
  for (const field of ['owner_id', 'endpoint_id']) {
    let domain;
    try { domain = parseFederatedId(issuer?.[field]).domain.toLowerCase(); }
    catch { throw Object.assign(new Error(`issuer.${field} is not a well-formed federated id`), { code: 'ISSUER_IDENTITY_DOMAIN_MISMATCH' }); }
    if (domain !== want) {
      throw Object.assign(new Error(`issuer.${field} domain does not equal the issuer relay domain`), { code: 'ISSUER_IDENTITY_DOMAIN_MISMATCH' });
    }
  }
}
```

- [ ] **Step 4: Run unit — PASS**

Run: `timeout 120 node --test sigil/relay/v1/federation-directory-client.test.mjs`
Expected: PASS.

- [ ] **Step 5: Wire into the CLI (with a failing integration test first)**

Add the integration test (fake repository + stubbed `postDirectory` via a fake fetch or a `fetchImpl` seam — match how the existing redeem test stubs the issuer 202). Assert: `process.exitCode === 1`, no `federation_directory_links` row, and an audit event with `reason: 'ISSUER_IDENTITY_DOMAIN_MISMATCH'`.

Then in `sigil/cli/sigil.mjs` `cmdFederationInviteRedeem`, right after:

```js
    if (outcome.ok) {
      const issuer = outcome.body?.issuer;
      if (issuer && issuer.owner_id && issuer.endpoint_id) {
```

insert, as the first statement inside that `if`:

```js
        try {
          const { assertIssuerResponseIdentity } = await import('../relay/v1/federation-directory-client.mjs');
          assertIssuerResponseIdentity(issuer, issuerDomain);
        } catch (err) {
          if (err?.code !== 'ISSUER_IDENTITY_DOMAIN_MISMATCH') throw err;
          await repository.recordAuditEvent({
            eventType: 'federation_directory.invite_redeem_rejected',
            subjectId: linkRef, actorId: redeemer.owner_id, endpointId: redeemer.endpoint_id,
            objectType: 'federation_directory_invite', objectId: linkRef,
            outcome: 'rejected', reason: 'ISSUER_IDENTITY_DOMAIN_MISMATCH',
            payload: { peer_domain: issuerDomain }, now,
          });
          console.error(`sigil federation invite redeem: issuer relay response names an owner/endpoint outside ${issuerDomain}; refusing to write the link`);
          process.exitCode = 1;
          return;
        }
```

> The `import(...)` mirrors the file's existing dynamic-import style at line ~1063. If `assertIssuerResponseIdentity` is already statically importable at the top of the redeem module, prefer a static import.

- [ ] **Step 6: Run the CLI test + unit — PASS**

Run: `timeout 300 node --test sigil/relay/v1/federation-directory-client.test.mjs sigil/cli/sigil.federation-invite-redeem.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add sigil/relay/v1/federation-directory-client.mjs sigil/cli/sigil.mjs sigil/relay/v1/federation-directory-client.test.mjs sigil/cli/sigil.federation-invite-redeem.test.mjs
git commit -m "fix(cli): validate issuer-response owner/endpoint domain on invite redeem (E2)"
```

---

## Task 10: B3 — consume the nonce inside each handler transaction

**Files:**
- Modify: `sigil/relay/v1/http-server.mjs` (`createRelayServer` options + the directory route, lines ~35, ~205-214)
- Modify: `sigil/relay/v1/accept-federated-envelope.mjs` (transaction body ~line 108; catch classifier ~line 194)
- Test: `sigil/relay/v1/http-server.federation-directory.test.mjs` (replay-in-window; stale integration)
- Test: `sigil/relay/v1/accept-federated-envelope.test.mjs` (envelope replay → 409)
- Test: `sigil/relay/v1/postgres-repository.relay-nonce.test.mjs` **or** a new `sigil/relay/v1/accept-federation-directory.rollback.pg.test.mjs` (B3 rollback safety, Postgres-only)

**Interfaces:**
- Consumes: `verified.nonce`, `verified.signedAtMs` (Task 4); `repository.consumeRelayNonce({ client, expiresAt })` (Task 2); `resolveRelayRequestFreshnessMs` (Task 3).
- Produces:
  - `createRelayServer` accepts `relayRequestFreshnessMs`; the resolved value (`freshnessMs`) is passed to `verifyInboundRelayRequest({ now, freshnessMs })` and reused as `expiresAt = verified.signedAtMs + freshnessMs` for `consumeRelayNonce`.
  - Directory route: first statement inside `repository.withTransaction((client) => ...)` is `await repository.consumeRelayNonce(verified.nonce, { now, expiresAt: verified.signedAtMs + freshnessMs, client })`; a thrown `RELAY_REPLAYED` becomes a `409` response `{ code: 'RELAY_REPLAYED' }`.
  - Envelope route (`acceptFederatedEnvelope`): first statement inside the existing `repository.withTransaction(async (client) => { ... })` (before the idempotency lookup) is the same `consumeRelayNonce` call, using `options.now` and a `freshnessMs` threaded through `options`. `statusByCode` in the `.catch` classifier gains `RELAY_REPLAYED: 409`.

- [ ] **Step 1: Failing tests**

`sigil/relay/v1/http-server.federation-directory.test.mjs` — add (match the file's existing signed-request helper; it already builds `Sigil-Relay-Signature` / `Sigil-Relay-Key-Id` and posts to the directory routes):

```js
test('B3: a verbatim replayed revocation within the freshness window → 409 RELAY_REPLAYED', async () => {
  // arrange: a pending/active link + a signed revocation request body with a fixed nonce + signed_at
  // act: POST it once (expect 202), POST the identical bytes again
  // assert: second response status 409, body.code === 'RELAY_REPLAYED', and the link is revoked exactly once
});

test('B3: a revocation whose signed_at is older than relayRequestFreshnessMs → 401 RELAY_REQUEST_STALE + audit', async () => {
  // arrange: server with relayRequestFreshnessMs: 60_000 and a fixed `now`
  // act: POST a revocation whose signed_at is `now - 5 min`
  // assert: 401, body.code === 'RELAY_REQUEST_STALE'; the link is NOT revoked;
  //         an audit event federation.inbound_rejected / reason RELAY_REQUEST_STALE is recorded
});
```

Fill these in against the file's real harness — do not leave them as comments. The `now` seam is `createRelayServer({ now: () => fixedDate })` (line 35 / 71).

`sigil/relay/v1/accept-federated-envelope.test.mjs`:

```js
test('B3: replaying a federated envelope with the same nonce → 409 RELAY_REPLAYED', async () => {
  const world = worldWithRecipient('usr_chris@primary.example');
  await world.repo.createFederationDirectoryLink({ /* active self-pair link, as in Task 7 Step 3 */ });
  const { body, headers } = forwardPayload(world); // body carries a nonce from buildForwardRequest
  const first = await acceptFederatedEnvelope(body, headers, opts9(world));
  assert.equal(first.status, 202);
  const second = await acceptFederatedEnvelope(body, headers, { ...opts9(world), request_id: 'req_2' });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'RELAY_REPLAYED');
});
```

> The memory `consumeRelayNonce` (Task 2) makes this work without Postgres. `forwardPayload` must be updated so `buildForwardRequest` gets a stable `nonce` only if the test needs byte-identical replay; here re-passing the same `body` object already replays the same nonce.

- [ ] **Step 2: Run — verify failures**

Run: `timeout 300 node --test sigil/relay/v1/http-server.federation-directory.test.mjs sigil/relay/v1/accept-federated-envelope.test.mjs`
Expected: FAIL — no nonce consumption yet; the replay returns 202/duplicate rather than 409.

- [ ] **Step 3: Implement — http-server directory route**

`createRelayServer` params (line 35): add `relayRequestFreshnessMs`. Near the top of the module, import `resolveRelayRequestFreshnessMs` from `./relay-config.mjs`. Just inside `createRelayServer`:

```js
  const freshnessMs = resolveRelayRequestFreshnessMs(relayRequestFreshnessMs);
  console.error(`sigil: relay request freshness window = ${freshnessMs} ms`);
```

Directory route — pass `now` + `freshnessMs` to the verify call, and consume the nonce inside the transaction:

```js
      let verified;
      try {
        verified = await verifyInboundRelayRequest(Buffer.from(raw), headers, {
          getPeerByKid: (kid) => repository.getPeerByKid(kid), now, freshnessMs,
        });
      } catch (error) {
        const audit = repository.recordAuditEvent?.({
          eventType: 'federation.inbound_rejected', outcome: 'rejected',
          reason: error.code ?? 'INVALID_FEDERATION_REQUEST',
          payload: { reason: error.code ?? 'INVALID_FEDERATION_REQUEST' }, now,
        });
        if (audit?.catch) audit.catch(() => {});
        response.writeHead(error.httpStatus ?? 400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'INVALID_FEDERATION_REQUEST', message: error.message, details: {} }));
      }

      const handler = DIRECTORY_ROUTES[parsedUrl.pathname];
      let result;
      try {
        result = await repository.withTransaction(async (client) => {
          await repository.consumeRelayNonce(verified.nonce, { now, expiresAt: verified.signedAtMs + freshnessMs, client });
          return handler(verified.parsedBody, {
            repository, client, originDomain: verified.originDomain, now, request_id: requestId, relayDomain,
          });
        });
      } catch (error) {
        if (error?.code === 'RELAY_REPLAYED') {
          response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
          return response.end(JSON.stringify({ request_id: requestId, code: 'RELAY_REPLAYED', message: 'This relay request was already processed', details: {} }));
        }
        throw error;
      }
```

> The `RELAY_REQUEST_STALE` audit event (spec Section 3 "Operational visibility") is emitted in the `catch (error)` around `verifyInboundRelayRequest` above — include the `signed_at` skew in seconds in `payload` when `error.code === 'RELAY_REQUEST_STALE'`. Compute it as `Math.round((nowMs - Date.parse(parsedBodyForAudit.signed_at)) / 1000)` after a best-effort `JSON.parse(raw)`; on parse failure omit the skew.

- [ ] **Step 4: Implement — envelope route nonce consume**

`sigil/relay/v1/accept-federated-envelope.mjs`:
- Thread a freshness value: `acceptFederatedEnvelope` reads `options.relayRequestFreshnessMs` (default `300_000`) and passes `{ now, freshnessMs }` into `verifyInboundRelayRequest` (the verifier call at line 43). Update `http-server.mjs`'s `/v1/federation/envelopes` handler (line ~160-175) to pass `relayRequestFreshnessMs: freshnessMs` in the options object it builds.
- First statement inside `return repository.withTransaction(async (client) => {` (line 108, before `lookupIdempotency`): consume the nonce using the **verifier's returned values** (`relayNonce`, `relaySignedAtMs`), not a re-read of `parsedBody`. Capture them from the destructure at line 43:

```js
    let originDomain, peer, parsedBody, envelope, senderKey, senderOwnerId, relayNonce, relaySignedAtMs;
    try {
      ({ originDomain, peerRecord: peer, parsedBody, nonce: relayNonce, signedAtMs: relaySignedAtMs } = await verifyInboundRelayRequest(
        options.rawBody ?? Buffer.from(JSON.stringify(body)),
        headers,
        { getPeerByKid: (kid) => repository.getPeerByKid(kid), now, freshnessMs },
      ));
      // ...
```

  then the first transaction statement:

```js
    await repository.consumeRelayNonce(relayNonce, { now, expiresAt: relaySignedAtMs + freshnessMs, client });
```

- Catch classifier (line ~194): add `RELAY_REPLAYED: 409` to `statusByCode`.

- [ ] **Step 5: Postgres rollback-safety test**

Create `sigil/relay/v1/accept-federation-directory.rollback.pg.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { PostgresRepository } from './postgres-repository.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('B3 rollback safety: a handler that throws after consumeRelayNonce does not burn the nonce', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  const repo = new PostgresRepository({ pool });
  t.after(() => pool.end());
  await applyMigrations(connectionString, { reset: true });

  const nonce = 'ROLLBACK_00000000000000';
  await assert.rejects(repo.withTransaction(async (client) => {
    await repo.consumeRelayNonce(nonce, { expiresAt: new Date(Date.now() + 300_000), client });
    throw Object.assign(new Error('link exists'), { code: 'FEDERATION_LINK_EXISTS' });
  }));
  // a later request with the SAME nonce is accepted, because the first tx rolled back
  await repo.withTransaction(async (client) => {
    await repo.consumeRelayNonce(nonce, { expiresAt: new Date(Date.now() + 300_000), client });
  });
});
```

- [ ] **Step 6: Run — PASS**

Run: `SIGIL_TEST_DATABASE_URL=$SIGIL_TEST_DATABASE_URL timeout 600 node --test sigil/relay/v1/http-server.federation-directory.test.mjs sigil/relay/v1/accept-federated-envelope.test.mjs sigil/relay/v1/accept-federation-directory.rollback.pg.test.mjs sigil/relay/v1/http-server.federation-inbound.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add sigil/relay/v1/http-server.mjs sigil/relay/v1/accept-federated-envelope.mjs sigil/relay/v1/http-server.federation-directory.test.mjs sigil/relay/v1/accept-federated-envelope.test.mjs sigil/relay/v1/accept-federation-directory.rollback.pg.test.mjs
git commit -m "feat(relay): consume relay-request nonce inside each handler transaction (B3)"
```

---

## Task 11: B3 reaper — rebuild confirmation/revocation each pass; delete the redemption path

**Files:**
- Modify: `sigil/relay/v1/federation-reaper.mjs` (module header; `PATH_BY_KIND`; `dispatchDirectoryRow`; delete `writeRedeemerLink` and the `directory_redemption` follow-up branch at lines ~210-217)
- Test: `sigil/relay/v1/federation-reaper.test.mjs` (rewrite the directory-row cases)

**Interfaces:**
- Consumes: `buildConfirmationRequest({ linkRef, now })` / `buildRevocationRequest({ linkRef, now })` (Task 5 — each mints a fresh nonce + `signed_at`), `signRelayRequest`.
- Produces:
  - The enqueued `directory_payload` for a `directory_confirmation` / `directory_revocation` row stores only `{ link_ref }` (set by Task 13's CLI callers — the `link confirm` / `link revoke` paths at `sigil.mjs` ~1264 and ~1342; update those `directoryPayload: body` sites to `directoryPayload: { link_ref: linkRef }`).
  - `dispatchDirectoryRow` rebuilds the request each pass: `const built = row.kind === 'directory_confirmation' ? buildConfirmationRequest({ linkRef: row.directoryPayload.link_ref, now }) : buildRevocationRequest({ linkRef: row.directoryPayload.link_ref, now });` then `signRelayRequest(built.canonicalBytes, identity)`. The `FORWARD_BUILD_FAILED` dead-letter guard wraps the `build*Request` + `canonicalJsonBytes` call.
  - `PATH_BY_KIND` loses `directory_redemption`. `writeRedeemerLink` is deleted. The `if (row.kind !== 'directory_redemption' ...)` follow-up block is deleted (no directory kind has post-settle work now).
  - Module header comment updated: directory rows are **rebuilt** through the builders each pass (no longer "signed verbatim").

- [ ] **Step 1: Rewrite the reaper directory tests (failing)**

In `sigil/relay/v1/federation-reaper.test.mjs`:
- Delete / replace `'directory_redemption 2xx with an issuer body writes the redeemer link once...'` (line ~443) — there is no redemption path any more. Replace with:

```js
test('B3: a directory_confirmation row is re-signed with a fresh nonce + signed_at on every pass', async () => {
  // arrange: enqueue a directory_confirmation row whose directory_payload is { link_ref }
  // a stubbed postDirectoryImpl records each outbound canonicalBytes; first pass throws
  // FORWARD_TRANSPORT_FAILED, second pass returns { ok: true, status: 202 }
  const sent = [];
  const postDirectoryImpl = async (_peer, _path, canonicalBytes) => {
    sent.push(JSON.parse(Buffer.from(canonicalBytes).toString('utf8')));
    if (sent.length === 1) throw Object.assign(new Error('down'), { code: 'FORWARD_TRANSPORT_FAILED' });
    return { ok: true, status: 202 };
  };
  // ... run two runFederationReaperPass calls with `now` advanced between them ...
  assert.notEqual(sent[0].nonce, sent[1].nonce);
  assert.notEqual(sent[0].signed_at, sent[1].signed_at);
  assert.match(sent[1].nonce, /^[A-Za-z0-9_-]{22}$/);
});
```

Fill this against the file's real reaper harness (it already builds a fake repository with `claimDueFederationForwards` / `finalizeFederationForward`; reuse it). Also update any `PATH_BY_KIND` / `directory_redemption` assertions elsewhere in the file.

- [ ] **Step 2: Run — verify failure**

Run: `timeout 300 node --test sigil/relay/v1/federation-reaper.test.mjs`
Expected: FAIL — current code signs `row.directoryPayload` verbatim, so `sent[0]` has no `nonce` and both passes are byte-identical.

- [ ] **Step 3: Implement**

`sigil/relay/v1/federation-reaper.mjs`:

```js
import { buildForwardRequest, signForwardRequest, postForward } from './federation-router.mjs';
import { canonicalJsonBytes } from './jcs.mjs';
import { signRelayRequest, postDirectory, buildConfirmationRequest, buildRevocationRequest } from './federation-directory-client.mjs';

const PATH_BY_KIND = {
  directory_confirmation: '/v1/federation/directory/confirmations',
  directory_revocation: '/v1/federation/directory/revocations',
};
```

In `dispatchDirectoryRow`, replace the "sign the payload verbatim" block:

```js
  let canonicalBytes;
  let signed;
  try {
    if (!path) throw new Error(`federation reaper: unknown directory kind ${row.kind}`);
    const built = row.kind === 'directory_confirmation'
      ? buildConfirmationRequest({ linkRef: row.directoryPayload.link_ref, now })
      : buildRevocationRequest({ linkRef: row.directoryPayload.link_ref, now });
    canonicalBytes = built.canonicalBytes;
    signed = signRelayRequest(canonicalBytes, identity);
  } catch {
    // ... unchanged FORWARD_BUILD_FAILED dead-letter path ...
  }
```

Delete `writeRedeemerLink` entirely. Replace the tail of `dispatchDirectoryRow`:

```js
  await settleForward({
    repository, row, auditBase, counts, nowMs, outcome, transportFailed, transportReason,
  });
}
```

(no `directory_redemption` follow-up). Update the module header comment (lines 12-17) to state directory rows are rebuilt via the builders each pass, carrying a fresh nonce + `signed_at`.

- [ ] **Step 4: Update the CLI enqueue payloads for confirm/revoke**

`sigil/cli/sigil.mjs` lines ~1264-1276 and ~1342-1354: the `enqueueFederationForward` calls for `directory_confirmation` / `directory_revocation` set `directoryPayload: { link_ref: linkRef }` instead of `directoryPayload: body`.

- [ ] **Step 5: Run the reaper + CLI link suites — PASS**

Run: `timeout 300 node --test sigil/relay/v1/federation-reaper.test.mjs` plus the CLI `federation link` test file (grep it).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sigil/relay/v1/federation-reaper.mjs sigil/cli/sigil.mjs sigil/relay/v1/federation-reaper.test.mjs
git commit -m "feat(relay): reaper rebuilds directory confirmation/revocation each pass; drop the redemption outbox path (B3)"
```

---

## Task 12: Q4 — redact `directoryPayload` from `outbox show`

**Files:**
- Modify: `sigil/cli/sigil.mjs` (`cmdFederationOutbox` `show`, line ~829)
- Test: the CLI federation-outbox test file (grep `outbox show` under `sigil/cli/*.test.mjs`); add a case there, or create `sigil/cli/sigil.federation-outbox-show.test.mjs`.

**Interfaces:**
- Produces: `outbox show <id>` output never contains a `directoryPayload` key and never the substring `sigil-fed-invite:`.

- [ ] **Step 1: Failing test**

```js
test('Q4: outbox show strips directoryPayload (no invite code leak)', async () => {
  // arrange: a fake repository whose getFederationOutboxRow returns a directory_confirmation
  // record with directoryPayload: { link_ref: '...' } and (worst case) a stale code field
  // act: run `sigil federation outbox show <id>` capturing stdout
  // assert: output has no 'directoryPayload' key and no 'sigil-fed-invite:' substring
});
```

- [ ] **Step 2: Run — verify failure**

Run: `timeout 120 node --test <that test file>`
Expected: FAIL — current `show` prints `directoryPayload`.

- [ ] **Step 3: Implement**

`sigil/cli/sigil.mjs` line ~829:

```js
      const { envelope, senderKey, claimToken, claimedAt, directoryPayload, ...meta } = record;
      console.log(JSON.stringify(meta, null, 2));
```

- [ ] **Step 4: Run — PASS**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/cli/sigil.mjs <that test file>
git commit -m "fix(cli): redact directoryPayload from federation outbox show (Q4)"
```

---

## Task 13: Q4 — redemption loses durable retry

**Files:**
- Modify: `sigil/cli/sigil.mjs` (`cmdFederationInviteRedeem`, the `catch` at lines ~1071-1086)
- Test: the CLI redeem test file (same file as Task 9); add two cases.

**Interfaces:**
- Produces: on a `FORWARD_TRANSPORT_FAILED` from the issuer POST, `cmdFederationInviteRedeem` prints
  `issuer relay unreachable; re-run 'sigil federation invite redeem <code>' when it is back`
  and sets `process.exitCode = 1`. It writes **no** `federation_outbox` row. Confirmation/revocation retry paths are untouched.

- [ ] **Step 1: Failing tests**

```js
test('Q4: a redemption transport failure writes no outbox row and exits non-zero', async () => {
  // arrange: fake repository with a spy on enqueueFederationForward; postDirectory stub throws
  // Object.assign(new Error('down'), { code: 'FORWARD_TRANSPORT_FAILED' })
  // act: run cmdFederationInviteRedeem
  // assert: enqueueFederationForward NOT called; process.exitCode === 1;
  //         stderr/stdout contains "re-run 'sigil federation invite redeem"
});

test('Q4 recovery: after "issuer committed, response lost", a second redeem run converges', async () => {
  // arrange: issuer stub returns an idempotent 202 with a valid issuer block;
  //          the local link row already exists (createFederationDirectoryLink throws FEDERATION_LINK_EXISTS)
  // act: run cmdFederationInviteRedeem
  // assert: exits 0, no throw, prints the linkRef / "waiting for issuer confirmation."
});
```

- [ ] **Step 2: Run — verify failure**

Expected: FAIL — the first test sees `enqueueFederationForward` called.

- [ ] **Step 3: Implement**

`sigil/cli/sigil.mjs` — replace the `if (error && error.code === 'FORWARD_TRANSPORT_FAILED') { ... }` block inside the redeem `catch`:

```js
    } catch (error) {
      if (error && error.code === 'FORWARD_TRANSPORT_FAILED') {
        console.error(`issuer relay unreachable; re-run 'sigil federation invite redeem ${code}' when it is back`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
```

- [ ] **Step 4: Run — PASS**

Run: `timeout 300 node --test sigil/cli/sigil.federation-invite-redeem.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sigil/cli/sigil.mjs sigil/cli/sigil.federation-invite-redeem.test.mjs
git commit -m "fix(cli): drop durable retry for invite redemption; re-run on transport failure (Q4)"
```

---

## Task 14: STATUS.md accuracy + full-suite green + rollout-precondition verification

**Files:**
- Modify: `STATUS.md`
- No new test code; this task is the branch-level verification gate.

- [ ] **Step 1: Fix the STATUS.md replay claim**

Find the line claiming "timestamp, replay, and domain pinning validation" for federation inbound. Rewrite it to state what is now true: relay-to-relay requests carry a `nonce` + `signed_at`; `verifyInboundRelayRequest` enforces a configurable freshness window (`relayRequestFreshnessMs`, default 300 s) and the 22-char base64url nonce format; each handler consumes the nonce inside its transaction against `federation_relay_nonces`; redeemer/issuer owner-id domains are pinned on both sides.

- [ ] **Step 2: Run the whole non-DB suite**

Run: `timeout 600 node --test`
Expected: 0 failures. The SDD ledger tracks a per-task test-count delta as each task lands; the final non-DB pass count is `812 + (tests added) - (tests deleted: the reaper directory_redemption case in Task 11) ± (tests moved/rewritten: Tasks 4, 5, 7, 10, 11)`. Reconcile the recorded number against that running total — a drop the ledger does not explain is a regression. (Eng-review finding D.)

- [ ] **Step 3: Run the whole live-DB suite**

Run: `SIGIL_TEST_DATABASE_URL=$SIGIL_TEST_DATABASE_URL timeout 600 node --test`
Expected: ≥ baseline 112 pass, 0 failures. Record the numbers.

- [ ] **Step 4: Verify the spec Section 7 rollout preconditions against the test DB**

```bash
psql "$SIGIL_TEST_DATABASE_URL" -c "SELECT count(*) FROM federation_directory_links"          # expect 0
psql "$SIGIL_TEST_DATABASE_URL" -c "SELECT count(*) FROM federation_outbox WHERE kind='directory_redemption'"  # expect 0
psql "$SIGIL_TEST_DATABASE_URL" -c "\d federation_directory_links"   # constraint names match Task 1's DO block
```

Record the results in the branch notes for the re-review.

- [ ] **Step 5: Commit**

```bash
git add STATUS.md
git commit -m "docs(status): federation inbound now enforces nonce + freshness + owner-domain pinning"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task(s) |
|---|---|
| Section 1 — B1 remove same-owner exemption (behavior) | Task 7 |
| Section 1 — migration 019 CHECK replacements + DO-block name assertions | Task 1 |
| Section 1 — CLI/handler `initiated_via: 'self_pair'`, `createFederationDirectoryLink` gains `initiatedVia` | Task 6 |
| Section 1 — memory relay also requires a link row; self-pair inserted directly | Task 7 Step 3 |
| Section 2 — B2 pin `redeemer.owner_id` domain | Task 8 |
| Section 2 — E2 `assertIssuerResponseIdentity` + CLI reject/audit/exit | Task 9 |
| Section 3 — nonce table (migration 019) | Task 1 |
| Section 3 — `consumeRelayNonce` / `pruneRelayNonces` both repositories | Task 2 |
| Section 3 — signed-body contract: `nonce` + `signed_at`, drop 4 timestamp fields | Task 5 |
| Section 3 — `verifyInboundRelayRequest` freshness + nonce-format, returns `nonce`/`signedAtMs` | Task 4 |
| Section 3 — handlers consume the nonce inside the transaction; `RELAY_REPLAYED` → 409 | Task 10 |
| Section 3 — freshness config `relayRequestFreshnessMs` clamp + startup log | Tasks 3, 10 |
| Section 3 — `RELAY_REQUEST_STALE` audit event with skew | Task 10 Step 3 |
| Section 3 — reaper rebuilds confirmation/revocation each pass; header comment | Task 11 |
| Section 3 — reaper drops `directory_redemption`, `writeRedeemerLink`, `PATH_BY_KIND` key | Task 11 |
| Section 4 — `outbox show` strips `directoryPayload` | Task 12 |
| Section 4 — redemption loses durable retry; re-run message; no outbox row | Task 13 |
| Section 4 — migration 019 scrubs pre-019 redemption rows | Task 1 |
| Section 4 — recovery semantics (idempotent 202 + `FEDERATION_LINK_EXISTS` catch) | Task 13 Step 1 |
| Section 5 — every listed test | Tasks 1, 4, 7, 8, 9, 10, 11, 12, 13 (see per-task Step 1) |
| Section 5 — Task 9/17 timestamp-field test moves to `signed_at` | Task 5 Step 5 |
| Section 6 — every file touched | mapped in File Structure |
| Section 7 — rollout preconditions verified | Task 14 Step 4 |
| Section 8 — re-review `b11dfc3..HEAD` then `finishing-a-development-branch` | after Task 14 (see Execution Handoff) |

No gaps.

**2. Placeholder scan**

Tasks 10 Step 1, 11 Step 1, 12 Step 1, 13 Step 1 contain test bodies written as prose comments ("arrange / act / assert") rather than literal code, because the exact harness (fake-repository shape, signed-request helper, stdout capture) lives in the target test file and must be read at implementation time. Each such step names the specific harness to reuse and the exact assertions required. The executor **must** fill them with real code — they are marked "do not leave as comments". This is the one deliberate exception; every schema, migration, repository method, handler edit, and builder is literal.

**3. Type consistency**

- `consumeRelayNonce(nonce, { now, expiresAt, client })` — identical signature in Task 2 (both repos), Task 10 (both call sites).
- `verifyInboundRelayRequest(rawBody, headers, { getPeerByKid, now, freshnessMs })` returning `{ ok, originDomain, peerRecord, parsedBody, nonce, signedAtMs }` — defined Task 4, consumed Task 10.
- `resolveRelayRequestFreshnessMs(raw)` — defined Task 3, used Task 10 (`http-server.mjs`).
- `newRelayNonce()` — defined Task 5 (`federation-directory-client.mjs`), imported by `federation-router.mjs` (Task 5) and `federation-reaper.mjs` (Task 11 via the builders, not directly).
- `assertIssuerResponseIdentity(issuer, issuerDomain)` throwing `{ code: 'ISSUER_IDENTITY_DOMAIN_MISMATCH' }` — defined Task 9, consumed Task 9 (CLI).
- `createFederationDirectoryLink(row)` with `row.initiatedVia` — extended Task 6, called with `initiatedVia` in Tasks 6, 7 (test), 9 (CLI, unchanged call already there).
- Builder bodies: `{ link_ref, nonce, signed_at }` for confirmation/revocation; `{ link_ref, code, redeemer, redeemer_domain, nonce, signed_at }` for redemption; `{ origin_domain, envelope, sender_key, sender_owner_id, nonce, signed_at }` for forward — consistent Task 5, Task 11.
- `directory_payload` for confirmation/revocation outbox rows is `{ link_ref }` — set Task 11 Step 4, read Task 11 Step 3.

Consistent.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-06-sigil-federation-directory-security.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. **REQUIRED SUB-SKILL:** `superpowers:subagent-driven-development`. Baseline to record in the ledger: non-DB `node --test` 812 pass / 0 fail / 103 skip; live-DB 112 pass. Task 7 is ordering-locked (single commit, RED + GREEN). Tasks 1, 2, 6, 10 have Postgres-gated tests — the runner needs `SIGIL_TEST_DATABASE_URL` (local pg `localhost:55432`, `sigil:sigil_password` / `sigil_test`) for those steps; without it they skip and must be re-run with the DB before the re-review.

**2. Inline Execution** — batch execution with checkpoints. **REQUIRED SUB-SKILL:** `superpowers:executing-plans`.

**After the last task:** re-run the whole-branch review against `b11dfc3..HEAD`, then `superpowers:finishing-a-development-branch`. Do not push before a human-reviewed final step approves it.

**Hard stop now:** run `/plan-eng-review` on this plan before the first implementation commit.

---

## NOT in scope (deferred, with rationale)

- **`pruneRelayNonces` scheduler wiring** — the method exists (Task 2) but no periodic caller. Spec-sanctioned; growth bounded by freshness window × request rate on a pre-GA fleet. TODO below.
- **Dead `verifyRelaySignature` export in `federation-router.mjs`** — spec Non-goals; final-review cleanup pass.
- **Memory/Postgres directory-method parity gaps** beyond the nonce store — spec Non-goals.
- **Migration 018 `ADD CONSTRAINT` lock strategy on `federation_outbox`** — spec Non-goals; 018 is not amended.
- **CLI ergonomics findings G3/G5/G6** — spec Non-goals.
- **`sender_owner_id` domain pinning** — deliberately not pinned (spec Section 1): #3's `--federation-owner` lets one owner id live on two relays under a non-relay domain. Pinning breaks that supported case.
- **`federation_outbox_kind_check` still permits `directory_redemption`** — intentional backward tolerance for any pre-019 row; the write path is gone.

## What already exists (reused, not rebuilt)

- **`consumeLoginJti` / `login_jti_replays`** (`postgres-repository.mjs:1023`, migrations 013/015) — `consumeRelayNonce` / `federation_relay_nonces` copy this shape verbatim (`23505` → domain error, `client` param for tx-scoped consume).
- **`getActiveFederationDirectoryLink(localOwnerId, remoteOwnerId, remoteDomain, client)`** (`postgres-repository.mjs:1425`) — already role-agnostic and `status='active'`-filtered; matches a self-pair row with no repository change (Task 7 reuses it as-is).
- **`federation_directory_links_live_pair_uidx`** partial unique index — already prevents duplicate self-pair links; no new uniqueness needed.
- **Handler state-idempotency** (redemption idempotent 202, confirm/revoke 202 no-op, envelope duplicate 202) — the replay design leans on these existing paths instead of adding reaper replay rules; spec Section 7 gates on their tests passing on HEAD first.
- **`verifyInboundRelayRequest`** (`federation-relay-auth.mjs`) — extended in place (freshness + nonce format), not replaced.
- **`buildForwardRequest` / `build{Redemption,Confirmation,Revocation}Request`** — extended to emit `nonce` + `signed_at`; envelope-reaper rebuild path (`federation-reaper.mjs:280`) already re-runs the builder each pass, so it picks up fresh values for free.
- **`fdlRowView`, `withTransaction`(`fn(null)`), memory `createFederationDirectoryLink`** — memory suite path for the self-pair link (no owner-distinctness CHECK on the memory repo).

## Failure modes (new codepaths)

| Codepath | Realistic prod failure | Test? | Error handling? | Visible? |
|---|---|---|---|---|
| `verifyInboundRelayRequest` freshness | Relay clock drift > 300 s → legit peer requests rejected `RELAY_REQUEST_STALE`/401 | yes (Task 4, Task 10) | yes — 401 + audit event with skew seconds (Task 10 Step 3) | yes — audit `federation.inbound_rejected`; spec Section 7 says record observed fleet skew |
| `consumeRelayNonce` inside tx | Handler throws after consume → nonce must NOT be burned | yes — Postgres rollback-safety test (Task 10 Step 5); memory NOT rollback-safe (spec-accepted, dev/test only) | yes — `RELAY_REPLAYED` → 409 | yes — 409 to caller; reaper surfaces as `forward_rejected` terminal |
| `federation_relay_nonces` growth | prune unwired → table grows until manual `DELETE` | no (deferred) | none | no — silent until DB bloat. **Bounded** by freshness window × request rate; pre-GA. Finding C TODO. |
| B1 exemption removal | Same-owner federated delivery with no self-pair link → 403 where it used to 202 | yes (Task 7 RED + GREEN; `federation-regression.test.mjs:154` updated) | yes — `DIRECTORY_LINK_REQUIRED`/403 | yes — 403 to sender |
| Redemption loses durable retry (Q4) | Issuer relay down at redeem time → no outbox row, operator must re-run | yes (Task 13) | yes — `process.exitCode = 1` + explicit re-run message | yes — stderr line names the exact command |
| Migration 019 CHECK replacement | 018 constraint name differs from assumption → migration aborts | yes (Task 1 live-DB) | yes — `DO`-block `RAISE EXCEPTION` fails the migration loudly | yes — migration error names the missing constraint |

No critical gap (no failure mode is simultaneously untested **and** unhandled **and** silent). The prune-growth row is unhandled + silent but has a test-independent bound and a filed TODO.

## TODOS.md

- **Wire `pruneRelayNonces` to a periodic maintenance path.** *Why:* `federation_relay_nonces` grows one row per inbound relay request with no reaper; bounded only by freshness-window × rate. *Context:* method lands in Task 2 (both repos); spec Section 3 defers the scheduler. Co-locate with a future `pruneLoginJti` sweep — neither has one today. *Depends on:* this branch merged. *Blocked by:* nothing.

## Worktree parallelization

Sequential implementation, no parallelization opportunity — every task funnels through `federation-relay-auth.mjs` / `accept-federated-envelope.mjs` / `accept-federation-directory.mjs` / `sigil.mjs`, and Tasks 4→5→10, 1→6→7, 11→13 have hard ordering deps. Run task-by-task via SDD.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | skipped | outside voice skipped — plan-text findings only, no cross-model tension |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_found (folded) | 5 issues (A–E); A–D folded into plan, E needs no change; 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a — relay/CLI security, no UI |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **VERDICT:** ENG CLEARED — architecture sound, spec APPROVED, coverage table complete; findings A–D folded, E is a non-issue (plan already carries a `\d federation_outbox` note). Ready to implement via `superpowers:subagent-driven-development`.

NO UNRESOLVED DECISIONS
