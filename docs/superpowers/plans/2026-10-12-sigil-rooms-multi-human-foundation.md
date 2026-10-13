# Sigil rooms multi-human foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a second human safely exist in a Sigil room: Postgres is the only trust source, humans are provisioned from the operator CLI with relay-custodial keys, agent invocation is policy-gated per human, and a human can be suspended live.

**Architecture:** `endpoints`/`endpoint_keys` in Postgres replace the startup `registry.json` Map as the trust source, read per use on the caller's client. A CLI process changes state in its own transaction and `pg_notify('sigil_admin', ...)` inside it, and the relay's `LISTEN` connection clears the authenticator cache and revalidates sockets. Invocation authority is a `subject_human_id` stored on every `room_invocations` row and inherited across agent hops.

**Tech Stack:** Node ESM (`node --test`), `pg`, Postgres 15, `ws`. React/Vite client in `packages/sigil-rooms-web` (Task 16 only).

**Spec:** `docs/superpowers/specs/2026-10-11-sigil-rooms-multi-human-foundation-design.md` (read it first; this plan cites it as "spec"). The login spec (`...-third-party-login-design.md`) gets its own plan after this one lands.

## Global Constraints

- Work only in `C:\dev\.worktrees\sigil-third-party-login`, branch `docs/sigil-rooms-third-party-login-spec`. Before any work run `pwsh -NoProfile -File C:/dev/scripts/verify-repo-context.ps1 -Path C:/dev/.worktrees/sigil-third-party-login` (forward slashes; backslashes break in Git Bash). No push, no PR unless asked.
- Paths below are relative to `sigil/` unless they start with `packages/` or `docs/`. Relay code is `relay/v1/`.
- Unit tests: `timeout 60 node --test <file>`. Postgres tests read `SIGIL_TEST_DATABASE_URL` and skip without it (local: `postgres://sigil:sigil_password@localhost:55432/sigil_test`). They call `assertDisposableTestDatabase` and `applyMigrations(url, { reset: true })`. **Run one `node --test` process at a time.** Overlapping runs deadlock the shared pg (past incident).
- Use `sed -i` for token-only edits in CRLF files. The Edit tool rewrites whole CRLF files to LF and creates diff churn.
- Migration number is 033 on this checkout (highest is `032_room_task_assignee.sql`). Re-check with `ls sigil/migrations | tail -3` at execution and renumber if `main` moved.
- Every `INSERT INTO endpoints` sets `kind` explicitly (column has no default).
- A key verifies only when `status IN ('active','retiring')` and now is in `[valid_from, valid_until)`; `active` has null `valid_until`; `retiring` requires non-null `valid_until`; `retired` never verifies.
- Key wrap: AES-256-GCM, 96-bit IV, AAD `endpoint_id + "\0" + key_id`, layout `iv(12)||tag(16)||ciphertext`, plaintext PKCS8 DER, wrap key = 32 random bytes base64 from `--room-key-wrap-key <ref>` (env var or Doppler, never argv).
- `pg_notify` payloads are fixed-size `{ type, human_id?, endpoint_id?, room_ids? }` (< 8000 bytes) and sent inside the caller's transaction.
- Commit tags: `feat(sigil):`, `test(sigil):` when a commit mostly adds tests. End commit messages with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## File structure

| File | Responsibility |
| --- | --- |
| `migrations/033_multi_human_foundation.sql` (+ `.test.mjs`) | Schema for kind, suspension, signing keys, invokable_by, subject_human_id |
| `relay/v1/trusted-endpoint.mjs` (new) | Pure: `keyVerifies`, `toTrustedEntry`, `entryFromRegistryRow` |
| `relay/v1/key-wrap.mjs` (new) | `wrapPrivateKey`, `unwrapPrivateKey`, `loadWrapKey` |
| `relay/v1/provision-human.mjs` (new) | `provisionHumanTx`, `addHumanToRoomsTx`, `lockManagerRows` |
| `relay/v1/admin-notify.mjs` (new) | `publishAdmin(client, payload)`, `startAdminListener(...)` |
| `relay/v1/invoke-policy.mjs` (new) | `mayInvoke` |
| `relay/v1/postgres-repository.mjs` | `lookupTrustedEndpoint`, kind writers, key retire, provisioning-adjacent queries |
| `relay/v1/validate-envelope.mjs`, `accept-envelope.mjs`, `accept-federated-envelope.mjs`, `room-policy.mjs`, `room-routes.mjs`, `transport-auth.mjs`, `room-human-signer.mjs`, `stream-server.mjs`, `room-dispatch.mjs`, `room-invocations` code | Consumers migrated |
| `cli/sigil.mjs` | Seed, flags, `human`/`agent`/`endpoint` subcommands |

## Interfaces fixed up front

```js
// relay/v1/trusted-endpoint.mjs
export function keyVerifies(key, now = new Date()) // -> boolean
export function entryFromRegistryRow(row)          // memory-mode normalizer, row from toRegistryMap
// Entry shape (spec "Trusted endpoint lookup")
// { endpoint_id, owner_id, kind: 'human'|'agent'|'system', status,
//   keys: Map<key_id, { key_id, public_key: KeyObject, status, valid_from, valid_until }> }
repository.lookupTrustedEndpoint(endpointId, client = this.pool) // -> entry | null, origin_domain IS NULL only
repository.lookupRecipientEndpoint(endpointId, client)           // adds kind to existing row
// relay/v1/key-wrap.mjs
wrapPrivateKey({ wrapKey, endpointId, keyId, privateKey }) // -> Buffer
unwrapPrivateKey({ wrapKey, endpointId, keyId, wrapped })  // -> KeyObject (private)
// relay/v1/provision-human.mjs
provisionHumanTx(client, { displayName, attributes, repository, wrapKey, now }) // -> { human_id, endpoint_id, key_id }
lockManagerRows(client, humanId, roomIds)                   // -> rows
addHumanToRoomsTx(client, { endpointId, memberships, actorHumanId, repository, now })
// relay/v1/invoke-policy.mjs
mayInvoke(subjectHumanId, targetAgent) // targetAgent: { owner_id, invokable_by }
// relay/v1/admin-notify.mjs
publishAdmin(client, payload) // pg_notify inside caller's tx
```

---

### Task 1: Inventory every registry-Map and `INSERT INTO endpoints` site

**Files:**
- Create: `docs/superpowers/plans/2026-10-12-foundation-callsite-inventory.md`

**Interfaces:** Produces the checklist Tasks 3-5 and 11-12 close out.

- [ ] **Step 1: Run the greps and record results**

```bash
cd /c/dev/.worktrees/sigil-third-party-login
grep -rnE "registry(\.|\?\.)(get|set|has)\b|registered(\.|\?\.)(get|set|has)\b|instanceof Map" sigil --include=*.mjs | grep -v node_modules > /tmp/map-sites.txt
grep -rn "INSERT INTO endpoints" sigil --include=*.mjs --include=*.sql | grep -v node_modules > /tmp/endpoint-inserts.txt
wc -l /tmp/map-sites.txt /tmp/endpoint-inserts.txt
```

Use the scratchpad directory instead of `/tmp` if it is not writable.

- [ ] **Step 2: Write the inventory file**

Two tables (`Map consumer` / `INSERT INTO endpoints`), one row per hit: `file:line`, production or test, owner task. Production Map sites known from the spec and assigned: `validate-envelope.mjs:97` (T3), `accept-envelope.mjs:303,373-374` (T4), `accept-federated-envelope.mjs:150-155,196` (T4), `forwardEnvelope` `accept-envelope.mjs:496-507` (T4), `p2p-data-protocol.mjs:76-79` (T4), `agentmail-adapter.mjs:160-162` (T4), `room-policy.mjs:91-93` (T4), `room-routes.mjs:191-195` (T4), `room-human-signer.mjs:16` (T11), `transport-auth.mjs` (T5), `sigil.mjs:237-264,327` (T6, T12). Add every other hit the grep finds. Test fixtures that insert endpoints go in the second table with owner task T5.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-10-12-foundation-callsite-inventory.md
git commit -m "docs(sigil): inventory registry Map and endpoint insert sites for multi-human foundation"
```

---

### Task 2: Migration 033

**Files:**
- Create: `migrations/033_multi_human_foundation.sql`, `migrations/033_multi_human_foundation.test.mjs`

**Interfaces:** Produces columns/tables used by every later task: `endpoints.kind`, `endpoints.suspended_by_human_id`, partial unique index `endpoint_keys_one_active_idx`, `human_signing_keys`, `conversation_members.invokable_by`, `room_invocations.subject_human_id`.

- [ ] **Step 1: Write failing tests** (`033_multi_human_foundation.test.mjs`)

```js
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../scripts/apply-migrations.mjs';

const sql = fs.readFileSync(new URL('./033_multi_human_foundation.sql', import.meta.url), 'utf8');
const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('033 declares every column and index the foundation relies on', () => {
  for (const pattern of [
    /ADD COLUMN kind TEXT/, /CHECK \(kind IN \('human','agent','system'\)\)/, /suspended_by_human_id TEXT/,
    /CREATE UNIQUE INDEX endpoint_keys_one_active_idx ON endpoint_keys \(endpoint_id\) WHERE status = 'active'/,
    /CREATE TABLE human_signing_keys/, /invokable_by TEXT NOT NULL DEFAULT 'owner'/, /subject_human_id TEXT/,
  ]) assert.match(sql, pattern);
});

test('033 backfills kind, retires surplus shadow keys, backfills subject', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true, through: '032' });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const s = crypto.randomUUID().replaceAll('-', '_');
  await pool.query(`INSERT INTO humans (human_id,status,created_at) VALUES ($1,'active',NOW())`, [`h_${s}`]);
  for (const [id, runtime, origin] of [[`relay_${s}`, 'relay', null], [`hum_${s}`, 'human', null], [`ag_${s}`, 'claude', null], [`fed_${s}`, 'federated', 'peer.example']]) {
    await pool.query(`INSERT INTO endpoints (endpoint_id,owner_id,runtime,installation_id,display_name,status,origin_domain,created_at) VALUES ($1,$2,$3,$4,$1,'active',$5,NOW())`, [id, `h_${s}`, runtime, `i_${id}`, origin]);
  }
  for (const k of ['a', 'b']) await pool.query(`INSERT INTO endpoint_keys (key_id,endpoint_id,algorithm,public_key,status,valid_from) VALUES ($1,$2,'Ed25519',$3,'active',NOW())`, [`k${k}_${s}`, `fed_${s}`, Buffer.alloc(32, 1)]);
  await applyMigrations(connectionString);
  const kinds = Object.fromEntries((await pool.query(`SELECT endpoint_id, kind FROM endpoints WHERE endpoint_id LIKE '%${s}'`)).rows.map((r) => [r.endpoint_id.split('_')[0], r.kind]));
  assert.deepEqual(kinds, { relay: 'system', hum: 'human', ag: 'agent', fed: 'agent' });
  const active = await pool.query(`SELECT count(*)::int AS n FROM endpoint_keys WHERE endpoint_id = $1 AND status = 'active'`, [`fed_${s}`]);
  assert.equal(active.rows[0].n, 1);
  await assert.rejects(pool.query(`INSERT INTO endpoint_keys (key_id,endpoint_id,algorithm,public_key,status,valid_from) VALUES ($1,$2,'Ed25519',$3,'active',NOW())`, [`kc_${s}`, `fed_${s}`, Buffer.alloc(32, 2)]), { code: '23505' });
});

test('033 fails naming a local endpoint with two active keys', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true, through: '032' });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const s = crypto.randomUUID().replaceAll('-', '_');
  await pool.query(`INSERT INTO humans (human_id,status,created_at) VALUES ($1,'active',NOW())`, [`h_${s}`]);
  await pool.query(`INSERT INTO endpoints (endpoint_id,owner_id,runtime,installation_id,display_name,status,created_at) VALUES ($1,$2,'claude',$3,$1,'active',NOW())`, [`dup_${s}`, `h_${s}`, `i_${s}`]);
  for (const k of ['a', 'b']) await pool.query(`INSERT INTO endpoint_keys (key_id,endpoint_id,algorithm,public_key,status,valid_from) VALUES ($1,$2,'Ed25519',$3,'active',NOW())`, [`k${k}_${s}`, `dup_${s}`, Buffer.alloc(32, 1)]);
  await assert.rejects(applyMigrations(connectionString), (e) => e.message.includes(`dup_${s}`));
});
```

Before writing `through: '032'`, read `scripts/apply-migrations.mjs`. If it has no partial-apply option, add `through` (apply files whose numeric prefix is `<=` the value) in this step, with its own assertion in `scripts/apply-migrations.test.mjs` if that file exists.

- [ ] **Step 2: Run, expect FAIL** (`timeout 60 node --test migrations/033_multi_human_foundation.test.mjs`): first test fails, ENOENT on the sql file.

- [ ] **Step 3: Write `033_multi_human_foundation.sql`**

```sql
-- Multi-human foundation: kind, suspension marker, one active signing key,
-- custodial key wraps, per-agent invocation policy, invocation subject.

ALTER TABLE endpoints ADD COLUMN kind TEXT;
UPDATE endpoints SET kind = CASE runtime WHEN 'relay' THEN 'system' WHEN 'human' THEN 'human' ELSE 'agent' END;
ALTER TABLE endpoints ALTER COLUMN kind SET NOT NULL;
ALTER TABLE endpoints ADD CONSTRAINT endpoints_kind_check CHECK (kind IN ('human','agent','system'));
ALTER TABLE endpoints ADD COLUMN suspended_by_human_id TEXT NULL REFERENCES humans(human_id);

-- Shadow (federated) endpoints: keep only the newest active key.
UPDATE endpoint_keys k SET status = 'retired', valid_until = NOW()
 WHERE k.status = 'active'
   AND EXISTS (SELECT 1 FROM endpoints e WHERE e.endpoint_id = k.endpoint_id AND e.origin_domain IS NOT NULL)
   AND EXISTS (SELECT 1 FROM endpoint_keys n WHERE n.endpoint_id = k.endpoint_id AND n.status = 'active'
                AND (n.valid_from, n.key_id) > (k.valid_from, k.key_id));

DO $$
DECLARE dup TEXT;
BEGIN
  SELECT string_agg(endpoint_id, ', ') INTO dup FROM (
    SELECT endpoint_id FROM endpoint_keys WHERE status = 'active' GROUP BY endpoint_id HAVING count(*) > 1
  ) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'endpoints with more than one active key, retire the extras by hand: %', dup;
  END IF;
END $$;
CREATE UNIQUE INDEX endpoint_keys_one_active_idx ON endpoint_keys (endpoint_id) WHERE status = 'active';

CREATE TABLE human_signing_keys (
  key_id TEXT PRIMARY KEY REFERENCES endpoint_keys(key_id),
  wrapped_private_key BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE conversation_members ADD COLUMN invokable_by TEXT NOT NULL DEFAULT 'owner' CHECK (invokable_by IN ('owner','members'));

ALTER TABLE room_invocations ADD COLUMN subject_human_id TEXT REFERENCES humans(human_id);
UPDATE room_invocations i SET subject_human_id = e.sender_owner_id
  FROM envelopes e WHERE e.message_id = i.trigger_message_id;
DO $$
DECLARE missing TEXT;
BEGIN
  SELECT string_agg(invocation_id, ', ') INTO missing FROM room_invocations WHERE subject_human_id IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'room_invocations without a matching trigger envelope: %', missing;
  END IF;
END $$;
ALTER TABLE room_invocations ALTER COLUMN subject_human_id SET NOT NULL;
```

Confirm the `envelopes` column names (`sender_owner_id`, `message_id`) against `migrations/001_initial.sql` and adjust if they differ.

- [ ] **Step 4: Run, expect PASS**; then run `timeout 120 node --test migrations/` for earlier migrations.
- [ ] **Step 5: Commit** `feat(sigil): migration 033 multi-human foundation schema`.

---

### Task 3: Trusted-entry helpers, `lookupTrustedEndpoint`, `validateEnvelope`

**Files:**
- Create: `relay/v1/trusted-endpoint.mjs`, `relay/v1/trusted-endpoint.test.mjs`
- Modify: `relay/v1/validate-envelope.mjs:89-110`, `relay/v1/postgres-repository.mjs` (new method beside `lookupRecipientEndpoint` at ~273), `cli/registry-store.mjs:30-45`, `relay/v1/validate-envelope.test.mjs`
- Test: `relay/v1/postgres-repository.trusted-endpoint.pg.test.mjs` (new)

**Interfaces:** Produces `keyVerifies`, `entryFromRegistryRow`, `repository.lookupTrustedEndpoint`. Consumed by Tasks 4, 5, 11, 12.

- [ ] **Step 1: Failing unit tests** for `keyVerifies` (`trusted-endpoint.test.mjs`)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { keyVerifies } from './trusted-endpoint.mjs';

const now = new Date('2026-10-12T12:00:00Z');
const k = (over) => ({ status: 'active', valid_from: '2026-01-01T00:00:00Z', valid_until: null, ...over });

test('active key with null valid_until verifies after valid_from', () => assert.equal(keyVerifies(k({}), now), true));
test('future-dated key is rejected', () => assert.equal(keyVerifies(k({ valid_from: '2027-01-01T00:00:00Z' }), now), false));
test('retiring key verifies only inside its window', () => {
  assert.equal(keyVerifies(k({ status: 'retiring', valid_until: '2026-12-01T00:00:00Z' }), now), true);
  assert.equal(keyVerifies(k({ status: 'retiring', valid_until: '2026-10-01T00:00:00Z' }), now), false);
});
test('retiring key without valid_until never verifies', () => assert.equal(keyVerifies(k({ status: 'retiring' }), now), false));
test('retired key never verifies, even with null valid_until', () => assert.equal(keyVerifies(k({ status: 'retired' }), now), false));
test('unknown status never verifies', () => assert.equal(keyVerifies(k({ status: 'revoked' }), now), false));
```

- [ ] **Step 2: Run, expect FAIL** (module missing). **Step 3: Implement**

```js
import crypto from 'node:crypto';

export function keyVerifies(key, now = new Date()) {
  if (!key) return false;
  const t = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(t)) return false;
  const from = key.valid_from ? Date.parse(key.valid_from) : -Infinity;
  const until = key.valid_until ? Date.parse(key.valid_until) : null;
  if (key.status === 'active') return t >= from && (until === null || t < until);
  if (key.status === 'retiring') return until !== null && t >= from && t < until;
  return false;
}

// Memory mode: registry.json rows carry one top-level key. Normalize to the
// Postgres entry shape so validateEnvelope has a single code path.
export function entryFromRegistryRow(row) {
  if (!row) return null;
  return {
    endpoint_id: row.endpoint_id, owner_id: row.owner_id, status: row.status ?? 'active',
    kind: row.kind ?? 'human',
    keys: new Map([[row.key_id, { key_id: row.key_id, public_key: row.public_key, status: 'active', valid_from: new Date(0).toISOString(), valid_until: null }]]),
  };
}

export function publicKeyFromDer(der) {
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}
```

Run, expect PASS.

- [ ] **Step 4: `validate-envelope.test.mjs` additions (failing).** Using the file's existing envelope-signing helper, add: a registered entry shaped `{ keys: Map }` verifies by `key_id`; a retired key with null `valid_until` rejects `INVALID_SIGNATURE`; an entry with top-level `key_id`/`public_key` but no `keys` Map rejects (the line-97 shortcut is gone). Update any existing test fixture that relied on top-level keys to use `entryFromRegistryRow`.

- [ ] **Step 5: Change `validate-envelope.mjs`.** Replace lines 89-95 (the `keys`/`key`/window block) with:

```js
  const key = endpoint.keys instanceof Map ? endpoint.keys.get(envelope.signature.key_id) : undefined;
  if (!key?.public_key) throw reject('INVALID_SIGNATURE', 'Signature key is not registered for the endpoint');
  if (!keyVerifies(key, now)) throw reject('INVALID_SIGNATURE', 'Signature key is outside its validity window');
```

and add `import { keyVerifies } from './trusted-endpoint.mjs';`. Keep `timestamp` finite check: `if (!Number.isFinite(timestamp)) throw reject('INVALID_SIGNATURE', 'Signature key is outside its validity window');` before the lookup. The federated synthetic entry (`accept-federated-envelope.mjs:150-155`) is migrated in Task 4.

- [ ] **Step 6: `registry-store.mjs` `toRegistryMap`.** Wrap each map value with `entryFromRegistryRow` semantics while keeping `key_id`/`public_key` top-level fields for CLI consumers (`createRoomHumanSigner`, identity checks) until Task 11 removes them: set `keys` on each entry in addition to the existing fields. Add a test in `cli/registry-store.test.mjs` asserting `keys.get(key_id).public_key` equals the entry's `public_key` and `kind` stays as given (undefined when absent; defaulting to `human` is `entryFromRegistryRow`'s job).

- [ ] **Step 7: pg test + `lookupTrustedEndpoint`.** New `postgres-repository.trusted-endpoint.pg.test.mjs` (follow `rooms.pg.test.mjs` seed pattern): inserts a local endpoint with `kind='human'` and one active key whose `public_key` is a real SPKI DER from `crypto.generateKeyPairSync('ed25519')`, plus a shadow endpoint (`origin_domain='peer.example'`). Asserts: local lookup returns `{ endpoint_id, owner_id, kind:'human', status:'active', keys }` with `keys.get(id).public_key.asymmetricKeyType === 'ed25519'` (a `KeyObject`, not a Buffer); shadow lookup returns `null`; unknown returns `null`; a lookup on an uncommitted tx client sees an endpoint inserted in that tx (pool lookup does not). Implement beside `lookupRecipientEndpoint`:

```js
  async lookupTrustedEndpoint(endpointId, client = this.pool) {
    const e = await client.query(
      `SELECT endpoint_id, owner_id, kind, status FROM endpoints WHERE endpoint_id = $1 AND origin_domain IS NULL`, [endpointId]);
    if (!e.rows[0]) return null;
    const k = await client.query(
      `SELECT key_id, public_key, status, valid_from, valid_until FROM endpoint_keys WHERE endpoint_id = $1`, [endpointId]);
    return {
      ...e.rows[0],
      keys: new Map(k.rows.map((r) => [r.key_id, { ...r, public_key: crypto.createPublicKey({ key: r.public_key, format: 'der', type: 'spki' }) }])),
    };
  }
```

Also add `kind` to the `lookupRecipientEndpoint` SELECT list (`e.kind`). The memory repository gets `lookupTrustedEndpoint(id) { return entryFromRegistryRow(registry.get(id)); }` and the same `kind` on its recipient lookup; add a one-line unit test in its existing test file.

- [ ] **Step 8: Run** `timeout 60 node --test relay/v1/trusted-endpoint.test.mjs relay/v1/validate-envelope.test.mjs relay/v1/validate-envelope.skip-sender.test.mjs`, then the pg test alone. Expect PASS. **Commit** `feat(sigil): Postgres trusted-endpoint lookup and key validity rule`.

---

### Task 4: Move every Map consumer onto `lookupTrustedEndpoint`

**Files:** Modify `relay/v1/accept-envelope.mjs` (303, 373-374, ~496-507), `accept-federated-envelope.mjs` (150-155, 196), `p2p-data-protocol.mjs` (76-79, under `relay/v1/transport-libp2p/` if that is where `grep` places it), the agentmail adapter (`agentmail-adapter.mjs:160-162`), `room-policy.mjs:91-93`, `room-routes.mjs:191-195`; their existing tests. Close every row of the Task 1 inventory owned by T4.

**Interfaces:** Consumes `lookupTrustedEndpoint`, `lookupRecipientEndpoint`. Produces: no production path reads a startup registry Map in Postgres mode.

- [ ] **Step 1: Failing tests, one per rule** (add to the existing test file of each module):
  1. `accept-envelope.rooms.pg.test.mjs`: an endpoint inserted only in Postgres (not in any Map) posts a direct envelope and is accepted; a same-owner direct envelope between two such endpoints does not fail `DIRECTORY_LINK_REQUIRED` (recipient owner comes from `lookupRecipientEndpoint`).
  2. `accept-envelope.federation-sync.test.mjs` / `.federation-queue.test.mjs`: `forwardEnvelope` refuses (no outbound call) when the sender endpoint is revoked, and when `signature.key_id` names a retired key; advertises `sender_key` of the key matching `signature.key_id` when two keys exist.
  3. `accept-federated-envelope.test.mjs`: the synthetic sender entry has the `keys` Map shape and `validateEnvelope` accepts it; no `registered.get` fallback remains (assert by passing an empty `registered` Map).
  4. `room-policy.test.mjs`: `endpointIsActive` with a repository returning `{status:'suspended'}` and a Map holding an `active` entry returns `false`.
  5. adapter test: with a non-Map registry the adapter still rejects an unregistered and an inactive endpoint.
  6. `room-routes.manage.test.mjs`: `addRoomMember` for an endpoint known only to Postgres succeeds, and for a `system` or other-owner endpoint returns 403.
  7. p2p: a PeerId derived from any `active` key of the sender binds; from a `retired` key does not.

- [ ] **Step 2: Run each, expect FAIL.**

- [ ] **Step 3: Implement.**

`accept-envelope.mjs` inside `repository.withTransaction` at the sender lookup (before `validateEnvelope`, around the existing line 256-303 block):

```js
const senderEntry = repository?.lookupTrustedEndpoint
  ? await repository.lookupTrustedEndpoint(envelope.sender?.endpoint_id, client)
  : registered.get(envelope.sender?.endpoint_id);
const senderOnly = new Map(senderEntry ? [[envelope.sender.endpoint_id, senderEntry]] : []);
validateEnvelope(envelope, { ...options, registered: senderOnly });
```

Recipient owner for the same-owner exemption (lines 373-374) becomes `const recipient = await repository.lookupRecipientEndpoint(recipientId, client); const recipientOwner = recipient?.owner_id;`. Delete the `?? registered.get(...)` fallback at 303.

`forwardEnvelope`: select `const key = senderEntry.keys.get(envelope.signature.key_id)`; `if (senderEntry.status !== 'active' || !keyVerifies(key)) return { forwarded: false, reason: 'SENDER_KEY_INVALID' }` (match the file's existing non-forward return shape; read it first); `senderKey = key.public_key` exported the way line 496-507 does today.

`accept-federated-envelope.mjs:150-155`: build `{ endpoint_id, owner_id, kind: 'agent', status: 'active', keys: new Map([[key_id, { key_id, public_key, status: 'active', valid_from: new Date(0).toISOString(), valid_until: null }]]) }`. Remove the fallback at 196.

`room-policy.mjs` `endpointIsActive`:

```js
export async function endpointIsActive(endpointId, repository, client, registered) {
  if (repository.lookupRecipientEndpoint) return (await repository.lookupRecipientEndpoint(endpointId, client))?.status === 'active';
  return registered?.get(endpointId)?.status === 'active';
}
```

`isAgentMember`/`isAgentEndpoint`: read `kind` from the `lookupRecipientEndpoint` result and treat `system` as neither human nor agent member (return a third value only where callers branch; at minimum `isAgentEndpoint` returns `true` iff `kind==='agent'` or `response_mode != null`, and `memberIsHuman` returns `kind==='human'`).

`room-routes.mjs:191-195` (add member):

```js
const endpoint = await repository.lookupTrustedEndpoint(endpointId);
if (!endpoint || endpoint.status !== 'active' || endpoint.owner_id !== principal.human_id || endpoint.kind === 'system') {
  return fail(response, requestId, 403, 'ROUTE_NOT_AUTHORIZED', 'You can only add active endpoints you own');
}
const targetIsAgent = endpoint.kind === 'agent';
```

Adapter: replace `registry instanceof Map` branches with `const entry = await repository.lookupTrustedEndpoint(id)` and unconditional rejection when missing or inactive. p2p: iterate `[...entry.keys.values()].filter((k) => k.status === 'active')`.

- [ ] **Step 4: Run** the touched test files one process at a time, then `timeout 300 node --test relay/v1/` filtered to `*.test.mjs` non-pg. Expect PASS.
- [ ] **Step 5: Tick the T4 rows in the inventory; commit** `feat(sigil): read trusted endpoint state from Postgres at every consumer`.

---

### Task 5: `kind` writers, human-only authenticator

**Files:** Modify `postgres-repository.mjs` (`createEndpointWithAudit` ~477, `ensureRoomSystemEndpoint` ~494, `registerFederatedSender` ~825), `relay/v1/transport-auth.mjs`, every fixture row in the Task 1 second table, `cli/sigil.mjs` init path if it calls `createEndpointWithAudit`.

**Interfaces:** Produces `createEndpointWithAudit({..., kind})`; `createBearerAuthenticator(tokenHashes, registry)` yields `human_id` only when `entry.kind === 'human'`.

- [ ] **Step 1: Failing tests.**
  - `transport-auth.test.mjs`: entries with `kind` `human` → has `human_id`; `agent` → no; `system` → no; `undefined` → no (the registry's default is applied earlier by `entryFromRegistryRow`; a raw missing kind must not grant human).
  - pg test (new `postgres-repository.kind.pg.test.mjs`): `ensureRoomSystemEndpoint` stores `system`; `registerFederatedSender` stores `agent`; `createEndpointWithAudit({kind:'human'})` stores `human`; `createEndpointWithAudit` without `kind` rejects with `INVALID_KIND`; unrecognized `kind` rejects.
  - writer-coverage test `endpoint-insert-writers.test.mjs`: read every non-test `.mjs` under `sigil/`, find `INSERT INTO endpoints` statements and assert each column list includes `kind`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Add `kind` column and `$` param to the three inserts; in `createEndpointWithAudit` add `const KINDS = new Set(['human','agent','system']); if (!KINDS.has(kind)) throw Object.assign(new Error('kind must be human, agent, or system'), { code: 'INVALID_KIND' });`. Authenticator tail becomes:

```js
    const principal = { endpoint_id: endpointId, owner_id: endpoint.owner_id };
    return endpoint.kind === 'human' ? { ...principal, human_id: endpoint.owner_id } : principal;
```

Update every fixture insert (sed per inventory), pass `kind: 'agent'` or `'human'` to `createEndpointWithAudit` callers (`sigil init` path: kind from `identity.kind ?? 'human'`).
- [ ] **Step 4: Run** touched tests + `isAgentCaller` users (`room-routes*.test.mjs`). Expect PASS. **Commit** `feat(sigil): explicit endpoint kind on every writer; human_id only for human endpoints`.

---

### Task 6: Insert-only seed, `REGISTRY_CONFLICT`, `--reconcile-kind`

**Files:** Modify `cli/sigil.mjs:237-275` (extract to `cli/registry-seed.mjs` + `.test.mjs`), `cmdRelayUp` flag parsing; `cli/sigil.test.mjs` or the relay-up test file for flag docs.

**Interfaces:** Produces `seedRegistry(pool, data, { reconcileKind = new Map() })`. Throws `REGISTRY_CONFLICT` with `details: [{ endpoint_id, field, file, postgres }]`.

- [ ] **Step 1: Failing pg tests** (`cli/registry-seed.pg.test.mjs`): 
  1. Fresh seed inserts human with `kind` from file, `ep.kind ?? 'human'`.
  2. Re-seeding after `UPDATE endpoints SET status='revoked'` leaves it revoked.
  3. File row `status:'revoked'` revokes an active Postgres row; `status:'active'` never raises a revoked one.
  4. Row whose `owner_id` differs, whose public key differs, or whose `kind` differs throws `REGISTRY_CONFLICT` naming the endpoint and both values.
  5. `reconcileKind: new Map([[id,'human']])` fixes a kind mismatch only when it equals the file's kind; `new Map([[id,'agent']])` where file says human still throws; after reconcile a second mismatch on another endpoint still throws.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `seedRegistry`: per endpoint, `INSERT INTO humans ... ON CONFLICT DO NOTHING`; `INSERT INTO endpoints (..., kind, status) VALUES (..., $kind, $status) ON CONFLICT (endpoint_id) DO NOTHING`; then `SELECT owner_id, kind, status FROM endpoints WHERE endpoint_id=$1` and the active key's SPKI; collect conflicts (owner, kind, key) unless reconciled; if `file.status` in `revoked|suspended` and Postgres status is `active`, `UPDATE endpoints SET status=$file`. Key insert stays `ON CONFLICT (key_id) DO NOTHING`. Throw once with all conflicts. Replace the loop in `cmdRelayUp` with `await seedRegistry(pool, data, { reconcileKind })`. Parse repeatable `--reconcile-kind id=kind` (check how `opt`/repeatable flags are parsed in this file, e.g. a `optAll` helper; add one if none). `--public-origin` without `--room-human-identity` throws `sigil relay up: --public-origin requires --room-human-identity`. Add `--room-key-wrap-key` and `--reconcile-kind` to the `relay up` help text.
- [ ] **Step 4: Run, expect PASS. Commit** `feat(sigil): insert-only registry seed with REGISTRY_CONFLICT and --reconcile-kind`.

---

### Task 7: Key rotation, shadow-key retirement, `endpoint revoke`

**Files:** Modify `postgres-repository.mjs` (`registerFederatedSender` ~817; new `rotateEndpointKey`, `revokeEndpoint`), `cli/sigil.mjs` (new `endpoint revoke`); tests `postgres-repository.keys.pg.test.mjs`, extend `accept-federated-envelope.pg.test.mjs`.

**Interfaces:** Produces `repository.revokeEndpoint({ endpointId, actorHumanId? }, client)` (status `revoked`, keys `retired` with `valid_until=now`, audit `endpoint.revoked`, returns `{ owner_id }`), `repository.rotateEndpointKey({ endpointId, newKey }, client)`.

- [ ] **Step 1: Failing pg tests:** a second `active` insert on a local endpoint raises `23505`; `registerFederatedSender` with a new `key_id` for the same shadow sender retires the old key and inserts the new one in one tx, and a following envelope is accepted (`accept-federated-envelope.pg.test.mjs` rotation case); `rotateEndpointKey` leaves exactly one `active`; `revokeEndpoint` sets status, retires every key, writes the audit row, and `lookupTrustedEndpoint` then verifies nothing.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement.** In `registerFederatedSender`, before the key insert (after the collision check): 

```js
await client.query(
  `UPDATE endpoint_keys SET status='retired', valid_until=$2 WHERE endpoint_id=$1 AND status='active' AND key_id <> $3`,
  [endpoint_id, now, key_id]);
```

(The method defaults `client = this.pool`; the retire and insert must share one client. When called with the pool, wrap in `this.withTransaction`.) `revokeEndpoint` and `rotateEndpointKey` use `withTransaction` unless handed a client.
- [ ] **Step 4: CLI `endpoint revoke <endpoint_id>`:** one tx calling `revokeEndpoint` then `publishAdmin(client, { type: 'endpoint.revoked', endpoint_id })` (`publishAdmin` is created in Task 12; until then guard with a local one-line `SELECT pg_notify('sigil_admin', $1)` and replace in Task 12 step 3). Test in `cli/endpoint-revoke.pg.test.mjs`: command revokes and the payload received on a separate `LISTEN` connection equals `{ type:'endpoint.revoked', endpoint_id }`.
- [ ] **Step 5: Run, PASS. Commit** `feat(sigil): single active signing key, federated key rotation, endpoint revoke`.

---

### Task 8: Key wrap

**Files:** Create `relay/v1/key-wrap.mjs`, `relay/v1/key-wrap.test.mjs`.

**Interfaces:** Produces `wrapPrivateKey`, `unwrapPrivateKey`, `loadWrapKey(ref, env = process.env)`.

- [ ] **Step 1: Failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { wrapPrivateKey, unwrapPrivateKey, loadWrapKey } from './key-wrap.mjs';

const wrapKey = crypto.randomBytes(32);
const { privateKey } = crypto.generateKeyPairSync('ed25519');
const pkcs8 = (k) => k.export({ type: 'pkcs8', format: 'der' });

test('round trip returns the same PKCS8 key', () => {
  const wrapped = wrapPrivateKey({ wrapKey, endpointId: 'ep_a', keyId: 'k_a', privateKey });
  assert.equal(wrapped.length, 12 + 16 + pkcs8(privateKey).length);
  const out = unwrapPrivateKey({ wrapKey, endpointId: 'ep_a', keyId: 'k_a', wrapped });
  assert.ok(pkcs8(out).equals(pkcs8(privateKey)));
});
test('wrong key fails', () => {
  const wrapped = wrapPrivateKey({ wrapKey, endpointId: 'ep_a', keyId: 'k_a', privateKey });
  assert.throws(() => unwrapPrivateKey({ wrapKey: crypto.randomBytes(32), endpointId: 'ep_a', keyId: 'k_a', wrapped }));
});
test('ciphertext swapped to another endpoint fails (AAD)', () => {
  const wrapped = wrapPrivateKey({ wrapKey, endpointId: 'ep_a', keyId: 'k_a', privateKey });
  assert.throws(() => unwrapPrivateKey({ wrapKey, endpointId: 'ep_b', keyId: 'k_a', wrapped }));
  assert.throws(() => unwrapPrivateKey({ wrapKey, endpointId: 'ep_a', keyId: 'k_b', wrapped }));
});
test('IV is fresh per wrap', () => {
  const a = wrapPrivateKey({ wrapKey, endpointId: 'e', keyId: 'k', privateKey });
  const b = wrapPrivateKey({ wrapKey, endpointId: 'e', keyId: 'k', privateKey });
  assert.notDeepEqual(a.subarray(0, 12), b.subarray(0, 12));
});
test('loadWrapKey: absent throws WRAP_KEY_UNAVAILABLE, wrong length rejected, valid base64 accepted', () => {
  assert.throws(() => loadWrapKey('SIGIL_WRAP', {}), { code: 'WRAP_KEY_UNAVAILABLE' });
  assert.throws(() => loadWrapKey('SIGIL_WRAP', { SIGIL_WRAP: Buffer.alloc(16).toString('base64') }), { code: 'WRAP_KEY_INVALID' });
  assert.equal(loadWrapKey('SIGIL_WRAP', { SIGIL_WRAP: wrapKey.toString('base64') }).length, 32);
});
```

- [ ] **Step 2: Run, expect FAIL. Step 3: Implement**

```js
import crypto from 'node:crypto';

const aad = (endpointId, keyId) => Buffer.from(`${endpointId}\0${keyId}`, 'utf8');

export function wrapPrivateKey({ wrapKey, endpointId, keyId, privateKey }) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', wrapKey, iv);
  cipher.setAAD(aad(endpointId, keyId));
  const ct = Buffer.concat([cipher.update(privateKey.export({ type: 'pkcs8', format: 'der' })), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function unwrapPrivateKey({ wrapKey, endpointId, keyId, wrapped }) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', wrapKey, wrapped.subarray(0, 12));
  decipher.setAAD(aad(endpointId, keyId));
  decipher.setAuthTag(wrapped.subarray(12, 28));
  const der = Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

// ref names an environment variable holding 32 random bytes, base64. Doppler
// injects it into the environment; the value never appears in argv.
export function loadWrapKey(ref, env = process.env) {
  const raw = ref ? env[ref] : undefined;
  if (!raw) throw Object.assign(new Error(`wrap key "${ref}" is not set`), { code: 'WRAP_KEY_UNAVAILABLE' });
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw Object.assign(new Error('wrap key must be 32 bytes, base64-encoded'), { code: 'WRAP_KEY_INVALID' });
  return key;
}
```

- [ ] **Step 4: Run, PASS. Commit** `feat(sigil): AES-GCM wrap for relay-custodial human signing keys`.

---

### Task 9: `provisionHumanTx` and `human add`

**Files:** Create `relay/v1/provision-human.mjs`, `relay/v1/provision-human.pg.test.mjs`, `cli/human-commands.mjs` (+ test); modify `cli/sigil.mjs` dispatch; add `lookupTrustedEndpoint` use from Task 3.

**Interfaces:** Consumes `wrapPrivateKey`, `publishAdmin` (Task 12; here use `client.query("SELECT pg_notify('sigil_admin', $1)", [JSON.stringify(payload)])` and swap in Task 12). Produces `provisionHumanTx(client, { displayName, attributes = [], wrapKey, now = new Date() })` → `{ human_id, endpoint_id, key_id }`.

- [ ] **Step 1: Failing pg tests:**
  1. Rows: one `humans` (`hum_` + 32 hex), one `endpoints` (`ep_` + 32 hex, `runtime='human'`, `kind='human'`, `installation_id='install_'+endpoint_id`, `display_name` = given or endpoint id, `owner_id=human_id`), one `endpoint_keys` (`Ed25519`, active, `valid_from` set), one `human_signing_keys` that unwraps to a key whose public half equals the stored SPKI, one `human_attributes` row per attribute with `verification_state='unverified'` (read `migrations/003_plugin_connector_auth.sql` for the exact NOT NULL columns and mirror them), and an `audit_events` row `human.provisioned`.
  2. Outer-transaction rollback: throw after `provisionHumanTx` inside `withTransaction`; no human/endpoint/key rows remain.
  3. Missing wrap key: `provisionHumanTx(client, {})` rejects `WRAP_KEY_UNAVAILABLE` before any insert.
  4. No `displayName` → `display_name` equals `endpoint_id`.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement.**

```js
import crypto from 'node:crypto';
import { wrapPrivateKey } from './key-wrap.mjs';

const hex = (prefix) => `${prefix}${crypto.randomBytes(16).toString('hex')}`;

export async function provisionHumanTx(client, { displayName, attributes = [], wrapKey, now = new Date() }) {
  if (!wrapKey) throw Object.assign(new Error('wrap key is required'), { code: 'WRAP_KEY_UNAVAILABLE' });
  const ts = (now instanceof Date ? now : new Date(now)).toISOString();
  const humanId = hex('hum_'), endpointId = hex('ep_'), keyId = hex('key_');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  await client.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1,'active',$2)`, [humanId, ts]);
  await client.query(
    `INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at)
     VALUES ($1,$2,'human','human',$3,$4,'active',$5)`,
    [endpointId, humanId, `install_${endpointId}`, displayName || endpointId, ts]);
  await client.query(
    `INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ($1,$2,'Ed25519',$3,'active',$4)`,
    [keyId, endpointId, publicKey.export({ type: 'spki', format: 'der' }), ts]);
  await client.query(`INSERT INTO human_signing_keys (key_id, wrapped_private_key, created_at) VALUES ($1,$2,$3)`,
    [keyId, wrapPrivateKey({ wrapKey, endpointId, keyId, privateKey }), ts]);
  for (const attr of attributes) {
    await insertHumanAttribute(client, humanId, attr, ts);
  }
  await client.query(
    `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, object_type, object_id, outcome, created_at)
     VALUES ($1,'human.provisioned',$2,NULL,'human',$2,'success',$3)`,
    [`audit_${crypto.randomUUID()}`, humanId, ts]);
  return { human_id: humanId, endpoint_id: endpointId, key_id: keyId };
}
```

`insertHumanAttribute` is a local helper in the same file writing every NOT NULL column of `human_attributes` (read the migration; `attribute_id` = `attr_${randomUUID}`, kind `'name'`, value `Buffer.from(String(attr.value),'utf8')`, `verification_state` forced to `'unverified'` regardless of input, `source` from `attr.source`, observed/created = `ts`). Check whether `audit_events.actor_human_id` allows NULL; if not, use the operator's id passed in an `actorHumanId` option.

- [ ] **Step 4: CLI `human add --name <name> [--room <id>:<role> ...]`** in `cli/human-commands.mjs`: parse flags (`--identity`, `--database-url`, `--room-key-wrap-key`), `loadWrapKey(ref)`, open pool, `withTransaction`: `provisionHumanTx` → if `--room` entries, `addHumanToRoomsTx` (Task 10; add after Task 10, keep `--room` rejected with `NOT_IMPLEMENTED` until then and remove that guard in Task 10 step 4) → publish `human.provisioned` with `room_ids`. Print `human_id` and `endpoint_id`. Test: spawn via `child_process.execFile` with env wrap key against the test DB, assert JSON/lines output and rows.
- [ ] **Step 5: Run, PASS. Commit** `feat(sigil): provisionHumanTx and human add`.

---

### Task 10: `lockManagerRows`, `addHumanToRoomsTx`, `human add-to-room`

**Files:** Modify `relay/v1/provision-human.mjs`; extend its pg test; modify `cli/human-commands.mjs`; memory repo: not applicable (provisioning is Postgres-only, returns `PROVISIONING_UNAVAILABLE`).

**Interfaces:** Produces `lockManagerRows(client, humanId, roomIds)`, `addHumanToRoomsTx(client, { endpointId, memberships, actorHumanId, repository, now })`. `repository` supplies `lookupTrustedEndpoint` and `addRoomMember`.

- [ ] **Step 1: Failing pg tests:**
  1. Actor holding `owner` or `room_manager` through any of their endpoints passes; actor with only `member` role fails `ROUTE_NOT_AUTHORIZED`; actor missing from one of two rooms fails and writes nothing.
  2. Target created earlier in the same uncommitted tx is found (inside `withTransaction`: provision then add).
  3. Re-adding an active member is a no-op (no throw); re-adding a removed member restores with `invokable_by='owner'` even when the prior row had `members` (set the row to `members` and `removed_at` first).
  4. Roles outside `member|room_manager` (`owner`) rejected `INVALID_ROLE`.
  5. Deadlock: two concurrent txs naming `[a,b]` and `[b,a]` both complete (`Promise.all`, no `40P01`).
  6. `added_by` equals `actorHumanId`.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement.**

```js
export async function lockManagerRows(client, humanId, roomIds) {
  const { rows } = await client.query(
    `SELECT m.* FROM conversation_members m JOIN endpoints e ON e.endpoint_id = m.endpoint_id
      WHERE e.owner_id = $1 AND m.conversation_id = ANY($2) AND m.removed_at IS NULL
      ORDER BY m.conversation_id, m.endpoint_id FOR UPDATE OF m`, [humanId, roomIds]);
  return rows;
}

const MANAGER = new Set(['owner', 'room_manager']);
const GRANTABLE = new Set(['member', 'room_manager']);

export async function addHumanToRoomsTx(client, { endpointId, memberships, actorHumanId, repository, now = new Date() }) {
  for (const { role } of memberships) if (!GRANTABLE.has(role)) throw Object.assign(new Error('role must be member or room_manager'), { code: 'INVALID_ROLE' });
  const roomIds = [...new Set(memberships.map((m) => m.roomId))].sort();
  const locked = await lockManagerRows(client, actorHumanId, roomIds);
  const managed = new Set(locked.filter((r) => MANAGER.has(r.role)).map((r) => r.conversation_id));
  const missing = roomIds.filter((id) => !managed.has(id));
  if (missing.length) throw Object.assign(new Error(`actor does not manage: ${missing.join(', ')}`), { code: 'ROUTE_NOT_AUTHORIZED', rooms: missing });
  const target = await repository.lookupTrustedEndpoint(endpointId, client);
  if (!target || target.status !== 'active' || target.kind !== 'human') throw Object.assign(new Error('target is not an active human endpoint'), { code: 'ROUTE_NOT_AUTHORIZED' });
  for (const { roomId, role } of [...memberships].sort((a, b) => (a.roomId < b.roomId ? -1 : 1))) {
    try {
      await repository.addRoomMember({ conversationId: roomId, endpointId, role, addedByHumanId: actorHumanId, now }, client);
    } catch (error) { if (error.code !== 'ROOM_MEMBER_EXISTS') throw error; }
  }
  return { room_ids: roomIds };
}
```

In `postgres-repository.mjs` `addRoomMember`, add `invokable_by = 'owner'` to the `DO UPDATE SET` list (and in the memory repository's restore path; find with `grep -n "removed_at" relay/v1/*memory*` / `cli/memory-repository.mjs`).
- [ ] **Step 4: CLI `human add-to-room --human <id> --room <id>:<role>`:** resolve the human's active human endpoint (`SELECT endpoint_id FROM endpoints WHERE owner_id=$1 AND kind='human' AND status='active' ORDER BY created_at LIMIT 1`; fail `HUMAN_NOT_FOUND` otherwise), run `addHumanToRoomsTx` with the `--identity` operator's `owner_id` as actor in its own tx, publish `{ type:'room.members', room_ids }`. Also remove the Task 9 `--room` guard in `human add`. CLI test asserts the rooms list and that a non-manager operator identity fails.
- [ ] **Step 5: Run, PASS. Commit** `feat(sigil): add provisioned humans to rooms under a total lock order`.

---

### Task 11: Async signing seam and room post

**Files:** Modify `relay/v1/room-human-signer.mjs`, `relay/v1/room-human-signer.test.mjs`, `relay/v1/room-routes.mjs:~128-168` (post), `cli/sigil.mjs` (construct signer with repository + wrap key), `relay/v1/room-send-route.test.mjs`, `relay/v1/room-send-route.pg.test.mjs`.

**Interfaces:** `createRoomHumanSigner({ identity, repository, wrapKey, identityKeys })` → `{ endpointId, ownerId, signForEndpoint(endpointId): Promise<{ privateKey, endpoint }> }`. Errors `NO_SIGNING_KEY`, `KEY_MISMATCH`.

- [ ] **Step 1: Failing tests.**
  - Signer unit (fake repository): operator endpoint signs from identity file; a provisioned endpoint signs via `human_signing_keys` unwrap; derived public key mismatch with the `endpoint_keys` SPKI throws `KEY_MISMATCH` (checked once per process per key: second call does not requery, assert via counter); endpoint without key throws `NO_SIGNING_KEY`; the construction check validates only the operator (`ROOM_HUMAN_ENDPOINT_UNKNOWN` when not an active human endpoint per `lookupTrustedEndpoint`, `ROOM_HUMAN_KEY_MISMATCH` on key mismatch).
  - `room-send-route.test.mjs`: a principal that is not the operator's endpoint reaches `signForEndpoint` (stub signer) and posts; no signer → 503 `NO_OPERATOR_IDENTITY` and `signForEndpoint` not called; signer throws `NO_SIGNING_KEY` → 403 `NO_SIGNING_KEY`; envelope-layer `UNKNOWN_ENDPOINT`/`INVALID_SIGNATURE` results map to 500.
  - `room-send-route.pg.test.mjs`: provisioned human (via `provisionHumanTx` + `addHumanToRoomsTx`) posts and the stored `sender_endpoint_id` is theirs; repeat on a fresh `PostgresRepository` over the same pool (restart); two provisioned humans yield two distinct senders; a provisioned human receives a fan-out delivery.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement.** Signer:

```js
export function createRoomHumanSigner({ identity, repository, wrapKey, identityKeys = defaultIdentityKeys }) {
  const keys = identityKeys(identity);
  const checked = new Set();
  const endpoint = { owner_id: identity.owner_id, endpoint_id: identity.endpoint_id, key_id: identity.key_id, kind: 'human' };
  return {
    endpointId: identity.endpoint_id, ownerId: identity.owner_id,
    async verifyOperator() {
      const entry = await repository.lookupTrustedEndpoint(identity.endpoint_id);
      if (!entry || entry.status !== 'active' || entry.kind !== 'human') throw Object.assign(new Error(`room human identity endpoint "${identity.endpoint_id}" is not an active human endpoint`), { code: 'ROOM_HUMAN_ENDPOINT_UNKNOWN' });
      const key = entry.keys.get(identity.key_id);
      if (!key || !spki(key.public_key).equals(spki(keys.publicKey))) throw Object.assign(new Error('room human identity key does not match the registry key'), { code: 'ROOM_HUMAN_KEY_MISMATCH' });
    },
    async signForEndpoint(endpointId) {
      if (endpointId === identity.endpoint_id) return { privateKey: keys.privateKey, endpoint };
      const entry = await repository.lookupTrustedEndpoint(endpointId);
      const active = entry && [...entry.keys.values()].find((k) => k.status === 'active');
      const wrapped = active && await repository.loadWrappedSigningKey(active.key_id);
      if (!wrapped) throw Object.assign(new Error(`no signing key for endpoint "${endpointId}"`), { code: 'NO_SIGNING_KEY' });
      const privateKey = unwrapPrivateKey({ wrapKey, endpointId, keyId: active.key_id, wrapped });
      const memo = `${endpointId}:${active.key_id}`;
      if (!checked.has(memo)) {
        if (!spki(crypto.createPublicKey(privateKey)).equals(spki(active.public_key))) throw Object.assign(new Error('unwrapped key does not match endpoint key'), { code: 'KEY_MISMATCH' });
        checked.add(memo);
      }
      return { privateKey, endpoint: { owner_id: entry.owner_id, endpoint_id: endpointId, key_id: active.key_id, kind: 'human' } };
    },
  };
}
```

Add `repository.loadWrappedSigningKey(keyId)` → `SELECT wrapped_private_key FROM human_signing_keys WHERE key_id=$1` (`null` when absent). `cmdRelayUp` constructs the signer with `repository`, calls `await signer.verifyOperator()` (the old synchronous startup check), and passes `wrapKey = loadWrapKey(opt('room-key-wrap-key'))` only when the flag is given (`wrapKey` undefined means provisioned signing throws `WRAP_KEY_UNAVAILABLE`, mapped to 503 `WRAP_KEY_UNAVAILABLE` in the route). In `room-routes.mjs` post: delete the `principal.endpoint_id !== humanSigner.endpointId` guard; change `!humanSigner || !buildAcceptOptions` to two checks (`!humanSigner` → 503 `NO_OPERATOR_IDENTITY`, `!buildAcceptOptions` → 503 `ROOM_SEND_UNAVAILABLE`); `const signer = await humanSigner.signForEndpoint(...)` inside try/catch mapping `NO_SIGNING_KEY` → 403, `KEY_MISMATCH`/`WRAP_KEY_UNAVAILABLE` → 503; when `result.status === 401` with `UNKNOWN_ENDPOINT`/`INVALID_SIGNATURE`, answer 500 `INTERNAL`.
- [ ] **Step 4: Run signer, send-route (unit then pg), `http-server` tests. PASS. Commit** `feat(sigil): per-endpoint custodial signing behind an async seam`.

---

### Task 12: Admin NOTIFY channel, authenticator cache, stream liveness

**Files:** Create `relay/v1/admin-notify.mjs` + test, `relay/v1/liveness.mjs` + test; modify `relay/v1/stream-server.mjs`, `relay/v1/http-server.mjs:~344` (awaited authenticator), `cli/sigil.mjs` (construct authenticators and listener; stream bearer authenticator returns `owner_id`), `relay/v1/transport-auth.mjs` (async + cache), `relay/v1/postgres-repository.mjs` (`livenessSnapshot`); swap the stand-in `pg_notify` calls from Tasks 7 and 9.

**Interfaces:**
```js
publishAdmin(client, { type, human_id, endpoint_id, room_ids }) // validates fixed shape, size < 8000
startAdminListener({ pool, onMessage, onReconnect, logger, backoffMs }) // -> { close() }
createBearerAuthenticator(tokenHashes, { repository, ttlMs = 5000, now = Date.now }) // async (request) => principal|null; .clear({ humanId, endpointId }); .clearAll()
repository.livenessSnapshot({ endpointId }) // { endpoint_status, has_active_key, human_status|null }
isSocketLive(snapshot) // pure
createStreamServer({ ..., repository }) gains revalidate({ humanId, endpointId }), runs liveness at upgrade and each minute (livenessIntervalMs option)
```

- [ ] **Step 1: Failing tests.**
  - `admin-notify.test.mjs`: `publishAdmin` rejects unknown `type`, rejects a `room_ids` array so long the payload reaches 8000 bytes (`PAYLOAD_TOO_LARGE`), and calls `pg_notify('sigil_admin', json)` on the given client (fake client records the query).
  - `admin-notify.pg.test.mjs`: listener receives a payload published in a committed tx and receives nothing from a rolled-back tx; after `pool`-level termination of its backend (`pg_terminate_backend`) it reconnects and calls `onReconnect`.
  - `transport-auth.test.mjs` (async): authenticator reads `lookupTrustedEndpoint`/`livenessSnapshot` once per 5 s per endpoint (counter), returns `null` for a suspended human or non-active endpoint, `clear({ endpointId })` forces a requery, `clear({ humanId })` clears every endpoint owned by that human, and `human_id` only for `kind==='human'`.
  - `liveness.test.mjs`: table of snapshots → pass/fail: endpoint not active, no active key, human suspended, endpoint revoked. Ticket-session checks arrive with the login spec (the function takes an optional `session` and returns false when it is revoked or expired; test that branch with a fake session).
  - `stream-server.test.mjs`: with a fake repository, a bearer socket for a non-live endpoint is closed 1008 at upgrade and never added to `clients`; `revalidate({ endpointId })` closes the failing sockets of that endpoint and leaves others; the minute pass (`livenessIntervalMs: 20`) closes a socket whose snapshot turns bad.
  - `cli/relay-admin-listener.pg.test.mjs` (cross-process): start a relay with a live bearer stream socket; run `sigil relay endpoint revoke <ep>` as a child process; the socket closes 1008 within 2 s and the next HTTP request is 401, without waiting 5 s. A second case with `human suspend` waits for Task 15.
- [ ] **Step 2: Run each, expect FAIL.**
- [ ] **Step 3: Implement.** `publishAdmin`:

```js
const TYPES = new Set(['human.provisioned', 'room.members', 'human.suspended', 'human.unsuspended', 'agent.invokable', 'endpoint.revoked', 'identity.revoked']);
export async function publishAdmin(client, payload) {
  if (!TYPES.has(payload.type)) throw Object.assign(new Error(`unknown admin type ${payload.type}`), { code: 'INVALID_ADMIN_TYPE' });
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) >= 8000) throw Object.assign(new Error('admin payload too large'), { code: 'PAYLOAD_TOO_LARGE' });
  await client.query('SELECT pg_notify($1, $2)', ['sigil_admin', body]);
}
```

`startAdminListener` keeps a dedicated `pg.Client` from `pool.options`, `LISTEN sigil_admin`, parses `notification.payload` in a try/catch, and on `error`/`end` reconnects with doubling backoff (cap 5 s) and calls `onReconnect()` after each successful reconnect. `livenessSnapshot` runs one query joining `endpoints`, an `EXISTS` over `endpoint_keys status='active'`, and `humans` on `owner_id`. The `sigil.mjs` handler: on message → `auth.clear({ humanId: p.human_id, endpointId: p.endpoint_id })`; for `human.suspended|endpoint.revoked|identity.revoked` → `stream.revalidate({ humanId: p.human_id, endpointId: p.endpoint_id })`; for `room_ids` → `await repository.withTransaction((client) => notifyRoomHumans({ repository, stream, registered: undefined, client, roomId, changed: 'members', logger }))` per room (never `client: null`); `onReconnect` → `auth.clearAll()`. Make `http-server.mjs`'s `await authenticator(request)` call explicit and keep the existing 401 mapping. In `stream-server.mjs`, make the connection handler `async`, keep the socket out of `clients`/`browserClients` until `isSocketLive(await repository.livenessSnapshot(...))` passes, store `{ endpointId, humanId }` per socket in a `WeakMap` so `revalidate` can select by human (via `SELECT endpoint_id FROM endpoints WHERE owner_id=$1` on a live-socket scan: compare the stored `ownerId`, extended from the stream authenticator returning `owner_id`), and run the minute `setInterval` (unref'd, cleared in `close()`). Replace the Task 7/9 stand-in `pg_notify` calls with `publishAdmin`.
- [ ] **Step 4: Run each new test file alone, then `http-server.test.mjs` and `http-server.rooms-stream.test.mjs`. PASS. Commit** `feat(sigil): admin NOTIFY channel, cached async authenticators, stream liveness`.

---

### Task 13: Invocation policy

**Files:** Create `relay/v1/invoke-policy.mjs` + test; modify `relay/v1/postgres-repository.mjs` (`createRoomInvocation`, `INVOCATION_COLUMNS`, `listRoomMembers`/`memberRow`/`lookupRoomMember`, new `setRoomMemberInvokableBy`, `promoteNextInvocation`), `relay/v1/room-dispatch.mjs`, `relay/v1/room-routes.mjs` (invocations route ~305-313, new `invokable-by` route), `relay/v1/room-policy.mjs`, memory repository, `bridges/v1/room-bridge.mjs` (preamble), `cli/human-commands.mjs` (`agent set-invokable`), tests listed below.

**Interfaces:**
```js
mayInvoke(subjectHumanId, target) // target: { owner_id, invokable_by } -> boolean
createRoomInvocation({ ..., subjectHumanId }) // required, throws MISSING_SUBJECT
repository.setRoomMemberInvokableBy({ conversationId, endpointId, invokableBy }, client)
memberRow adds invokable_by and owner_id
```

- [ ] **Step 1: Failing unit tests** (`invoke-policy.test.mjs`):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mayInvoke } from './invoke-policy.mjs';

test('owner mode: only the agent owner', () => {
  assert.equal(mayInvoke('h1', { owner_id: 'h1', invokable_by: 'owner' }), true);
  assert.equal(mayInvoke('h2', { owner_id: 'h1', invokable_by: 'owner' }), false);
});
test('members mode: any human', () => assert.equal(mayInvoke('h2', { owner_id: 'h1', invokable_by: 'members' }), true));
test('missing subject or unknown mode denies', () => {
  assert.equal(mayInvoke(null, { owner_id: 'h1', invokable_by: 'members' }), false);
  assert.equal(mayInvoke('h1', { owner_id: 'h1', invokable_by: 'everyone' }), false);
});
```

Implementation: `export function mayInvoke(subject, target) { if (!subject || !target) return false; if (target.invokable_by === 'members') return true; return target.invokable_by === 'owner' && subject === target.owner_id; }`.

- [ ] **Step 2: Failing behavior tests**, each in the named existing file, Postgres where the spec requires (`room-dispatch.test.mjs` for pure dispatch, `room-invocations-route.test.mjs` + `.pg.test.mjs`, `room-invocations.pg.test.mjs`, `room-routes.manage.test.mjs`):
  1. Guest mention of an owner-only agent → no delivery, a `room.event` "not allowed to invoke <agent>", audit `room.invocation_refused`.
  2. Router path: unmentioned guest message; router selects owner-only agent → refused; `POST /invocations` loads the trigger envelope, requires a human sender, and filters before `dispatchToTarget`.
  3. `task.request` assignee owner-only → refused; assignee `members` → inserted with `decided_by='assignee'` and `subject_human_id`=guest.
  4. **Hop inheritance:** guest invokes a `members` agent A (subject guest); A's reply `@mention`s owner-only agent B (same owner) → refused, because the new row inherits the subject from `completing`. Operator subject → allowed.
  5. A `joins` agent set to `owner` triggers no router delivery for a guest (`hasJoinedAgent` counts only invocable ones).
  6. Guest posting in a thread does not reset `agent_turns` of a chain whose `subject_human_id` is the operator; the operator's own post does.
  7. `promoteNextInvocation`: a queued row refused (not run) when subject suspended, removed from room, or agent switched to `owner` after queueing; the next queued row is then considered.
  8. `set-invokable`: guest `room_manager` gets 403; the agent's owner succeeds; a restore after removal resets to `owner`.
  9. `createRoomInvocation` without `subjectHumanId` throws.
- [ ] **Step 3: Run, expect FAIL.**
- [ ] **Step 4: Implement.** Order: (a) repository: `memberRow`/queries return `invokable_by` and (join `endpoints`) `owner_id`; `INVOCATION_COLUMNS` and `createRoomInvocation` include `subject_human_id`; `setRoomMemberInvokableBy`. (b) `room-dispatch.mjs`: compute `subject` — human sender: `envelope.sender.owner_id`; agent sender: `(await repository.lookupRunningInvocation(...))`/the `completing` object that `assertAgentMayPost` already returns, `completing.subject_human_id`. For every dispatch site (mention, assignee, router targets) call `mayInvoke(subject, target)`; on deny call a shared `refuseInvocation({ ..., reason:'not_allowed' })` that posts the `room.event` and records `room.invocation_refused` exactly like the existing refusal helper (find it with `grep -n "invocation_refused" relay/v1/*.mjs` and reuse; do not duplicate). Pass `subjectHumanId` into every `createRoomInvocation`. (c) `applyRoomDispatch` router delivery: filter router members by `mayInvoke(subject, routerMember)`; `hasJoinedAgent` counts only `joins` agents passing `mayInvoke`. (d) agent_turns reset: only when `sender.owner_id` equals the `subject_human_id` of an active invocation in the thread (add `repository.threadHasActiveSubject(roomId, threadRootId, humanId, client)`). (e) `promoteNextInvocation`: inside its tx, after `deliveryBlocker`, check subject human `active` (`SELECT status FROM humans`), still an active room member of one of their endpoints, and `mayInvoke(subject_human_id, {owner_id, invokable_by})` from a fresh member query; on failure `UPDATE ... status='refused', finished_at=now`, emit the same event + audit, loop to the next queued row. (f) Route: `POST /v1/rooms/{id}/members/{endpoint}/invokable-by` — extend the path regex group `(remove|response-mode)` with `invokable-by`; require caller owns the agent (`member.owner_id === principal.human_id`), validate `owner|members`, call repository, `notifyRoomHumans`. (g) CLI `agent set-invokable --room --agent --mode` → repository call + `publishAdmin({type:'agent.invokable', room_ids:[room]})`; it requires the operator to be the agent's owner. (h) `room-bridge.mjs` preamble: name the owner endpoint (`member.owner_id`'s endpoint — `listRoomMembers` now returns `owner_id`; print `owner ${owner_id}`) and, when `invokable_by==='members'`, replace the sentence with "any room human who passes the invocation policy may task you". Update the web client types in Task 16, not here.
- [ ] **Step 5: Run each touched file; PASS. Commit** `feat(sigil): per-agent invokable_by with subject-carrying invocations`.

---

### Task 14: Other room controls

**Files:** Modify `relay/v1/room-routes.mjs` (response-mode, remove, stop, create), `postgres-repository.mjs` (`cancelInvocationsTx` selector), tests in `room-routes.manage.test.mjs`, `room-stop-concurrency.pg.test.mjs`, `rooms-manage.pg.test.mjs`.

**Interfaces:** `repository.cancelRoomInvocations({ roomId, ownerHumanId, subjectHumanId }, client)` cancels queued/running rows where the target agent's `owner_id = ownerHumanId` OR `subject_human_id = subjectHumanId`. (Locate the existing stop implementation first with `grep -n "stop" relay/v1/room-routes.mjs` and reuse its cancellation path, only changing the row selector.)

- [ ] **Step 1: Failing tests:** (1) a guest `room_manager` cannot change `response-mode` or remove an agent they do not own (403), the agent's owner can; (2) guest `stop` cancels an invocation whose `subject_human_id` is the guest and none of the operator's other invocations; operator `stop` cancels everything on their agents plus anything they started; (3) `POST /v1/rooms` as a non-operator endpoint → 403 `ROUTE_NOT_AUTHORIZED`, as operator → 201; (4) operator id derives from `endpoints.owner_id` of the `--room-human-identity` endpoint, so a second endpoint of the same human also creates rooms.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement:** in `response-mode`/`remove` branches, load target via `lookupTrustedEndpoint` and require `target.owner_id === principal.human_id` (humans removing themselves is not covered; removal of humans stays manager-only: `target.kind==='human'` keeps the manager check). Create-room: `if (principal.human_id !== humanSigner?.ownerId) return fail(... 403 ...)`. Stop: swap the selector.
- [ ] **Step 4: Run, PASS. Commit** `feat(sigil): owner-scoped agent controls, guest-scoped stop, operator-only room creation`.

---

### Task 15: Suspension

**Files:** Modify `postgres-repository.mjs` (`suspendHuman`, `unsuspendHuman`), `cli/human-commands.mjs` (`human suspend|unsuspend`), `human_sessions` revoke (check table exists: `grep -rn human_sessions sigil/migrations`; if the login spec's table is absent, guard step 3 with `SELECT to_regclass('human_sessions') IS NOT NULL` and skip the revoke when the table is absent (the login spec creates it); the test asserts suspension succeeds either way), tests `human-suspension.pg.test.mjs`.

**Interfaces:** `repository.suspendHuman({ humanId, actorHumanId }, client)` → `{ endpoint_ids }`; `unsuspendHuman({ humanId, actorHumanId }, client)`.

- [ ] **Step 1: Failing pg tests:** (1) suspend sets `humans.status`, flips only `active` endpoints and records `suspended_by_human_id`, leaves `revoked`/independently-`suspended` endpoints alone, writes `human.suspended`; (2) next authenticator call returns `null` (cache cleared by listener; assert via cross-process test from Task 12 now enabled: sockets for both of a two-endpoint human close 1008); (3) fan-out skips the suspended endpoint (`endpointIsActive` false) and no delivery counts toward `inboxDepthLimit`; (4) unsuspend restores only endpoints with `suspended_by_human_id = human` and status `suspended`, clears the column, leaves a pre-revoked endpoint revoked and an independently suspended endpoint suspended; (5) suspend cancels the human's queued and running invocations (`subject_human_id`), via the same `cancelRoomInvocations` path with `subjectHumanId`; removing a human from a room cancels theirs in that room only (add to the remove route and `removeRoomMember` caller); (6) concurrency: a returning-login stand-in taking `SELECT ... FOR SHARE` on the humans row either blocks until suspension commits or sees `suspended` (assert with two clients).
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement** `suspendHuman` as one tx in the spec's order (humans first, then endpoints, then sessions, then audit); command wraps it with `publishAdmin({ type:'human.suspended', human_id })` in the same tx. Unsuspend publishes `human.unsuspended`.
- [ ] **Step 4: Run, PASS. Commit** `feat(sigil): suspend and unsuspend humans with live revocation`.

---

### Task 16: `display_name` in room responses and the web client

**Files:** Modify `postgres-repository.mjs` (`memberRow`, `listRoomMembers`, room message history query, `joins endpoints`), memory repository equivalent, `packages/sigil-rooms-web/src/**/RowView.tsx:27`, `RosterPanel.tsx:26`, the API types file, `/v1/auth/me` handler (find with `grep -rn "auth/me" sigil`), tests in `room-routes.test.mjs`, `rooms.pg.test.mjs`, and the web package's vitest files beside those components.

**Interfaces:** Member and message items carry `display_name` (from `endpoints.display_name`, falling back to `endpoint_id`). `/v1/auth/me` returns `display_name`.

- [ ] **Step 1: Failing tests:** pg: `listRoomMembers` and room history rows include `display_name` (provisioned human shows the provisioning name; endpoint without name shows its id). Web (vitest): `RowView` renders `display_name` when present and falls back to the endpoint id; `RosterPanel` the same; roster hides `invokable_by` controls unless the viewer owns the agent and shows the current mode.
- [ ] **Step 2: Run, expect FAIL** (`npm --prefix packages/sigil-rooms-web test -- RowView RosterPanel`). **Step 3: Implement** the SQL joins, types (`display_name: string`, `invokable_by`, `owner_id` on members), and component changes at the two cited lines; add the "invokable by" control calling `POST .../invokable-by`.
- [ ] **Step 4: Run** `npm run test:web` (single process). PASS. **Commit** `feat(sigil): show endpoint display names in rooms; invokable-by control`.

---

### Task 17: Documentation and full verification

**Files:** Modify `README.md` section for rooms/relay (find with `grep -n "room-human-identity" README.md docs -r`), `CHANGELOG.md`, `STATUS.md` (shared session contract in the repo AGENTS.md), `docs/` operator guide if one exists for `sigil relay up`.

- [ ] **Step 1:** Document: one `--room-key-wrap-key <ref>` reference for relay and CLI; `--reconcile-kind`; `--public-origin` needs `--room-human-identity`; the residual-risk paragraph (invokable_by governs who starts an invocation, not what an agent reads; guests see full history); `human`, `agent set-invokable`, `endpoint revoke` commands; trust change (rows in `endpoint_keys` decide who may sign).
- [ ] **Step 2: Full run, one process:** `timeout 600 npm test` with `SIGIL_TEST_DATABASE_URL` set; if it exceeds the timeout, run the directories separately (`node --test sigil/relay/v1`, `sigil/cli`, `sigil/migrations`). Record exact pass/fail counts in `STATUS.md`. Do not claim green without the output.
- [ ] **Step 3: Spec-coverage walk:** open the spec's Testing section and tick each bullet against a named test from Tasks 2-16; any unticked bullet becomes a new test before closing.
- [ ] **Step 4: Update `STATUS.md`, commit** `docs(sigil): document multi-human foundation operations`. Hand off to the login-spec plan.

---

## Self-review

**Spec coverage.** Trusted lookup + entry shape + key rule (T3), consumer migration list (T4), `kind` column/writers/authenticator (T2, T5), startup seed/`REGISTRY_CONFLICT`/`--reconcile-kind` (T6), one signing key, shadow rotation, endpoint revoke (T2, T7), NOTIFY channel/cache/liveness/revalidate (T12), provisioning + wrap (T8, T9), membership + lock order (T10), signing seam + 503/403/500 mapping (T11), invocation policy incl. hop inheritance, router, assignee, promotion recheck, turn reset, set-invokable, bridge preamble (T13), response-mode/remove/stop/create (T14), suspension (T15), display name + client (T16), docs (T17). Out-of-scope items (login, browser keys, memory provisioning) stay out; memory repo gets only the normalizers it needs.

**Known execution risks to check early.** (1) `apply-migrations.mjs` may lack a `through` option (T2 step 1 says to add one). (2) T3 step 6 keeps legacy top-level `key_id`/`public_key` on registry entries until T11 deletes the last reader. (3) `human_attributes` NOT NULL columns and `audit_events.actor_human_id` nullability are read from migrations at T9, not assumed. (4) Stream authenticator must return `owner_id` (T12) before `revalidate({ humanId })` can select sockets. (5) The login spec reuses `lockManagerRows`, `publishAdmin`, `isSocketLive`, and `provisionHumanTx`; do not rename them.

**Type consistency.** `lookupTrustedEndpoint` entry, `keyVerifies`, `provisionHumanTx` return, `mayInvoke(subject, {owner_id, invokable_by})`, `createRoomInvocation({subjectHumanId})`, `publishAdmin` payload types are used under the same names in every task above.
