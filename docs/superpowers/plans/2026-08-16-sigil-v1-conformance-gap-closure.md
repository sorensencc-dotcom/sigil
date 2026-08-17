# Sigil v1 Conformance Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 8 remaining §18 conformance gaps (#8, #10, #13, #14, #19, #21, #22, #23) plus workstream H (sender delivery receipts + heartbeat, surfaced during design review) in `C:\dev\sigil-repo`.

**Architecture:** `validateEnvelope` stays synchronous/pure (unit-testable without a DB); all new DB-backed checks (capability grants, replay lookup, quota, task cross-reference) are loaded by `acceptEnvelopeAsync` inside a single repository transaction and passed into `validateEnvelope` as pre-resolved snapshots. A shared `withTransaction` helper and a "transaction-bound client" convention (every repository method that participates in the accept transaction takes an explicit `client` param) make the whole thing atomic. `PostgresRepository` and `memory-repository.mjs` are kept behaviorally equivalent throughout.

**Tech Stack:** Node.js (`node --test`), `pg` (already resolves from `C:\dev\node_modules`, not yet in this repo's own `package.json` — noted, not fixed, out of scope), `ws`, new `canonicalize` npm dependency (RFC 8785 JCS).

**Spec:** `docs/specs/sigil-v1-conformance-gap-closure-design.md` (this plan implements it in full; §18 conformance items map to workstreams D/F/B/A/C/E/G below, workstream H is design-review-only).

## Global Constraints

- Build order is fixed: **D → F → (transactional infra) → B → A → C → E → H → G** (design §2). Do not reorder tasks.
- `validateEnvelope` (`sigil/relay/v1/validate-envelope.mjs`) stays synchronous and stateless — no DB calls inside it, ever. New inputs arrive as pre-resolved maps/sets/arrays, same shape as the existing `idempotency` param (design §3).
- Every repository method that participates in the accept transaction (grant lookup, message_id lookup, quota/depth check, envelope insert) takes the same `client` param and uses it, not the ambient pool (design §3 blocker 4).
- All new migrations are idempotent: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` (design §12).
- Every new DB-backed behavior is implemented and tested against **both** `PostgresRepository` (`sigil/relay/v1/postgres-repository.mjs`, gated on `SIGIL_TEST_DATABASE_URL`) and `memory-repository.mjs` (`sigil/cli/memory-repository.mjs`) so the CLI dev path and the production path never silently diverge (design §12).
- Config values (rate limits, inbox depth, heartbeat) are configuration with documented defaults, never hardcoded without an override path (design §8, §13): endpoint 100/min, owner 500/min, conversation 200/min, recipient inbox depth 500, heartbeat interval 15s / timeout 45s (3 missed).
- Heartbeat framing is JSON application frames over the existing `stream-server.mjs` channel, never native WebSocket control-frame ping/pong (design §10, round 4 guidance).
- Test files are colocated `*.test.mjs` next to source, following existing repo convention. Every workstream also gets one addition to `sigil/integration/vertical-slice.test.mjs` proving its §18 scenario end-to-end (design §12).

---

## File Structure

New files this plan creates:

- `sigil/relay/v1/jcs.mjs` — shared RFC 8785 canonicalizer (D)
- `sigil/relay/v1/jcs.test.mjs` — JCS vector tests (D)
- `sigil/relay/v1/ed25519-probe.test.mjs` — signing-implementation probe (D)
- `sigil/contracts/v1/task-request-schema.mjs`, `task-request-schema.test.mjs` (F)
- `sigil/contracts/v1/task-result-schema.mjs`, `task-result-schema.test.mjs` (F)
- `sigil/relay/v1/with-transaction.mjs`, `with-transaction.test.mjs` (infra)
- `sigil/relay/v1/scope.mjs`, `scope.test.mjs` (A) — extracted from `context-resolver.mjs`
- `sigil/relay/v1/relay-config.mjs`, `relay-config.test.mjs` (C, H) — rate/quota/heartbeat defaults
- `sigil/migrations/005_message_lookup_index.sql` (B)
- `sigil/migrations/006_capability_registry.sql` (A)
- `sigil/migrations/007_rate_quota.sql` (C)
- `sigil/migrations/008_audit_conversation_binding.sql` (E)
- `sigil/migrations/009_display_name_collision.sql` (G)
- `sigil/migrations/010_endpoint_acknowledgements.sql` (G)

Modified files: `validate-envelope.mjs`, `action-hash.mjs`, `accept-envelope.mjs`, `postgres-repository.mjs`, `memory-repository.mjs`, `http-server.mjs`, `stream-server.mjs`, `delivery-state.mjs`, `context-resolver.mjs`, `cli/sigil.mjs`, `cli/inbox-wait.mjs`, `cli/registry-store.mjs`, `docs/specs/sigil-implementation-decisions-v1.0.md`, `sigil/contracts/v1/errors-and-states.json`, `package.json`.

---

## Task 1: D1 — Ed25519 signing-implementation probe

**Files:**
- Create: `sigil/relay/v1/ed25519-probe.test.mjs`
- Modify: `docs/specs/sigil-implementation-decisions-v1.0.md`

**Interfaces:**
- Produces: a recorded decision (node:crypto vs `@noble/ed25519`) that Task 2 depends on.

- [ ] **Step 1: Write the probe test**

```javascript
// sigil/relay/v1/ed25519-probe.test.mjs
// Probe for design §4: confirm node:crypto.verify(null, bytes, key, sig)
// (already used at validate-envelope.mjs:47) has no gap against RFC 8032
// Ed25519 vectors and the PEM re-import path registry-store.mjs relies on,
// before deciding whether @noble/ed25519 is actually needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKeyFromRaw(rawHex) {
  const raw = Buffer.from(rawHex, 'hex');
  return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

test('node:crypto verifies RFC 8032 §7.1 Ed25519 test vector 1', () => {
  const publicKey = publicKeyFromRaw('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511');
  const message = Buffer.alloc(0);
  const signature = Buffer.from('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100', 'hex');
  assert.equal(crypto.verify(null, message, publicKey, signature), true);
});

test('node:crypto sign/verify roundtrips through PEM re-import (registry-store.mjs pattern)', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const reimported = crypto.createPublicKey(pem);
  const message = Buffer.from('probe message with unicode café 🔑');
  const signature = crypto.sign(null, message, privateKey);
  assert.equal(crypto.verify(null, message, reimported, signature), true);
});

test('node:crypto rejects a tampered signature', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const message = Buffer.from('probe');
  const signature = crypto.sign(null, message, privateKey);
  signature[0] ^= 0xff;
  assert.equal(crypto.verify(null, message, publicKey, signature), false);
});
```

- [ ] **Step 2: Run the probe**

Run: `node --test sigil/relay/v1/ed25519-probe.test.mjs`
Expected: all 3 PASS — this confirms `node:crypto` has no gap.

- [ ] **Step 3: Record the decision amendment**

Append to `docs/specs/sigil-implementation-decisions-v1.0.md` (near the existing canonicalize/Ed25519 line found at the "Why:" paragraph citing `@noble/ed25519`):

```markdown

### Amendment 2026-08-16 — Ed25519: stay on node:crypto

Probe (`sigil/relay/v1/ed25519-probe.test.mjs`) confirmed `node:crypto.verify(null, bytes, key, sig)`
correctly verifies an official RFC 8032 §7.1 test vector, round-trips through
PEM re-import (the exact path `registry-store.mjs` uses), and correctly
rejects tampered signatures. No gap found against the decision doc's intent.
`@noble/ed25519` is **not added** as a dependency; `node:crypto` remains the
conforming Ed25519 implementation for both signing and verification.
```

- [ ] **Step 4: Commit**

```bash
git add sigil/relay/v1/ed25519-probe.test.mjs docs/specs/sigil-implementation-decisions-v1.0.md
git commit -m "test: probe node:crypto Ed25519 against RFC 8032 vector, confirm no gap"
```

---

## Task 2: D2 — Shared JCS canonicalizer

**Files:**
- Create: `sigil/relay/v1/jcs.mjs`
- Create: `sigil/relay/v1/jcs.test.mjs`
- Modify: `sigil/relay/v1/validate-envelope.mjs:5-8,11-15`
- Modify: `sigil/relay/v1/action-hash.mjs:6-19`
- Modify: `sigil/relay/v1/validate-envelope.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `canonicalJson(value): string`, `canonicalJsonBytes(value): Buffer`, `assertCanonicalizable(value, code?): void` from `jcs.mjs` — consumed by `validate-envelope.mjs` (`signedBytes`) and `action-hash.mjs` (`canonicalAction`), and by later workstreams (B, A) that hash canonical bytes.

- [ ] **Step 1: Add the dependency**

```bash
npm install canonicalize@2.0.0 --save-exact
```

Verify `package.json` now has `"canonicalize": "2.0.0"` (exact, no caret) under `dependencies`, per design §4's "pin an exact version" hardening requirement.

- [ ] **Step 2: Write the failing JCS vector tests**

```javascript
// sigil/relay/v1/jcs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, assertCanonicalizable } from './jcs.mjs';

test('JCS: object keys are sorted regardless of input order', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('JCS: nested object and array ordering is normalized', () => {
  const a = { z: [{ y: 1, x: 2 }], m: { b: 1, a: 2 } };
  const b = { m: { a: 2, b: 1 }, z: [{ x: 2, y: 1 }] };
  assert.equal(canonicalJson(a), canonicalJson(b));
});

test('JCS: reparsing differently-formatted JSON text produces identical bytes', () => {
  const fromCompact = JSON.parse('{"a":1,"b":2}');
  const fromSpaced = JSON.parse('{ "b" : 2 ,  "a" : 1 }');
  assert.equal(canonicalJson(fromCompact), canonicalJson(fromSpaced));
});

test('JCS: unicode strings are preserved without re-escaping', () => {
  assert.equal(canonicalJson({ name: 'café 🔑' }), '{"name":"café 🔑"}');
});

test('assertCanonicalizable rejects non-finite numbers and undefined', () => {
  assert.throws(() => assertCanonicalizable({ a: NaN }), /unsupported value/);
  assert.throws(() => assertCanonicalizable({ a: Infinity }), /unsupported value/);
  assert.throws(() => assertCanonicalizable({ a: undefined }), /unsupported value/);
});

test('assertCanonicalizable accepts strings, booleans, finite numbers, nested arrays/objects', () => {
  assert.doesNotThrow(() => assertCanonicalizable({ a: 'x', b: true, c: 1.5, d: [1, { e: null }] }));
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test sigil/relay/v1/jcs.test.mjs`
Expected: FAIL — `Cannot find module './jcs.mjs'`

- [ ] **Step 4: Implement jcs.mjs**

```javascript
// sigil/relay/v1/jcs.mjs
// RFC 8785 JSON Canonicalization Scheme, shared by every module that signs
// or hashes envelope/action bytes (validate-envelope.mjs, action-hash.mjs).
// Replaces the hand-rolled per-module canonicalize() functions per the
// Tier-1-locked sigil-implementation-decisions-v1.0.md.
import canonicalize from 'canonicalize';

export function assertCanonicalizable(value, code = 'INVALID_ACTION') {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw Object.assign(new Error('Value contains an unsupported value'), { code });
    return;
  }
  if (Array.isArray(value)) { for (const item of value) assertCanonicalizable(item, code); return; }
  if (type === 'object') { for (const key of Object.keys(value)) assertCanonicalizable(value[key], code); return; }
  throw Object.assign(new Error('Value contains an unsupported value'), { code });
}

export function canonicalJson(value) {
  const text = canonicalize(value);
  if (text === undefined) throw Object.assign(new Error('Value cannot be canonicalized'), { code: 'INVALID_ENVELOPE' });
  return text;
}

export function canonicalJsonBytes(value) {
  return Buffer.from(canonicalJson(value), 'utf8');
}
```

- [ ] **Step 5: Wire into validate-envelope.mjs**

Replace lines 1-15 of `sigil/relay/v1/validate-envelope.mjs`:

```javascript
import crypto from 'node:crypto';
import { canonicalJsonBytes } from './jcs.mjs';

const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

export function signedBytes(envelope) {
  const unsigned = { ...envelope };
  delete unsigned.signature;
  return canonicalJsonBytes(unsigned);
}
```

(Deletes the local `canonicalize()` function entirely; everything after `signedBytes` in the file is unchanged.)

- [ ] **Step 6: Wire into action-hash.mjs**

Replace lines 1-19 of `sigil/relay/v1/action-hash.mjs`:

```javascript
import crypto from 'node:crypto';
import { canonicalJson, assertCanonicalizable } from './jcs.mjs';

const ACTION_HASH_ALGORITHM = 'sha256:jcs-sigil-action-v1';
const ACTION_FIELDS = ['action_type', 'target', 'context_refs', 'requested_capabilities', 'arguments', 'endpoint_id', 'contract_version', 'policy_version'];

export function canonicalAction(action = {}) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw Object.assign(new Error('Action must be an object'), { code: 'INVALID_ACTION' });
  const selected = Object.fromEntries(ACTION_FIELDS.filter((field) => Object.hasOwn(action, field)).map((field) => [field, action[field]]));
  if (!selected.action_type || !selected.endpoint_id || !selected.contract_version) throw Object.assign(new Error('Action binding fields are required'), { code: 'INVALID_ACTION' });
  assertCanonicalizable(selected, 'INVALID_ACTION');
  return canonicalJson(selected);
}
```

(`computeActionHash` and the final `export { ACTION_HASH_ALGORITHM, ACTION_FIELDS };` line are unchanged — `canonicalAction` still returns a string, so `crypto.createHash('sha256').update(canonicalAction(action))` keeps working unmodified.)

- [ ] **Step 7: Run jcs.test.mjs, action-hash.test.mjs, validate-envelope.test.mjs**

Run: `node --test sigil/relay/v1/jcs.test.mjs sigil/relay/v1/action-hash.test.mjs sigil/relay/v1/validate-envelope.test.mjs`
Expected: all PASS unchanged (canonical output is byte-identical to the old hand-rolled canonicalizer for all inputs these tests use — RFC 8785 and the old sorted-keys/no-whitespace scheme agree on ASCII string/number/bool/array/object shapes; they diverge only on number formatting edge cases and non-ASCII escaping, neither of which the existing fixtures exercise).

- [ ] **Step 8: Add the literal §18 #14 reordered-key/whitespace signature test**

Add to `sigil/relay/v1/validate-envelope.test.mjs` (after the existing tests, using the file's existing `base`, `privateKey`, `options`):

```javascript
function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object') {
    const reversed = {};
    for (const key of Object.keys(value).reverse()) reversed[key] = reverseKeys(value[key]);
    return reversed;
  }
  return value;
}

test('signature verifies across reordered keys and alternate transport encodings (§18 #14)', () => {
  const candidate = structuredClone(base);
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  // Reorder every nesting level's keys, then re-serialize with different
  // whitespace -- simulates a different HTTP client/JSON library re-encoding
  // the same logical envelope in transit.
  const reordered = JSON.parse(JSON.stringify(reverseKeys(candidate), null, 2));
  assert.deepEqual(signedBytes(reordered), signedBytes(candidate));
  assert.equal(validateEnvelope(reordered, options).accepted, true);
});
```

- [ ] **Step 9: Run to verify passing**

Run: `node --test sigil/relay/v1/validate-envelope.test.mjs`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json sigil/relay/v1/jcs.mjs sigil/relay/v1/jcs.test.mjs sigil/relay/v1/validate-envelope.mjs sigil/relay/v1/action-hash.mjs sigil/relay/v1/validate-envelope.test.mjs
git commit -m "feat(D): replace hand-rolled canonicalization with RFC 8785 JCS"
```

---

## Task 3: D3 — Fixture drift gate + single-implementation completion gate

**Files:**
- Modify: `sigil/relay/v1/jcs.test.mjs`

**Interfaces:**
- Consumes: `canonicalJson` from `jcs.mjs` (Task 2).

- [ ] **Step 1: Audit for lingering hand-rolled canonicalizers**

Run: `grep -rn "function canonicalize" sigil/`
Expected: zero matches (both prior implementations were removed in Task 2). Run: `grep -rln "canonicalize\|JCS" sigil/contracts/v1/` to confirm `validate-contracts.mjs` has no local canonicalizer of its own — it doesn't (it only validates `errors-and-states.json` shape, no hashing). This satisfies design §4's "grep the full sigil/ tree ... a lingering second implementation anywhere is exactly the drift this workstream exists to close" completion gate.

- [ ] **Step 2: Confirm no fixture embeds a precomputed hash**

Run: `grep -n "hash\|signature" sigil/contracts/v1/envelope.example.json`
Expected: only `"signature": { "algorithm": "Ed25519", "key_id": "key_01JEXAMPLE", "value": "base64url:REPLACE_IN_TEST_FIXTURE" }` — a placeholder string every consuming test already overwrites (`validate-envelope.test.mjs:11`, `vertical-slice.test.mjs:23`), not a precomputed real signature or hash. No fixture regeneration is needed today; the design's regeneration requirement is satisfied vacuously for the current fixture set.

- [ ] **Step 3: Add a pinned-bytes regression test as drift insurance**

Add to `sigil/relay/v1/jcs.test.mjs` so a future accidental change to the canonicalizer (e.g. a `canonicalize` version bump that changes number formatting) is caught immediately instead of silently reaching a real fixture later:

```javascript
test('JCS: canonical bytes for the envelope example fixture shape are pinned', async () => {
  const fs = await import('node:fs');
  const template = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  const unsigned = { ...template };
  delete unsigned.signature;
  assert.equal(
    canonicalJson(unsigned),
    '{"body":{"dependencies":[],"deadline":"2026-08-13T00:00:00Z","instruction":"Review the API migration.","success_criteria":["Identify breaking route changes"],"task_id":"task_01JEXAMPLE"},"capabilities":[],"context_refs":[],"conversation_id":"conv_01JEXAMPLE","correlation_id":null,"created_at":"2026-08-12T00:00:00Z","expires_at":"2026-08-13T00:00:00Z","idempotency_key":"send_01JEXAMPLE","message_id":"msg_01JEXAMPLE","message_type":"task.request","protocol":"sigil/1","recipient":{"endpoint_id":"ep_claude","owner_id":"usr_claude_owner"},"sender":{"endpoint_id":"ep_codex","kind":"agent","owner_id":"usr_codex_owner"}}'
  );
});
```

- [ ] **Step 4: Run to verify passing**

Run: `node --test sigil/relay/v1/jcs.test.mjs`
Expected: PASS. If it fails, the printed actual value is the correct pin — paste it in verbatim (this is a snapshot test, not a hand-computed value).

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/jcs.test.mjs
git commit -m "test(D): pin canonical bytes for envelope fixture, confirm no lingering canonicalizer"
```

---

## Task 4: F1 — Task request/result body schema validators

**Files:**
- Create: `sigil/contracts/v1/task-request-schema.mjs`
- Create: `sigil/contracts/v1/task-request-schema.test.mjs`
- Create: `sigil/contracts/v1/task-result-schema.mjs`
- Create: `sigil/contracts/v1/task-result-schema.test.mjs`
- Modify: `sigil/relay/v1/validate-envelope.mjs`
- Modify: `sigil/relay/v1/validate-envelope.test.mjs`

**Interfaces:**
- Produces: `validateTaskRequestBody(body): void` (throws `INVALID_ENVELOPE`), `validateTaskResultBody(body): void` (throws `INVALID_ENVELOPE`) — consumed by `validateEnvelope` in this task, and referenced by Task 5's cross-reference check.

- [ ] **Step 1: Write failing schema tests**

```javascript
// sigil/contracts/v1/task-request-schema.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskRequestBody } from './task-request-schema.mjs';

test('accepts a minimal valid task.request body', () => {
  assert.doesNotThrow(() => validateTaskRequestBody({ task_id: 'task_1', instruction: 'Do the thing' }));
});

test('accepts optional arrays and ISO deadline', () => {
  assert.doesNotThrow(() => validateTaskRequestBody({ task_id: 'task_1', instruction: 'x', success_criteria: ['a'], dependencies: [], deadline: '2026-08-20T00:00:00Z' }));
});

for (const [name, body] of [
  ['missing task_id', { instruction: 'x' }],
  ['missing instruction', { task_id: 'task_1' }],
  ['empty task_id', { task_id: '', instruction: 'x' }],
  ['empty instruction', { task_id: 'task_1', instruction: '' }],
  ['non-array success_criteria', { task_id: 'task_1', instruction: 'x', success_criteria: 'not-array' }],
  ['non-array dependencies', { task_id: 'task_1', instruction: 'x', dependencies: 'not-array' }],
  ['non-ISO deadline', { task_id: 'task_1', instruction: 'x', deadline: 'not-a-date' }],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => validateTaskRequestBody(body), (error) => error.code === 'INVALID_ENVELOPE');
  });
}
```

```javascript
// sigil/contracts/v1/task-result-schema.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskResultBody } from './task-result-schema.mjs';

test('accepts a minimal valid task.result body', () => {
  assert.doesNotThrow(() => validateTaskResultBody({ task_id: 'task_1', status: 'completed', summary: 'Done.' }));
});

test('accepts every valid status value', () => {
  for (const status of ['accepted', 'in_progress', 'completed', 'blocked', 'rejected', 'expired']) {
    assert.doesNotThrow(() => validateTaskResultBody({ task_id: 'task_1', status, summary: 'x' }));
  }
});

test('accepts optional arrays', () => {
  assert.doesNotThrow(() => validateTaskResultBody({ task_id: 'task_1', status: 'completed', summary: 'x', findings: ['a'], artifacts: [], verification: ['b'] }));
});

for (const [name, body] of [
  ['missing task_id', { status: 'completed', summary: 'x' }],
  ['missing status', { task_id: 'task_1', summary: 'x' }],
  ['missing summary', { task_id: 'task_1', status: 'completed' }],
  ['invalid status', { task_id: 'task_1', status: 'done', summary: 'x' }],
  ['non-array findings', { task_id: 'task_1', status: 'completed', summary: 'x', findings: 'not-array' }],
  ['non-array artifacts', { task_id: 'task_1', status: 'completed', summary: 'x', artifacts: 'not-array' }],
  ['non-array verification', { task_id: 'task_1', status: 'completed', summary: 'x', verification: 'not-array' }],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => validateTaskResultBody(body), (error) => error.code === 'INVALID_ENVELOPE');
  });
}
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test sigil/contracts/v1/task-request-schema.test.mjs sigil/contracts/v1/task-result-schema.test.mjs`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement task-request-schema.mjs**

```javascript
// sigil/contracts/v1/task-request-schema.mjs
// Pure body-shape validation for message_type: 'task.request', per design §5.
// No repository access here -- consistent with the repo's no-heavy-dependency
// style and with validateEnvelope's synchronous/stateless contract.
function fail(field, reason) {
  throw Object.assign(new Error(`Invalid task.request body: ${reason}`), { code: 'INVALID_ENVELOPE', details: { field, reason } });
}

export function validateTaskRequestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('body', 'must be an object');
  if (typeof body.task_id !== 'string' || !body.task_id) fail('task_id', 'required non-empty string');
  if (typeof body.instruction !== 'string' || !body.instruction) fail('instruction', 'required non-empty string');
  if ('success_criteria' in body && !Array.isArray(body.success_criteria)) fail('success_criteria', 'must be an array');
  if ('dependencies' in body && !Array.isArray(body.dependencies)) fail('dependencies', 'must be an array');
  if ('deadline' in body && (typeof body.deadline !== 'string' || !Number.isFinite(Date.parse(body.deadline)))) fail('deadline', 'must be an ISO 8601 date string');
}
```

- [ ] **Step 4: Implement task-result-schema.mjs**

```javascript
// sigil/contracts/v1/task-result-schema.mjs
// Pure body-shape validation for message_type: 'task.result', per design §5.
const VALID_STATUSES = new Set(['accepted', 'in_progress', 'completed', 'blocked', 'rejected', 'expired']);

function fail(field, reason) {
  throw Object.assign(new Error(`Invalid task.result body: ${reason}`), { code: 'INVALID_ENVELOPE', details: { field, reason } });
}

export function validateTaskResultBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('body', 'must be an object');
  if (typeof body.task_id !== 'string' || !body.task_id) fail('task_id', 'required non-empty string');
  if (typeof body.status !== 'string' || !VALID_STATUSES.has(body.status)) fail('status', `must be one of ${[...VALID_STATUSES].join(' | ')}`);
  if (typeof body.summary !== 'string' || !body.summary) fail('summary', 'required non-empty string');
  if ('findings' in body && !Array.isArray(body.findings)) fail('findings', 'must be an array');
  if ('artifacts' in body && !Array.isArray(body.artifacts)) fail('artifacts', 'must be an array');
  if ('verification' in body && !Array.isArray(body.verification)) fail('verification', 'must be an array');
}
```

- [ ] **Step 5: Run to verify passing**

Run: `node --test sigil/contracts/v1/task-request-schema.test.mjs sigil/contracts/v1/task-result-schema.test.mjs`
Expected: PASS

- [ ] **Step 6: Wire into validateEnvelope**

In `sigil/relay/v1/validate-envelope.mjs`, add imports at the top:

```javascript
import { validateTaskRequestBody } from '../../contracts/v1/task-request-schema.mjs';
import { validateTaskResultBody } from '../../contracts/v1/task-result-schema.mjs';
```

Add this check right after the existing `if (!Array.isArray(envelope.context_refs) || !Array.isArray(envelope.capabilities)) throw reject(...)` line (line 57):

```javascript
  if (envelope.message_type === 'task.request') validateTaskRequestBody(envelope.body);
  if (envelope.message_type === 'task.result') validateTaskResultBody(envelope.body);
```

(These throw `INVALID_ENVELOPE` errors directly with `.code` already set — `validateEnvelope` doesn't need to wrap them, matching how every other check in this function throws via `reject()`.)

- [ ] **Step 7: Add validateEnvelope-level tests**

Add to `sigil/relay/v1/validate-envelope.test.mjs`:

```javascript
test('rejects a task.request envelope with an invalid body', () => {
  const candidate = structuredClone(base);
  delete candidate.body.instruction;
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  assert.throws(() => validateEnvelope(candidate, options), (error) => error.code === 'INVALID_ENVELOPE' && error.details?.field === 'instruction');
});

test('rejects a task.result envelope with an invalid status', () => {
  const candidate = { ...base, message_type: 'task.result', body: { task_id: 'task_1', status: 'nope', summary: 'x' } };
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  assert.throws(() => validateEnvelope(candidate, options), (error) => error.code === 'INVALID_ENVELOPE' && error.details?.field === 'status');
});
```

- [ ] **Step 8: Run full validate-envelope suite**

Run: `node --test sigil/relay/v1/validate-envelope.test.mjs`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add sigil/contracts/v1/task-request-schema.mjs sigil/contracts/v1/task-request-schema.test.mjs sigil/contracts/v1/task-result-schema.mjs sigil/contracts/v1/task-result-schema.test.mjs sigil/relay/v1/validate-envelope.mjs sigil/relay/v1/validate-envelope.test.mjs
git commit -m "feat(F): add task.request/task.result body schema validation"
```

---

## Task 5: Infra1 — Shared `withTransaction` helper

**Files:**
- Create: `sigil/relay/v1/with-transaction.mjs`
- Create: `sigil/relay/v1/with-transaction.test.mjs`
- Modify: `sigil/relay/v1/postgres-repository.mjs:136-141`
- Modify: `sigil/relay/v1/postgres-repository.test.mjs`

**Interfaces:**
- Produces: `withTransaction(pool, fn): Promise<any>` — consumed by `PostgresRepository` in this task, and directly by `acceptEnvelopeAsync` in Task 6, and by the rejection-audit fallback in Task 18 (E3).

- [ ] **Step 1: Write failing tests**

```javascript
// sigil/relay/v1/with-transaction.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { withTransaction } from './with-transaction.mjs';

function fakePool() {
  const calls = [];
  const client = { async query(text) { calls.push(text); }, release() { calls.push('RELEASE'); } };
  return { calls, async connect() { calls.push('CONNECT'); return client; } };
}

test('commits and releases on success', async () => {
  const pool = fakePool();
  const result = await withTransaction(pool, async (client) => { await client.query('SELECT 1'); return 'ok'; });
  assert.equal(result, 'ok');
  assert.deepEqual(pool.calls, ['CONNECT', 'BEGIN', 'SELECT 1', 'COMMIT', 'RELEASE']);
});

test('rolls back and releases on error, then rethrows', async () => {
  const pool = fakePool();
  await assert.rejects(
    () => withTransaction(pool, async () => { throw new Error('boom'); }),
    /boom/
  );
  assert.deepEqual(pool.calls, ['CONNECT', 'BEGIN', 'ROLLBACK', 'RELEASE']);
});

test('releases even when rollback itself is never reached (release is in finally)', async () => {
  const pool = fakePool();
  try { await withTransaction(pool, async () => { throw Object.assign(new Error('x'), { code: 'CUSTOM' }); }); } catch {}
  assert.equal(pool.calls.at(-1), 'RELEASE');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test sigil/relay/v1/with-transaction.test.mjs`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement with-transaction.mjs**

```javascript
// sigil/relay/v1/with-transaction.mjs
// Standardizes connect/BEGIN/fn/COMMIT/ROLLBACK/release (design §3 "single
// transaction-bound client" requirement, blocker 4) so no call site can
// forget to release on an error path.
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run to verify passing**

Run: `node --test sigil/relay/v1/with-transaction.test.mjs`
Expected: PASS

- [ ] **Step 5: Refactor PostgresRepository to use it**

In `sigil/relay/v1/postgres-repository.mjs`, add the import at the top:

```javascript
import { withTransaction } from './with-transaction.mjs';
```

Replace the `withTransaction` method body (lines 136-141):

```javascript
  async withTransaction(work) {
    return withTransaction(this.pool, work);
  }
```

(Every existing call site — `finalizeApprovalDecision`, `claimDelivery`, `transitionDelivery`, `#persistAcceptedEnvelopeTransaction`, `acknowledgeDelivery`, `unlinkAccount`, `rotateEndpointToken`, `revokeEndpointToken`, `revokeCapabilityGrant`, and the five `*WithAudit` methods — calls `this.withTransaction(...)` and is unaffected by this refactor; behavior is identical, just deduplicated.)

- [ ] **Step 6: Run the full postgres-repository suite**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: PASS — all 9 existing tests unchanged (this is a pure refactor, no behavior change).

- [ ] **Step 7: Commit**

```bash
git add sigil/relay/v1/with-transaction.mjs sigil/relay/v1/with-transaction.test.mjs sigil/relay/v1/postgres-repository.mjs
git commit -m "refactor(infra): extract shared withTransaction helper"
```

---

## Task 6: Infra2 — Transactional accept pipeline + F2 task cross-reference

This is the load-bearing task: it turns `acceptEnvelopeAsync` into the single place where every repository-backed accept-time check (task cross-reference now; replay in Task 8, capability in Task 11, quota in Task 13) runs inside one transaction on one client. Workstreams B/A/C only add checks *into* this pipeline — they do not re-architect it again.

**Files:**
- Modify: `sigil/relay/v1/accept-envelope.mjs`
- Modify: `sigil/relay/v1/accept-envelope.test.mjs`
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Modify: `sigil/relay/v1/postgres-repository.test.mjs`
- Modify: `sigil/cli/memory-repository.mjs`
- Modify: `sigil/cli/memory-repository.test.mjs`
- Modify: `sigil/relay/v1/http-server.mjs:28-34,113-119`

**Interfaces:**
- Consumes: `withTransaction` (Task 5), `validateTaskResultBody`'s already-validated shape (Task 4 ran inside `validateEnvelope`).
- Produces: `repository.lookupTaskRequest(taskId, conversationId, client): Promise<{message_id: string} | null>` (both repositories) — consumed here and available for later workstreams' repository-backed checks. `acceptEnvelopeAsync(envelope, options)` gains a `repository` option; when present, it drives the whole transaction itself instead of relying on `options.persist`/`options.lookupIdempotency` callbacks (those remain supported for the no-`repository` / unit-test path, unchanged).

- [ ] **Step 1: Write the failing cross-reference test**

Add to `sigil/relay/v1/accept-envelope.test.mjs` (new file if one doesn't already cover `acceptEnvelopeAsync` end-to-end with a repository double — check first; if `accept-envelope.test.mjs` exists, append):

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';

function fakeTransactionalRepository({ taskRequests = new Map(), envelopes = new Map() } = {}) {
  const calls = [];
  return {
    calls,
    async withTransaction(fn) { calls.push('BEGIN'); const result = await fn({ id: 'client-1' }); calls.push('COMMIT'); return result; },
    async lookupTaskRequest(taskId, conversationId, client) { calls.push({ op: 'lookupTaskRequest', taskId, conversationId, client }); return taskRequests.get(`${conversationId}:${taskId}`) ?? null; },
    async lookupIdempotency() { return null; },
    async persistAcceptedEnvelope(row) { envelopes.set(row.envelope.message_id, row); return { message_id: row.envelope.message_id, duplicate: false }; },
  };
}

function makeEnvelope({ keys, messageType, body, conversationId = 'conv_1' }) {
  const envelope = {
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: conversationId,
    message_type: messageType, sender: { endpoint_id: 'ep_claude', owner_id: 'usr_claude' }, recipient: { endpoint_id: 'ep_codex', owner_id: 'usr_codex' },
    body, context_refs: [], capabilities: [], correlation_id: null, idempotency_key: `send_${crypto.randomUUID()}`,
    created_at: '2026-08-16T12:00:00Z', expires_at: '2026-08-16T13:00:00Z',
    signature: { algorithm: 'Ed25519', key_id: 'key_claude', value: '' }
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.privateKey).toString('base64url');
  return envelope;
}

test('task.result referencing an unaccepted task_id is rejected with INVALID_ENVELOPE', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'task.result', body: { task_id: 'task_never_sent', status: 'completed', summary: 'x' } });
  const repository = fakeTransactionalRepository();
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'INVALID_ENVELOPE');
  assert.equal(result.body.details.field, 'task_id');
  assert.equal(result.body.details.reason, 'no visible task.request');
});

test('task.result referencing an accepted task_id in the same conversation is accepted', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'task.result', body: { task_id: 'task_1', status: 'completed', summary: 'x' } });
  const repository = fakeTransactionalRepository({ taskRequests: new Map([['conv_1:task_1', { message_id: 'msg_original' }]]) });
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.equal(result.status, 202);
  assert.equal(repository.calls.some((call) => call === 'BEGIN'), true);
  assert.equal(repository.calls.some((call) => call === 'COMMIT'), true);
});

test('non-task envelopes skip the cross-reference lookup entirely', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'chat.message', body: { text: 'hi' } });
  const repository = fakeTransactionalRepository();
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.equal(result.status, 202);
  assert.equal(repository.calls.some((call) => call?.op === 'lookupTaskRequest'), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test sigil/relay/v1/accept-envelope.test.mjs`
Expected: FAIL — `acceptEnvelopeAsync` doesn't yet accept/use a `repository` option this way.

- [ ] **Step 3: Rewrite acceptEnvelopeAsync**

Replace `sigil/relay/v1/accept-envelope.mjs` in full:

```javascript
import { validateEnvelope, reject } from './validate-envelope.mjs';

const statusByCode = Object.freeze({
  INVALID_ENVELOPE: 400,
  VERSION_UNSUPPORTED: 400,
  INVALID_SIGNATURE: 401,
  UNKNOWN_ENDPOINT: 401,
  ENDPOINT_REVOKED: 403,
  ROUTE_NOT_AUTHORIZED: 403,
  CAPABILITY_DENIED: 403,
  APPROVAL_REQUIRED: 403,
  MESSAGE_EXPIRED: 422,
  DUPLICATE_MESSAGE: 409,
  REPLAY_DETECTED: 409,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429
});

function toResponse(options, error) {
  return { status: statusByCode[error.code] ?? 400, body: { request_id: options.request_id ?? null, code: error.code ?? 'INVALID_ENVELOPE', message: error.message, details: error.details ?? {} } };
}

export function acceptEnvelope(envelope, options = {}) {
  try {
    const result = validateEnvelope(envelope, options);
    const existing = options.idempotency?.get(`${envelope.sender.endpoint_id}:${envelope.idempotency_key}`);
    if (existing) return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: existing.message_id, duplicate: true } };
    options.persist?.({ envelope, ...result });
    return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: result.message_id, duplicate: false } };
  } catch (error) {
    return toResponse(options, error);
  }
}

// Repository-backed accept path (design §3): every repository-backed check
// (task cross-reference here; replay/capability/quota join in later
// workstreams) runs inside ONE transaction on ONE client, loaded before
// validateEnvelope runs and persisted in the same transaction that accepted
// it. validateEnvelope itself stays synchronous/pure -- it only ever sees
// already-resolved snapshots, never the client.
async function acceptWithRepository(envelope, options) {
  const { repository, now = new Date() } = options;
  return repository.withTransaction(async (client) => {
    const result = validateEnvelope(envelope, { ...options, idempotency: new Map() });
    const prior = await repository.lookupIdempotency(envelope.sender.endpoint_id, envelope.idempotency_key, client);
    if (prior && prior.canonical_hash !== result.canonical_hash) throw reject('DUPLICATE_MESSAGE', 'Idempotency key conflicts with an existing body');
    if (prior) return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: prior.message_id, duplicate: true } };
    if (envelope.message_type === 'task.result') {
      const visible = await repository.lookupTaskRequest(envelope.body.task_id, envelope.conversation_id, client);
      if (!visible) throw reject('INVALID_ENVELOPE', 'task.result references a task_id with no visible task.request', { field: 'task_id', reason: 'no visible task.request' });
    }
    const persisted = await repository.persistAcceptedEnvelope({ envelope, ...result }, client);
    if (options.onPersisted) await options.onPersisted({ envelope, persisted });
    return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: persisted?.message_id ?? result.message_id, duplicate: persisted?.duplicate ?? false } };
  }).catch((error) => toResponse(options, error));
}

export async function acceptEnvelopeAsync(envelope, options = {}) {
  if (options.repository?.withTransaction) return acceptWithRepository(envelope, options);
  // Legacy / unit-test path: no repository, caller supplies plain
  // lookupIdempotency + persist callbacks (map-backed, no transaction).
  try {
    const result = validateEnvelope(envelope, { ...options, idempotency: new Map() });
    const prior = options.lookupIdempotency
      ? await options.lookupIdempotency(envelope.sender.endpoint_id, envelope.idempotency_key)
      : options.idempotency?.get(`${envelope.sender.endpoint_id}:${envelope.idempotency_key}`);
    if (prior && prior.canonical_hash !== result.canonical_hash) throw reject('DUPLICATE_MESSAGE', 'Idempotency key conflicts with an existing body');
    if (prior) return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: prior.message_id, duplicate: true } };
    const persisted = await options.persist?.({ envelope, ...result });
    return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: persisted?.message_id ?? result.message_id, duplicate: persisted?.duplicate ?? false } };
  } catch (error) {
    return toResponse(options, error);
  }
}
```

Note: `reject` is now exported from `validate-envelope.mjs` already (it was — see line 17 of the original file); this task just imports it into `accept-envelope.mjs` instead of constructing ad hoc `Object.assign(new Error(...), { code })` calls, matching the existing convention exactly.

- [ ] **Step 4: Add lookupTaskRequest to PostgresRepository**

Add to `sigil/relay/v1/postgres-repository.mjs`, inside the `PostgresRepository` class, near `lookupIdempotency`:

```javascript
  async lookupTaskRequest(taskId, conversationId, client = this.pool) {
    const result = await client.query(
      `SELECT message_id FROM envelopes WHERE conversation_id = $1 AND message_type = 'task.request' AND body->>'task_id' = $2 AND envelope_status = 'accepted' LIMIT 1`,
      [conversationId, taskId]
    );
    return result.rows[0] ?? null;
  }
```

Also update `lookupIdempotency` to accept an optional `client` param, defaulting to `this.pool` so both the transactional and non-transactional call sites keep working:

```javascript
  async lookupIdempotency(endpointId, idempotencyKey, client = this.pool) {
    const result = await client.query(
      'SELECT message_id, canonical_hash FROM idempotency_keys WHERE endpoint_id = $1 AND idempotency_key = $2 AND expires_at > NOW()',
      [endpointId, idempotencyKey]
    );
    return result.rows[0] ?? null;
  }
```

And `persistAcceptedEnvelope` needs a client-aware overload for the transactional path: rename the existing body into a helper that takes an explicit client, keep the pool-based wrapper for the standalone caller (`http-server.mjs` still calls it directly, un-transacted, when there's no outer transaction to join):

```javascript
  async persistAcceptedEnvelope(row, client) {
    if (client) return this.#insertAcceptedEnvelope(row, client);
    try {
      return await this.withTransaction((txClient) => this.#insertAcceptedEnvelope(row, txClient));
    } catch (error) {
      if (error.code === '23505') {
        const existing = await this.lookupIdempotency(row.envelope.sender.endpoint_id, row.envelope.idempotency_key);
        if (existing) return { message_id: existing.message_id, duplicate: true };
      }
      throw error;
    }
  }
  async #insertAcceptedEnvelope(row, client) {
    const result = await client.query(
      `INSERT INTO envelopes (message_id, conversation_id, protocol, message_type, sender_endpoint_id, sender_owner_id, recipient_endpoint_id, broadcast_scope, body, context_refs, capabilities, correlation_id, idempotency_key, expires_at, created_at, signature_algorithm, signature_key_id, signature_value, canonical_bytes, action_hash, envelope_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'accepted') RETURNING message_id`,
      [row.envelope.message_id, row.envelope.conversation_id, row.envelope.protocol, row.envelope.message_type, row.envelope.sender.endpoint_id, row.envelope.sender.owner_id, row.envelope.recipient?.endpoint_id ?? null, row.envelope.broadcast_scope ?? null, row.envelope.body, row.envelope.context_refs, row.envelope.capabilities, row.envelope.correlation_id, row.envelope.idempotency_key, row.envelope.expires_at, row.envelope.created_at, row.envelope.signature.algorithm, row.envelope.signature.key_id, row.envelope.signature.value, row.canonical_bytes ?? null, row.action_hash ?? null]
    );
    const deliveryId = row.delivery_id ?? `del_${crypto.randomUUID()}`;
    if (row.envelope.recipient?.endpoint_id) {
      await client.query(
        `INSERT INTO deliveries (delivery_id, message_id, recipient_endpoint_id, state, attempts, queued_at, updated_at, next_attempt_at)
         VALUES ($1,$2,$3,'queued',0,$4,$4,$4)`,
        [deliveryId, row.envelope.message_id, row.envelope.recipient.endpoint_id, row.envelope.created_at]
      );
    }
    await client.query(
      `INSERT INTO idempotency_keys (idempotency_key, endpoint_id, message_id, canonical_hash, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.envelope.idempotency_key, row.envelope.sender.endpoint_id, row.envelope.message_id, row.canonical_hash ?? row.action_hash ?? '', row.envelope.created_at, row.envelope.expires_at]
    );
    await client.query(
      `INSERT INTO audit_events (event_id, event_type, subject_id, actor_id, payload, created_at)
       VALUES ($1, 'envelope.accepted', $2, $3, $4, $5)`,
      [`audit_${crypto.randomUUID()}`, row.envelope.message_id, row.envelope.sender.endpoint_id, JSON.stringify({ recipient_endpoint_id: row.envelope.recipient?.endpoint_id ?? null }), row.envelope.created_at]
    );
    return { message_id: result.rows[0].message_id, duplicate: false };
  }
```

Delete the old `#persistAcceptedEnvelopeTransaction` private method (fully superseded by `#insertAcceptedEnvelope` + the two callers above).

- [ ] **Step 5: Add lookupTaskRequest to memory-repository.mjs**

`sigil/cli/memory-repository.mjs` doesn't yet have `withTransaction` or `lookupIdempotency` at all — add both plus `lookupTaskRequest`, keeping the existing `envelopes`/`deliveries` Maps as the backing store:

```javascript
import { transitionDelivery } from '../relay/v1/delivery-state.mjs';

export function createMemoryRepository() {
  const envelopes = new Map();
  const deliveries = new Map();
  const idempotency = new Map();
  return {
    // Single-process, no real client/connection -- the transaction wrapper
    // exists so acceptEnvelopeAsync's repository-aware path works unchanged
    // against this repository too (design §12 dual-repository equivalence).
    async withTransaction(fn) { return fn(null); },
    async lookupIdempotency(endpointId, idempotencyKey) {
      return idempotency.get(`${endpointId}:${idempotencyKey}`) ?? null;
    },
    async lookupTaskRequest(taskId, conversationId) {
      for (const row of envelopes.values()) {
        if (row.envelope.conversation_id === conversationId && row.envelope.message_type === 'task.request' && row.envelope.body?.task_id === taskId) {
          return { message_id: row.envelope.message_id };
        }
      }
      return null;
    },
    async persistAcceptedEnvelope(row) {
      envelopes.set(row.message_id, row);
      idempotency.set(`${row.envelope.sender.endpoint_id}:${row.envelope.idempotency_key}`, { message_id: row.message_id, canonical_hash: row.canonical_hash });
      if (row.envelope.recipient?.endpoint_id) {
        const deliveryId = `del_${row.message_id}`;
        deliveries.set(deliveryId, {
          delivery_id: deliveryId,
          message_id: row.message_id,
          recipient_endpoint_id: row.envelope.recipient.endpoint_id,
          state: 'delivered',
          queued_at: new Date().toISOString(),
          attempts: 0
        });
      }
      return { message_id: row.message_id, duplicate: false };
    },
    async listInbox(endpointId, since = '') {
      return [...deliveries.values()]
        .filter((d) => d.recipient_endpoint_id === endpointId && d.state === 'delivered' && d.queued_at > since)
        .map((d) => ({ delivery_id: d.delivery_id, message_id: d.message_id, envelope: envelopes.get(d.message_id).envelope, queued_at: d.queued_at }));
    },
    async acknowledgeDelivery({ deliveryId, endpointId, now }) {
      const current = deliveries.get(deliveryId);
      if (!current || current.recipient_endpoint_id !== endpointId) throw Object.assign(new Error('Delivery not found'), { code: 'DELIVERY_UNAVAILABLE' });
      if (current.state === 'acknowledged') return { ...current, duplicate: true };
      const next = transitionDelivery(current, 'acknowledged', { now });
      deliveries.set(deliveryId, next);
      return next;
    },
    async getDelivery(deliveryId, endpointId) {
      const current = deliveries.get(deliveryId);
      return current && current.recipient_endpoint_id === endpointId ? current : null;
    },
    async transitionDelivery(deliveryId, _endpointId, _target, { next }) {
      deliveries.set(deliveryId, next);
      return next;
    }
  };
}
```

(`row.message_id` in the pre-existing `persistAcceptedEnvelope` was actually reading `row.message_id`, not `row.envelope.message_id` — that's the original code's own field name, unchanged here; `acceptWithRepository` passes `{ envelope, ...result }` and `result.message_id` from `validateEnvelope`'s return value, so `row.message_id` was always populated. No behavior change, just added state.)

- [ ] **Step 6: Update http-server.mjs to pass repository through**

In `sigil/relay/v1/http-server.mjs`, the `/v1/envelopes` handler (line 113-119) currently builds its own `persist` callback and passes `lookupIdempotency`/`persist` directly. Replace it to delegate to the new repository-aware path, keeping the stream-notify side effect via `onPersisted`:

```javascript
    if (request.method === 'POST' && request.url === '/v1/envelopes') {
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let envelope; try { envelope = JSON.parse(raw); } catch { response.writeHead(400, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'Invalid JSON', details: {} })); }
      const result = await acceptEnvelopeAsync(envelope, {
        registered: registry, request_id: requestId, now, repository,
        onPersisted: async ({ envelope: accepted, persisted }) => {
          if (stream && accepted.recipient?.endpoint_id && !persisted?.duplicate) stream.notify(accepted.recipient.endpoint_id, persisted.message_id);
        }
      });
      response.writeHead(result.status, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(result.body ? JSON.stringify(result.body) : '');
    }
```

This drops the old `persistAccepted`/`resolveIdempotency` local wrapper functions at lines 30-34 (no longer needed — `acceptEnvelopeAsync` now talks to `repository` directly); remove those two `const` declarations from `createRelayServer`'s body.

- [ ] **Step 7: Run full suite**

Run: `node --test sigil/relay/v1/accept-envelope.test.mjs sigil/relay/v1/postgres-repository.test.mjs sigil/cli/memory-repository.test.mjs sigil/relay/v1/http-server.test.mjs sigil/integration/vertical-slice.test.mjs`
Expected: PASS. `vertical-slice.test.mjs` still uses the synchronous `acceptEnvelope` (not `Async`), which is untouched, so it should pass with no edits.

- [ ] **Step 8: Commit**

```bash
git add sigil/relay/v1/accept-envelope.mjs sigil/relay/v1/accept-envelope.test.mjs sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/postgres-repository.test.mjs sigil/cli/memory-repository.mjs sigil/cli/memory-repository.test.mjs sigil/relay/v1/http-server.mjs
git commit -m "feat(infra,F): transactional accept pipeline + task.result cross-reference check"
```

---

## Task 7: B1 — Scoped message-lookup index + lookupAcceptedMessageId

**Files:**
- Create: `sigil/migrations/005_message_lookup_index.sql`
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Modify: `sigil/relay/v1/postgres-repository.test.mjs`
- Modify: `sigil/cli/memory-repository.mjs`

**Interfaces:**
- Produces: `repository.lookupAcceptedMessageId(senderEndpointId, messageId, client): Promise<{message_id, idempotency_key} | null>` — consumed by Task 8.

- [ ] **Step 1: Note on uniqueness (no new constraint needed)**

`envelopes.message_id` is already `PRIMARY KEY` (`001_initial.sql:63`) — globally unique in the DB already, which trivially implies `(sender_endpoint_id, message_id)` uniqueness too. Design §3's "additionally enforced as a database unique constraint on (sender_endpoint_id, message_id)" is already satisfied by the existing PK; this task adds only a composite index for the *scoped lookup's* performance and to make the scoping explicit in the schema, not a new uniqueness guarantee.

- [ ] **Step 2: Write the migration**

```sql
-- sigil/migrations/005_message_lookup_index.sql
-- Composite index for the scoped (sender_endpoint_id, message_id) replay
-- lookup (design §6 blocker 3). Uniqueness is already guaranteed by
-- envelopes.message_id PRIMARY KEY (001_initial.sql); this index exists so
-- lookupAcceptedMessageId's WHERE clause -- scoped to both columns, never a
-- bare message_id lookup -- doesn't fall back to a full PK-only scan plan
-- that ignores the endpoint filter.
CREATE INDEX IF NOT EXISTS envelopes_sender_message_idx ON envelopes(sender_endpoint_id, message_id);
```

- [ ] **Step 3: Write failing tests**

Add to `sigil/relay/v1/postgres-repository.test.mjs`:

```javascript
test('lookupAcceptedMessageId is scoped to (sender_endpoint_id, message_id), never a bare message_id lookup', async () => {
  const pool = fakePool();
  const repository = new PostgresRepository({ pool });
  await repository.lookupAcceptedMessageId('ep_codex', 'msg_1');
  const query = pool.calls.find((call) => call.text?.includes('SELECT'));
  assert.match(query.text, /sender_endpoint_id\s*=\s*\$1/);
  assert.match(query.text, /message_id\s*=\s*\$2/);
  assert.deepEqual(query.values, ['ep_codex', 'msg_1']);
});
```

(Extend the existing `fakePool` helper in that test file if its default `query` doesn't already return `{ rows: [{ message_id: values?.[0] }] }` for a `SELECT` — it does, per the file's current top-of-file helper, so no change needed there.)

- [ ] **Step 4: Run to verify failure**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: FAIL — `lookupAcceptedMessageId is not a function`.

- [ ] **Step 5: Implement lookupAcceptedMessageId**

Add to `PostgresRepository` in `sigil/relay/v1/postgres-repository.mjs`, near `lookupTaskRequest`:

```javascript
  async lookupAcceptedMessageId(senderEndpointId, messageId, client = this.pool) {
    const result = await client.query(
      'SELECT message_id, idempotency_key FROM envelopes WHERE sender_endpoint_id = $1 AND message_id = $2 AND envelope_status = $3',
      [senderEndpointId, messageId, 'accepted']
    );
    return result.rows[0] ?? null;
  }
```

- [ ] **Step 6: Add the memory-repository equivalent**

Add to `createMemoryRepository()` in `sigil/cli/memory-repository.mjs`:

```javascript
    async lookupAcceptedMessageId(senderEndpointId, messageId) {
      for (const row of envelopes.values()) {
        if (row.envelope.sender.endpoint_id === senderEndpointId && row.envelope.message_id === messageId) {
          return { message_id: row.envelope.message_id, idempotency_key: row.envelope.idempotency_key };
        }
      }
      return null;
    },
```

- [ ] **Step 7: Run to verify passing**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add sigil/migrations/005_message_lookup_index.sql sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/postgres-repository.test.mjs sigil/cli/memory-repository.mjs
git commit -m "feat(B): add scoped message-lookup index + lookupAcceptedMessageId"
```

---

## Task 8: B2 — Four-outcome replay classification

**Files:**
- Modify: `sigil/relay/v1/accept-envelope.mjs`
- Modify: `sigil/relay/v1/accept-envelope.test.mjs`
- Modify: `sigil/integration/vertical-slice.test.mjs`

**Interfaces:**
- Consumes: `repository.lookupAcceptedMessageId` (Task 7).

- [ ] **Step 1: Write the failing tests**

Add to `sigil/relay/v1/accept-envelope.test.mjs` (reusing `fakeTransactionalRepository`/`makeEnvelope` from Task 6 — extend `fakeTransactionalRepository` to accept a `messageIds` map and implement `lookupAcceptedMessageId`):

```javascript
function fakeTransactionalRepositoryWithMessages({ messageIds = new Map(), envelopes = new Map() } = {}) {
  const base = fakeTransactionalRepository({ envelopes });
  return {
    ...base,
    async lookupAcceptedMessageId(senderEndpointId, messageId) { return messageIds.get(`${senderEndpointId}:${messageId}`) ?? null; },
  };
}

test('replay: same message_id previously accepted, resubmitted under a different idempotency_key -> REPLAY_DETECTED', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'chat.message', body: { text: 'hi' } });
  const repository = fakeTransactionalRepositoryWithMessages({ messageIds: new Map([[`ep_claude:${envelope.message_id}`, { message_id: envelope.message_id, idempotency_key: 'a-different-key' }]]) });
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'REPLAY_DETECTED');
});

test('replay: same message_id + same idempotency_key is an ordinary duplicate, not a replay', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'chat.message', body: { text: 'hi' } });
  const repository = fakeTransactionalRepositoryWithMessages({ messageIds: new Map([[`ep_claude:${envelope.message_id}`, { message_id: envelope.message_id, idempotency_key: envelope.idempotency_key }]]) });
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  // Same idempotency_key -> falls through to the existing lookupIdempotency
  // duplicate path (not exercised by this fake's lookupIdempotency, which
  // returns null) -- the key assertion here is that it is NOT REPLAY_DETECTED.
  assert.notEqual(result.body.code, 'REPLAY_DETECTED');
});

test('first-time expired message with no prior accepted record -> MESSAGE_EXPIRED, not REPLAY_DETECTED', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'chat.message', body: { text: 'hi' } });
  envelope.created_at = '2026-08-16T00:00:00Z';
  envelope.expires_at = '2026-08-16T01:00:00Z';
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.privateKey).toString('base64url');
  const repository = fakeTransactionalRepositoryWithMessages();
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:00:00Z') });
  assert.equal(result.status, 422);
  assert.equal(result.body.code, 'MESSAGE_EXPIRED');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test sigil/relay/v1/accept-envelope.test.mjs`
Expected: FAIL — the replay lookup isn't wired in yet, so the first test gets 202 instead of 409.

- [ ] **Step 3: Wire the replay check into acceptWithRepository**

In `sigil/relay/v1/accept-envelope.mjs`, `acceptWithRepository` (from Task 6), add the replay check as the *first* repository-backed check inside the transaction — before the idempotency-duplicate check and before `validateEnvelope`'s own expiry check can run, per design §6 ("the scoped lookup happens first ... before the expiry check"). Since `validateEnvelope` itself performs the expiry check internally and can't be reordered around from the outside, split the flow: run the replay lookup first, and only call `validateEnvelope` (which does expiry/signature/etc.) if the replay check doesn't already classify this as `REPLAY_DETECTED`:

```javascript
async function acceptWithRepository(envelope, options) {
  const { repository, now = new Date() } = options;
  return repository.withTransaction(async (client) => {
    const priorMessage = await repository.lookupAcceptedMessageId(envelope.sender.endpoint_id, envelope.message_id, client);
    if (priorMessage && priorMessage.idempotency_key !== envelope.idempotency_key) {
      throw reject('REPLAY_DETECTED', 'message_id was already accepted under a different idempotency_key');
    }
    const result = validateEnvelope(envelope, { ...options, idempotency: new Map() });
    const prior = await repository.lookupIdempotency(envelope.sender.endpoint_id, envelope.idempotency_key, client);
    if (prior && prior.canonical_hash !== result.canonical_hash) throw reject('DUPLICATE_MESSAGE', 'Idempotency key conflicts with an existing body');
    if (prior) return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: prior.message_id, duplicate: true } };
    if (envelope.message_type === 'task.result') {
      const visible = await repository.lookupTaskRequest(envelope.body.task_id, envelope.conversation_id, client);
      if (!visible) throw reject('INVALID_ENVELOPE', 'task.result references a task_id with no visible task.request', { field: 'task_id', reason: 'no visible task.request' });
    }
    const persisted = await repository.persistAcceptedEnvelope({ envelope, ...result }, client);
    if (options.onPersisted) await options.onPersisted({ envelope, persisted });
    return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: persisted?.message_id ?? result.message_id, duplicate: persisted?.duplicate ?? false } };
  }).catch((error) => toResponse(options, error));
}
```

This gives exactly the four outcomes design §6 specifies, checked in order: (1) replay lookup finds a prior record with a *different* key → `REPLAY_DETECTED` immediately, skipping expiry entirely; (2) no prior record + `validateEnvelope` finds `expires_at <= now` → `MESSAGE_EXPIRED` (existing, untouched logic inside `validateEnvelope`); (3) prior idempotency-key match with same hash → duplicate, 202; (4) prior idempotency-key match with different hash → `DUPLICATE_MESSAGE`.

- [ ] **Step 4: Run to verify passing**

Run: `node --test sigil/relay/v1/accept-envelope.test.mjs`
Expected: PASS

- [ ] **Step 5: Add the vertical-slice integration scenario**

Add to `sigil/integration/vertical-slice.test.mjs` (new `test(...)` block, reusing the file's existing `codexKeys`/`registry`/`template` setup pattern but via `acceptEnvelopeAsync` against a `createMemoryRepository()` instance so it exercises the real repository, not a fake):

```javascript
test('replay of an already-accepted message under a new idempotency_key is rejected (§18 #13)', async () => {
  const { acceptEnvelopeAsync } = await import('../relay/v1/accept-envelope.mjs');
  const { createMemoryRepository } = await import('../cli/memory-repository.mjs');
  const keys = crypto.generateKeyPairSync('ed25519');
  const sender = { owner_id: 'usr_replay', endpoint_id: 'ep_replay', key_id: 'key_replay', kind: 'agent' };
  const registered = new Map([['ep_replay', { ...sender, status: 'active', public_key: keys.publicKey }]]);
  const repository = createMemoryRepository();
  const template = JSON.parse(fs.readFileSync(new URL('../contracts/v1/envelope.example.json', import.meta.url)));
  const envelope = { ...template, message_id: 'msg_replay_1', conversation_id: 'conv_replay', sender, recipient: sender, message_type: 'chat.message', body: { text: 'hi' }, created_at: '2026-08-16T12:00:00Z', expires_at: '2026-08-16T13:00:00Z' };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.privateKey).toString('base64url');
  const first = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:00:30Z') });
  assert.equal(first.status, 202);
  const replayed = { ...envelope, idempotency_key: 'a-different-idempotency-key' };
  replayed.signature.value = crypto.sign(null, signedBytes(replayed), keys.privateKey).toString('base64url');
  const second = await acceptEnvelopeAsync(replayed, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'REPLAY_DETECTED');
});
```

- [ ] **Step 6: Run the full suite**

Run: `node --test sigil/relay/v1/accept-envelope.test.mjs sigil/integration/vertical-slice.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add sigil/relay/v1/accept-envelope.mjs sigil/relay/v1/accept-envelope.test.mjs sigil/integration/vertical-slice.test.mjs
git commit -m "feat(B): four-outcome replay classification (§18 #13)"
```

---

## Task 9: A1 — Capability registry (fail-closed)

**Files:**
- Create: `sigil/migrations/006_capability_registry.sql`
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Modify: `sigil/relay/v1/postgres-repository.test.mjs`
- Modify: `sigil/cli/memory-repository.mjs`

**Interfaces:**
- Produces: `repository.lookupCapabilityRegistration(capability, client): Promise<{capability, namespace} | null>` — consumed by Task 12 (A3).

- [ ] **Step 1: Write the migration**

Seed set matches the capability names already used by `sigil/connectors/v1/capability-policy.mjs`'s `OPERATION_CAPABILITIES` map (`sigil.task/submit`, `sigil.task/read_inbox`, `sigil.task/read_result`, `sigil.approval/request`, `sigil.core/read_shared_context`, `sigil.task/process`, `sigil.task/submit_result`) plus `sigil.core/broadcast_message` (the broadcast capability design §7 names explicitly):

```sql
-- sigil/migrations/006_capability_registry.sql
-- Fail-closed capability registry (design §7): a capability not found here
-- is rejected with CAPABILITY_DENIED before scope matching runs at all,
-- regardless of whether its name looks sigil.core/*-shaped.
CREATE TABLE IF NOT EXISTS capability_registry (
  capability TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  risk_tier TEXT NOT NULL CHECK (risk_tier IN ('low', 'standard', 'high')),
  registered_by TEXT,
  registered_at TIMESTAMPTZ NOT NULL
);

INSERT INTO capability_registry (capability, namespace, risk_tier, registered_by, registered_at) VALUES
  ('sigil.core/read_shared_context', 'sigil.core', 'standard', 'system', NOW()),
  ('sigil.core/broadcast_message', 'sigil.core', 'standard', 'system', NOW()),
  ('sigil.task/submit', 'sigil.task', 'standard', 'system', NOW()),
  ('sigil.task/read_inbox', 'sigil.task', 'low', 'system', NOW()),
  ('sigil.task/read_result', 'sigil.task', 'low', 'system', NOW()),
  ('sigil.task/process', 'sigil.task', 'standard', 'system', NOW()),
  ('sigil.task/submit_result', 'sigil.task', 'standard', 'system', NOW()),
  ('sigil.approval/request', 'sigil.approval', 'high', 'system', NOW())
ON CONFLICT (capability) DO NOTHING;
```

- [ ] **Step 2: Write failing tests**

Add to `sigil/relay/v1/postgres-repository.test.mjs`:

```javascript
test('lookupCapabilityRegistration returns the registered row for a known capability', async () => {
  const pool = fakePool();
  const repository = new PostgresRepository({ pool });
  const registration = await repository.lookupCapabilityRegistration('sigil.task/submit');
  assert.ok(registration);
});

test('lookupCapabilityRegistration returns null for an unregistered capability', async () => {
  const pool = { calls: [], async connect() { throw new Error('should not open a transaction for a plain lookup'); }, async query(text, values) { this.calls.push({ text, values }); return { rows: [] }; } };
  const repository = new PostgresRepository({ pool });
  const registration = await repository.lookupCapabilityRegistration('made.up/capability');
  assert.equal(registration, null);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: FAIL

- [ ] **Step 4: Implement lookupCapabilityRegistration**

Add to `PostgresRepository`:

```javascript
  async lookupCapabilityRegistration(capability, client = this.pool) {
    const result = await client.query('SELECT capability, namespace, risk_tier FROM capability_registry WHERE capability = $1', [capability]);
    return result.rows[0] ?? null;
  }
```

- [ ] **Step 5: Add the memory-repository equivalent**

`memory-repository.mjs` seeds the same fixed set in-process (no DB, no migration to run for local `sigil relay up`):

```javascript
const SEEDED_CAPABILITIES = new Set([
  'sigil.core/read_shared_context', 'sigil.core/broadcast_message',
  'sigil.task/submit', 'sigil.task/read_inbox', 'sigil.task/read_result', 'sigil.task/process', 'sigil.task/submit_result',
  'sigil.approval/request'
]);
```

Add near the top of `sigil/cli/memory-repository.mjs` (module scope, alongside the imports) and add to the returned object:

```javascript
    async lookupCapabilityRegistration(capability) {
      return SEEDED_CAPABILITIES.has(capability) ? { capability, namespace: capability.split('/')[0], risk_tier: 'standard' } : null;
    },
```

- [ ] **Step 6: Run to verify passing**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add sigil/migrations/006_capability_registry.sql sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/postgres-repository.test.mjs sigil/cli/memory-repository.mjs
git commit -m "feat(A): capability registry, fail-closed for unregistered capabilities"
```

---

## Task 10: A2 — Shared ancestor-scope matcher

**Files:**
- Create: `sigil/relay/v1/scope.mjs`
- Create: `sigil/relay/v1/scope.test.mjs`
- Modify: `sigil/connectors/v1/context-resolver.mjs:9-13`
- Modify: `sigil/connectors/v1/context-resolver.test.mjs`

**Interfaces:**
- Produces: `isAncestorScope(grantScope, targetScope): boolean` — consumed by Task 12 (A3) and by `context-resolver.mjs`'s existing `scopeCovers` call sites (renamed, not duplicated).

- [ ] **Step 1: Write failing tests**

```javascript
// sigil/relay/v1/scope.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAncestorScope } from './scope.mjs';

test('a scope is its own ancestor', () => {
  assert.equal(isAncestorScope('scope:project/proj_123', 'scope:project/proj_123'), true);
});

test('a parent scope is an ancestor of its child', () => {
  assert.equal(isAncestorScope('scope:project/proj_123', 'scope:project/proj_123/thread/thread_456'), true);
});

test('segment-exact matching rejects a string-prefix false positive', () => {
  // scope:project/proj_123 must NOT match scope:project/proj_1234 --
  // segments must match exactly, not as string prefixes (design §7).
  assert.equal(isAncestorScope('scope:project/proj_123', 'scope:project/proj_1234'), false);
});

test('a child scope is not an ancestor of its parent', () => {
  assert.equal(isAncestorScope('scope:project/proj_123/thread/thread_456', 'scope:project/proj_123'), false);
});

test('unrelated scopes are not ancestors', () => {
  assert.equal(isAncestorScope('scope:project/proj_123', 'scope:project/proj_999'), false);
});

test('rejects non-string inputs', () => {
  assert.equal(isAncestorScope(null, 'scope:project/proj_123'), false);
  assert.equal(isAncestorScope('scope:project/proj_123', undefined), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test sigil/relay/v1/scope.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement scope.mjs**

```javascript
// sigil/relay/v1/scope.mjs
// Shared segment-exact ancestor-scope matcher (design §7), used by
// capability target-scope checks here and by context-resolver.mjs's
// context-grant scope check -- previously two near-identical
// implementations (relay-side didn't exist; connector-side was
// context-resolver.mjs's local scopeCovers), now one.
export function isAncestorScope(grantScope, targetScope) {
  if (typeof grantScope !== 'string' || typeof targetScope !== 'string') return false;
  const grant = grantScope.split('/');
  const target = targetScope.split('/');
  return grant.length <= target.length && grant.every((part, index) => part === target[index]);
}
```

- [ ] **Step 4: Run to verify passing**

Run: `node --test sigil/relay/v1/scope.test.mjs`
Expected: PASS

- [ ] **Step 5: Dedupe context-resolver.mjs onto the shared helper**

In `sigil/connectors/v1/context-resolver.mjs`, replace the local `scopeCovers` (lines 9-13) with an import and a re-export for existing callers (the module currently exports `scopeCovers` and `resolveContext`; `resolveContext`'s internal `grantAllows` also calls it):

```javascript
import { isAncestorScope } from '../../relay/v1/scope.mjs';

export const scopeCovers = isAncestorScope;
```

Delete the old function body (lines 9-13); everything else in the file (`grantAllows`, `resolveContext`, etc.) already calls `scopeCovers(...)`, so no other call sites change.

- [ ] **Step 6: Run context-resolver tests**

Run: `node --test sigil/connectors/v1/context-resolver.test.mjs`
Expected: PASS unchanged — `scopeCovers`'s exported behavior is identical (`isAncestorScope` is a straight extraction, same logic).

- [ ] **Step 7: Commit**

```bash
git add sigil/relay/v1/scope.mjs sigil/relay/v1/scope.test.mjs sigil/connectors/v1/context-resolver.mjs
git commit -m "refactor(A): extract shared isAncestorScope helper, dedupe context-resolver.mjs"
```

---

## Task 11: A3 — Target-scope derivation + capability enforcement at accept

**Files:**
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Modify: `sigil/cli/memory-repository.mjs`
- Modify: `sigil/relay/v1/validate-envelope.mjs`
- Modify: `sigil/relay/v1/validate-envelope.test.mjs`
- Modify: `sigil/relay/v1/accept-envelope.mjs`
- Modify: `sigil/relay/v1/accept-envelope.test.mjs`

**Interfaces:**
- Consumes: `isAncestorScope` (Task 10), `lookupCapabilityRegistration` (Task 9).
- Produces: `repository.lookupActiveCapabilityGrants(endpointId, now, client): Promise<Array<{capability, scope}>>`. `validateEnvelope` gains a `capabilityGrants` option (array); throws `CAPABILITY_DENIED` for any requested capability without covering grant coverage.

- [ ] **Step 1: Write failing lookupActiveCapabilityGrants tests**

Add to `sigil/relay/v1/postgres-repository.test.mjs`:

```javascript
test('lookupActiveCapabilityGrants row-locks the grants it returns', async () => {
  const pool = fakePool();
  const repository = new PostgresRepository({ pool });
  await repository.withTransaction((client) => repository.lookupActiveCapabilityGrants('ep_codex', new Date('2026-08-16T00:00:00Z'), client));
  const query = pool.calls.find((call) => call.text?.includes('SELECT'));
  assert.match(query.text, /FOR UPDATE/);
  assert.match(query.text, /granted_to\s*=\s*\$1/);
  assert.match(query.text, /revoked_at IS NULL/);
  assert.match(query.text, /expires_at\s*>\s*\$2/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement lookupActiveCapabilityGrants**

Add to `PostgresRepository`:

```javascript
  async lookupActiveCapabilityGrants(endpointId, now, client) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const result = await client.query(
      'SELECT capability, scope FROM capability_grants WHERE granted_to = $1 AND expires_at > $2 AND revoked_at IS NULL FOR UPDATE',
      [endpointId, timestamp]
    );
    return result.rows;
  }
```

(No `client = this.pool` default here, unlike the other lookups — design §3 requires this one to always run on the transaction's client since it takes a row lock; a lock taken on a throwaway pool connection outside the transaction would be meaningless and immediately released.)

- [ ] **Step 4: Add the memory-repository equivalent**

`memory-repository.mjs` needs a grants store. Add a `grants` array to `createMemoryRepository()`'s closure state and a matching lookup (no real row locking possible/needed in a single-process in-memory store — the transaction is a no-op there already per Task 6):

```javascript
  const grants = [];
```

(add alongside `envelopes`, `deliveries`, `idempotency`), and add to the returned object:

```javascript
    async lookupActiveCapabilityGrants(endpointId, now) {
      const timestamp = (now instanceof Date ? now : new Date(now)).getTime();
      return grants.filter((g) => g.granted_to === endpointId && !g.revoked_at && new Date(g.expires_at).getTime() > timestamp).map((g) => ({ capability: g.capability, scope: g.scope }));
    },
    async createCapabilityGrant({ grantId, capability, scope, grantedTo, expiresAt, now = new Date() }) {
      const grant = { grant_id: grantId, capability, scope, granted_to: grantedTo, expires_at: expiresAt, revoked_at: null, granted_at: (now instanceof Date ? now : new Date(now)).toISOString() };
      grants.push(grant);
      return grant;
    },
    async revokeCapabilityGrant(grantId, { now = new Date() } = {}) {
      const grant = grants.find((g) => g.grant_id === grantId);
      if (!grant) throw Object.assign(new Error('Capability grant not found'), { code: 'GRANT_UNAVAILABLE' });
      if (grant.revoked_at) return { ...grant, duplicate: true };
      grant.revoked_at = (now instanceof Date ? now : new Date(now)).toISOString();
      return { ...grant, duplicate: false };
    },
```

(This gives `memory-repository.mjs` grant create/revoke for the first time — needed so Task 12's revocation-sequence test and `sigil relay up`'s local dev path can exercise capability enforcement at all; `PostgresRepository.createCapabilityGrant`/`revokeCapabilityGrant` already existed before this plan.)

- [ ] **Step 5: Run to verify passing**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: PASS

- [ ] **Step 6: Write failing validateEnvelope capability tests**

Add to `sigil/relay/v1/validate-envelope.test.mjs`:

```javascript
test('rejects a capability with no covering grant', () => {
  const candidate = structuredClone(base);
  candidate.capabilities = ['sigil.task/submit'];
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  assert.throws(() => validateEnvelope(candidate, { ...options, capabilityGrants: [] }), (error) => error.code === 'CAPABILITY_DENIED');
});

test('accepts a capability covered by an ancestor-scope grant on the conversation', () => {
  const candidate = structuredClone(base);
  candidate.capabilities = ['sigil.task/submit'];
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  const grants = [{ capability: 'sigil.task/submit', scope: `scope:conversation/${candidate.conversation_id}` }];
  assert.equal(validateEnvelope(candidate, { ...options, capabilityGrants: grants }).accepted, true);
});

test('read_shared_context requires coverage for every referenced context scope', () => {
  const candidate = structuredClone(base);
  candidate.capabilities = ['sigil.core/read_shared_context'];
  candidate.context_refs = [{ ref_id: 'ctx_1', scope: 'scope:project/proj_1' }, { ref_id: 'ctx_2', scope: 'scope:project/proj_2' }];
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  const partialGrants = [{ capability: 'sigil.core/read_shared_context', scope: 'scope:project/proj_1' }];
  assert.throws(() => validateEnvelope(candidate, { ...options, capabilityGrants: partialGrants }), (error) => error.code === 'CAPABILITY_DENIED');
  const fullGrants = [{ capability: 'sigil.core/read_shared_context', scope: 'scope:project' }];
  assert.equal(validateEnvelope(candidate, { ...options, capabilityGrants: fullGrants }).accepted, true);
});
```

- [ ] **Step 7: Run to verify failure**

Run: `node --test sigil/relay/v1/validate-envelope.test.mjs`
Expected: FAIL — capability grants aren't checked yet.

- [ ] **Step 8: Wire capability enforcement into validateEnvelope**

Add the import at the top of `sigil/relay/v1/validate-envelope.mjs`:

```javascript
import { isAncestorScope } from './scope.mjs';
```

Add a target-scope-derivation helper and the enforcement block, inserted right after the task-schema checks added in Task 4 (i.e. after the `if (envelope.message_type === 'task.result') validateTaskResultBody(...)` line):

```javascript
function targetScopesFor(capability, envelope) {
  if (capability === 'sigil.core/read_shared_context') {
    return envelope.context_refs.map((ref) => ref.scope).filter(Boolean);
  }
  return [`scope:conversation/${envelope.conversation_id}`];
}

function capabilityIsCovered(capability, envelope, grants) {
  const targets = targetScopesFor(capability, envelope);
  if (!targets.length) return false;
  return targets.every((target) => grants.some((grant) => grant.capability === capability && isAncestorScope(grant.scope, target)));
}
```

(module scope, above `validateEnvelope`), then inside `validateEnvelope`, after the task-schema checks:

```javascript
  const capabilityGrants = Array.isArray(capabilityGrants_) ? capabilityGrants_ : [];
  for (const capability of envelope.capabilities) {
    if (!capabilityIsCovered(capability, envelope, capabilityGrants)) throw reject('CAPABILITY_DENIED', `No active grant covers capability: ${capability}`, { capability });
  }
```

Update `validateEnvelope`'s destructured options signature (currently `{ now = new Date(), registered = new Map(), idempotency = new Map(), broadcastAuthorizer, requiresApproval, approvedActionHashes = new Set() }`) to add `capabilityGrants: capabilityGrants_ = []`:

```javascript
export function validateEnvelope(envelope, { now = new Date(), registered = new Map(), idempotency = new Map(), broadcastAuthorizer, requiresApproval, approvedActionHashes = new Set(), capabilityGrants: capabilityGrants_ = [] } = {}) {
```

(Renaming the destructured param to `capabilityGrants_` and reassigning to `capabilityGrants` inside the function avoids shadowing collisions with the module-level helper's own `grants` parameter naming — keep this exact rename, it's intentional, not a typo.)

- [ ] **Step 9: Run to verify passing**

Run: `node --test sigil/relay/v1/validate-envelope.test.mjs`
Expected: PASS

- [ ] **Step 10: Wire registry fail-closed check + grant snapshot loading into acceptWithRepository**

In `sigil/relay/v1/accept-envelope.mjs`, `acceptWithRepository` (from Task 8), add the registry check and grant-snapshot load before calling `validateEnvelope`:

```javascript
async function acceptWithRepository(envelope, options) {
  const { repository, now = new Date() } = options;
  return repository.withTransaction(async (client) => {
    const priorMessage = await repository.lookupAcceptedMessageId(envelope.sender.endpoint_id, envelope.message_id, client);
    if (priorMessage && priorMessage.idempotency_key !== envelope.idempotency_key) {
      throw reject('REPLAY_DETECTED', 'message_id was already accepted under a different idempotency_key');
    }
    for (const capability of envelope.capabilities ?? []) {
      const registered_ = await repository.lookupCapabilityRegistration(capability, client);
      if (!registered_) throw reject('CAPABILITY_DENIED', `Capability is not registered: ${capability}`, { capability });
    }
    const capabilityGrants = await repository.lookupActiveCapabilityGrants(envelope.sender.endpoint_id, now, client);
    const result = validateEnvelope(envelope, { ...options, idempotency: new Map(), capabilityGrants });
    const prior = await repository.lookupIdempotency(envelope.sender.endpoint_id, envelope.idempotency_key, client);
    if (prior && prior.canonical_hash !== result.canonical_hash) throw reject('DUPLICATE_MESSAGE', 'Idempotency key conflicts with an existing body');
    if (prior) return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: prior.message_id, duplicate: true } };
    if (envelope.message_type === 'task.result') {
      const visible = await repository.lookupTaskRequest(envelope.body.task_id, envelope.conversation_id, client);
      if (!visible) throw reject('INVALID_ENVELOPE', 'task.result references a task_id with no visible task.request', { field: 'task_id', reason: 'no visible task.request' });
    }
    const persisted = await repository.persistAcceptedEnvelope({ envelope, ...result }, client);
    if (options.onPersisted) await options.onPersisted({ envelope, persisted });
    return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: persisted?.message_id ?? result.message_id, duplicate: persisted?.duplicate ?? false } };
  }).catch((error) => toResponse(options, error));
}
```

(Registry check runs before target-scope derivation, per design §7: "A capability not found in the registry is rejected outright ... before scope matching — it does NOT fall through to the conversation-scope default.")

- [ ] **Step 11: Run the full accept-envelope suite**

Run: `node --test sigil/relay/v1/accept-envelope.test.mjs sigil/relay/v1/validate-envelope.test.mjs`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/postgres-repository.test.mjs sigil/cli/memory-repository.mjs sigil/relay/v1/validate-envelope.mjs sigil/relay/v1/validate-envelope.test.mjs sigil/relay/v1/accept-envelope.mjs sigil/relay/v1/accept-envelope.test.mjs
git commit -m "feat(A): target-scope derivation + capability enforcement at accept (§18 #8)"
```

---

## Task 12: A4 — Revocation-sequence proof (§18 #10)

**Files:**
- Modify: `sigil/integration/vertical-slice.test.mjs`

**Interfaces:**
- Consumes: `createCapabilityGrant`/`revokeCapabilityGrant` (Task 11), `acceptEnvelopeAsync` capability enforcement (Task 11).

- [ ] **Step 1: Write the failing sequence test**

Add to `sigil/integration/vertical-slice.test.mjs`:

```javascript
test('grant -> send succeeds -> revoke -> resend denied (§18 #10)', async () => {
  const { acceptEnvelopeAsync } = await import('../relay/v1/accept-envelope.mjs');
  const { createMemoryRepository } = await import('../cli/memory-repository.mjs');
  const keys = crypto.generateKeyPairSync('ed25519');
  const sender = { owner_id: 'usr_revoke', endpoint_id: 'ep_revoke', key_id: 'key_revoke', kind: 'agent' };
  const registered = new Map([['ep_revoke', { ...sender, status: 'active', public_key: keys.publicKey }]]);
  const repository = createMemoryRepository();
  const template = JSON.parse(fs.readFileSync(new URL('../contracts/v1/envelope.example.json', import.meta.url)));
  const conversationId = 'conv_revoke';
  const grant = await repository.createCapabilityGrant({ grantId: 'grant_1', capability: 'sigil.task/submit', scope: `scope:conversation/${conversationId}`, grantedTo: 'ep_revoke', expiresAt: '2026-08-17T00:00:00Z', now: new Date('2026-08-16T12:00:00Z') });
  const envelope1 = { ...template, message_id: 'msg_revoke_1', conversation_id: conversationId, sender, recipient: sender, capabilities: ['sigil.task/submit'], body: { task_id: 'task_r1', instruction: 'x' }, created_at: '2026-08-16T12:00:00Z', expires_at: '2026-08-16T13:00:00Z' };
  envelope1.signature.value = crypto.sign(null, signedBytes(envelope1), keys.privateKey).toString('base64url');
  const first = await acceptEnvelopeAsync(envelope1, { registered, repository, now: new Date('2026-08-16T12:00:30Z') });
  assert.equal(first.status, 202);

  await repository.revokeCapabilityGrant(grant.grant_id, { now: new Date('2026-08-16T12:01:00Z') });

  const envelope2 = { ...template, message_id: 'msg_revoke_2', conversation_id: conversationId, sender, recipient: sender, capabilities: ['sigil.task/submit'], idempotency_key: 'send_revoke_2', body: { task_id: 'task_r2', instruction: 'y' }, created_at: '2026-08-16T12:02:00Z', expires_at: '2026-08-16T13:02:00Z' };
  envelope2.signature.value = crypto.sign(null, signedBytes(envelope2), keys.privateKey).toString('base64url');
  const second = await acceptEnvelopeAsync(envelope2, { registered, repository, now: new Date('2026-08-16T12:02:30Z') });
  assert.equal(second.status, 403);
  assert.equal(second.body.code, 'CAPABILITY_DENIED');
});
```

- [ ] **Step 2: Run to verify passing**

Run: `node --test sigil/integration/vertical-slice.test.mjs`
Expected: PASS — this exercises Task 11's real, already-implemented behavior end-to-end; if it fails, the bug is in Task 11's wiring (grant snapshot loaded fresh per transaction, so a revoked grant is absent from the very next transaction by construction, per design §7).

- [ ] **Step 3: Commit**

```bash
git add sigil/integration/vertical-slice.test.mjs
git commit -m "test(A): prove grant->send->revoke->resend-denied sequence (§18 #10)"
```

---

## Task 13: C1 — Rate-limit config + endpoint/owner/conversation reservation

**Files:**
- Create: `sigil/relay/v1/relay-config.mjs`
- Create: `sigil/relay/v1/relay-config.test.mjs`
- Create: `sigil/migrations/007_rate_quota.sql`
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Modify: `sigil/relay/v1/postgres-repository.test.mjs`
- Modify: `sigil/cli/memory-repository.mjs`
- Modify: `sigil/relay/v1/accept-envelope.mjs`
- Modify: `sigil/relay/v1/accept-envelope.test.mjs`

**Interfaces:**
- Produces: `DEFAULT_RATE_LIMITS = { endpoint: 100, owner: 500, conversation: 200 }` (per-minute), from `relay-config.mjs` — consumed here and documented as overridable. `repository.reserveRateLimit(scopeKind, scopeId, windowStart, limit, client): Promise<{count, allowed}>`.

- [ ] **Step 1: Write failing relay-config tests**

```javascript
// sigil/relay/v1/relay-config.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RATE_LIMITS, DEFAULT_INBOX_DEPTH_LIMIT, resolveRateLimits } from './relay-config.mjs';

test('default rate limits match the approved §13 defaults', () => {
  assert.deepEqual(DEFAULT_RATE_LIMITS, { endpoint: 100, owner: 500, conversation: 200 });
  assert.equal(DEFAULT_INBOX_DEPTH_LIMIT, 500);
});

test('resolveRateLimits overrides only the scopes provided, keeping defaults for the rest', () => {
  assert.deepEqual(resolveRateLimits({ endpoint: 10 }), { endpoint: 10, owner: 500, conversation: 200 });
  assert.deepEqual(resolveRateLimits(), DEFAULT_RATE_LIMITS);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test sigil/relay/v1/relay-config.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement relay-config.mjs**

```javascript
// sigil/relay/v1/relay-config.mjs
// Configuration defaults for design §8 (rate/quota) and §10 (heartbeat).
// "Generous defaults documented as not tuned for production" (design §8) --
// override via the `overrides` param at call sites, never by editing these
// constants for a specific deployment.
export const DEFAULT_RATE_LIMITS = Object.freeze({ endpoint: 100, owner: 500, conversation: 200 });
export const DEFAULT_INBOX_DEPTH_LIMIT = 500;
export const DEFAULT_HEARTBEAT = Object.freeze({ intervalMs: 15_000, missedBeforeTimeout: 3 });

export function resolveRateLimits(overrides = {}) {
  return { ...DEFAULT_RATE_LIMITS, ...overrides };
}

export function resolveHeartbeat(overrides = {}) {
  return { ...DEFAULT_HEARTBEAT, ...overrides };
}
```

- [ ] **Step 4: Run to verify passing**

Run: `node --test sigil/relay/v1/relay-config.test.mjs`
Expected: PASS

- [ ] **Step 5: Write the migration**

```sql
-- sigil/migrations/007_rate_quota.sql
-- Rolling-window rate limits for endpoint/owner/conversation (design §8).
-- Inbox depth (recipient) is NOT here -- it's derived live from `deliveries`
-- rows in Task 14, since it's a depth limit (must decrement), not a rate.
CREATE TABLE IF NOT EXISTS quota_usage (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('endpoint', 'owner', 'conversation')),
  scope_id TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (scope_kind, scope_id, window_start)
);

CREATE INDEX IF NOT EXISTS quota_usage_window_idx ON quota_usage(scope_kind, scope_id, window_start);
```

- [ ] **Step 6: Write failing reserveRateLimit tests**

Add to `sigil/relay/v1/postgres-repository.test.mjs`:

```javascript
test('reserveRateLimit atomically increments the window counter and reports allowed/denied', async () => {
  const rows = new Map();
  const client = {
    async query(text, values) {
      if (text.startsWith('INSERT')) {
        const key = `${values[0]}:${values[1]}:${values[2]}`;
        const next = (rows.get(key) ?? 0) + 1;
        rows.set(key, next);
        return { rows: [{ count: next }] };
      }
      return { rows: [] };
    }
  };
  const repository = new PostgresRepository({ pool: {} });
  const first = await repository.reserveRateLimit('endpoint', 'ep_1', '2026-08-16T12:00:00.000Z', 2, client);
  const second = await repository.reserveRateLimit('endpoint', 'ep_1', '2026-08-16T12:00:00.000Z', 2, client);
  const third = await repository.reserveRateLimit('endpoint', 'ep_1', '2026-08-16T12:00:00.000Z', 2, client);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
  assert.equal(third.count, 3);
});
```

- [ ] **Step 7: Run to verify failure**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: FAIL

- [ ] **Step 8: Implement reserveRateLimit**

Add to `PostgresRepository`:

```javascript
  async reserveRateLimit(scopeKind, scopeId, windowStart, limit, client) {
    const result = await client.query(
      `INSERT INTO quota_usage (scope_kind, scope_id, window_start, count) VALUES ($1, $2, $3, 1)
       ON CONFLICT (scope_kind, scope_id, window_start) DO UPDATE SET count = quota_usage.count + 1
       RETURNING count`,
      [scopeKind, scopeId, windowStart]
    );
    const count = result.rows[0].count;
    return { count, allowed: count <= limit };
  }
```

- [ ] **Step 9: Add the memory-repository equivalent**

Add a `rateWindows` map to `createMemoryRepository()`'s closure state and:

```javascript
    async reserveRateLimit(scopeKind, scopeId, windowStart, limit) {
      const key = `${scopeKind}:${scopeId}:${windowStart}`;
      const count = (rateWindows.get(key) ?? 0) + 1;
      rateWindows.set(key, count);
      return { count, allowed: count <= limit };
    },
```

- [ ] **Step 10: Run to verify passing**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: PASS

- [ ] **Step 11: Wire rate-limit reservation into acceptWithRepository**

Minute-granularity window: `windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString()`. Add to `sigil/relay/v1/accept-envelope.mjs`, importing `resolveRateLimits`:

```javascript
import { resolveRateLimits } from './relay-config.mjs';
```

Insert into `acceptWithRepository`, after the capability-grant snapshot load and before `validateEnvelope` (rate limiting is independent of envelope content validity — a flooding sender should be capped even if individual envelopes are otherwise well-formed, so this runs early):

```javascript
    const limits = resolveRateLimits(options.rateLimits);
    const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
    for (const [scopeKind, scopeId] of [
      ['endpoint', envelope.sender.endpoint_id],
      ['owner', envelope.sender.owner_id],
      ['conversation', envelope.conversation_id],
    ]) {
      const reservation = await repository.reserveRateLimit(scopeKind, scopeId, windowStart, limits[scopeKind], client);
      if (!reservation.allowed) throw reject('RATE_LIMITED', `${scopeKind} rate limit exceeded`, { scope_kind: scopeKind, scope_id: scopeId, limit: limits[scopeKind] });
    }
```

(Placed after the capability-registry/grant-snapshot block from Task 11, before the `validateEnvelope(...)` call.) Because this whole block runs inside `repository.withTransaction(...)`, a `RATE_LIMITED` throw rolls back the transaction — including the `reserveRateLimit` INSERT/UPDATE — satisfying design §8's "over limit → transaction rolls back (reservation never consumed) → RATE_LIMITED."

- [ ] **Step 12: Add the failing-then-passing rate-limit test**

Add to `sigil/relay/v1/accept-envelope.test.mjs` (extend `fakeTransactionalRepositoryWithMessages` to add a `reserveRateLimit` that always returns `{ allowed: true, count: 1 }` by default, so existing tests are unaffected, then add):

```javascript
test('exceeding the per-endpoint rate limit rejects with RATE_LIMITED and does not persist', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'chat.message', body: { text: 'hi' } });
  const repository = { ...fakeTransactionalRepositoryWithMessages(), async reserveRateLimit() { return { count: 101, allowed: false }; } };
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.equal(result.status, 429);
  assert.equal(result.body.code, 'RATE_LIMITED');
});
```

- [ ] **Step 13: Run to verify passing**

Run: `node --test sigil/relay/v1/accept-envelope.test.mjs`
Expected: PASS

- [ ] **Step 14: Commit**

```bash
git add sigil/relay/v1/relay-config.mjs sigil/relay/v1/relay-config.test.mjs sigil/migrations/007_rate_quota.sql sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/postgres-repository.test.mjs sigil/cli/memory-repository.mjs sigil/relay/v1/accept-envelope.mjs sigil/relay/v1/accept-envelope.test.mjs
git commit -m "feat(C): endpoint/owner/conversation rate limiting at accept (§18 #23)"
```

---

## Task 14: C2 — Recipient inbox-depth limit

**Files:**
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Modify: `sigil/relay/v1/postgres-repository.test.mjs`
- Modify: `sigil/cli/memory-repository.mjs`
- Modify: `sigil/relay/v1/accept-envelope.mjs`
- Modify: `sigil/relay/v1/accept-envelope.test.mjs`

**Interfaces:**
- Produces: `repository.countOpenDeliveries(recipientEndpointId, client): Promise<number>`.

- [ ] **Step 1: Write failing tests**

Add to `sigil/relay/v1/postgres-repository.test.mjs`:

```javascript
test('countOpenDeliveries excludes terminal delivery states', async () => {
  const pool = fakePool();
  const repository = new PostgresRepository({ pool });
  await repository.withTransaction((client) => repository.countOpenDeliveries('ep_claude', client));
  const query = pool.calls.find((call) => call.text?.includes('SELECT'));
  assert.match(query.text, /NOT IN/);
  assert.match(query.text, /acknowledged/);
  assert.match(query.text, /processed/);
  assert.match(query.text, /delivery_rejected/);
  assert.match(query.text, /dead_letter/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement countOpenDeliveries**

Add to `PostgresRepository`:

```javascript
  async countOpenDeliveries(recipientEndpointId, client) {
    const result = await client.query(
      `SELECT count(*) FROM deliveries WHERE recipient_endpoint_id = $1
       AND state NOT IN ('acknowledged', 'processed', 'delivery_rejected', 'dead_letter')`,
      [recipientEndpointId]
    );
    return Number(result.rows[0].count);
  }
```

- [ ] **Step 4: Add the memory-repository equivalent**

```javascript
    async countOpenDeliveries(recipientEndpointId) {
      const terminal = new Set(['acknowledged', 'processed', 'delivery_rejected', 'dead_letter']);
      return [...deliveries.values()].filter((d) => d.recipient_endpoint_id === recipientEndpointId && !terminal.has(d.state)).length;
    },
```

- [ ] **Step 5: Run to verify passing**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: PASS

- [ ] **Step 6: Wire inbox-depth check into acceptWithRepository**

Add to `sigil/relay/v1/accept-envelope.mjs`, importing `DEFAULT_INBOX_DEPTH_LIMIT`:

```javascript
import { resolveRateLimits, DEFAULT_INBOX_DEPTH_LIMIT } from './relay-config.mjs';
```

Insert right after the rate-limit block from Task 13, still before `validateEnvelope`, only when there's a concrete recipient (broadcast envelopes have no single inbox to bound):

```javascript
    if (envelope.recipient?.endpoint_id) {
      const depthLimit = options.inboxDepthLimit ?? DEFAULT_INBOX_DEPTH_LIMIT;
      const openCount = await repository.countOpenDeliveries(envelope.recipient.endpoint_id, client);
      if (openCount >= depthLimit) throw reject('QUOTA_EXCEEDED', 'Recipient inbox depth limit reached', { recipient_endpoint_id: envelope.recipient.endpoint_id, limit: depthLimit });
    }
```

- [ ] **Step 7: Add the failing-then-passing test**

Add to `sigil/relay/v1/accept-envelope.test.mjs` (extend the shared fake repository with a default `countOpenDeliveries` returning `0`):

```javascript
test('exceeding recipient inbox depth rejects with QUOTA_EXCEEDED and does not persist', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'chat.message', body: { text: 'hi' } });
  const repository = { ...fakeTransactionalRepositoryWithMessages(), async reserveRateLimit() { return { count: 1, allowed: true }; }, async countOpenDeliveries() { return 500; } };
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.equal(result.status, 429);
  assert.equal(result.body.code, 'QUOTA_EXCEEDED');
});
```

- [ ] **Step 8: Run to verify passing**

Run: `node --test sigil/relay/v1/accept-envelope.test.mjs`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/postgres-repository.test.mjs sigil/cli/memory-repository.mjs sigil/relay/v1/accept-envelope.mjs sigil/relay/v1/accept-envelope.test.mjs
git commit -m "feat(C): recipient inbox-depth limit, independent of sender-side rate limits (§18 #23)"
```

---

## Task 15: C3 — Rollback-on-reject proof + vertical-slice scenario

**Files:**
- Modify: `sigil/integration/vertical-slice.test.mjs`

**Interfaces:**
- Consumes: Tasks 13/14's full quota pipeline.

- [ ] **Step 1: Write the failing rollback proof**

Add to `sigil/integration/vertical-slice.test.mjs`:

```javascript
test('a RATE_LIMITED rejection never consumes its own reservation (rollback-on-reject) (§18 #23)', async () => {
  const { acceptEnvelopeAsync } = await import('../relay/v1/accept-envelope.mjs');
  const { createMemoryRepository } = await import('../cli/memory-repository.mjs');
  const keys = crypto.generateKeyPairSync('ed25519');
  const sender = { owner_id: 'usr_quota', endpoint_id: 'ep_quota', key_id: 'key_quota', kind: 'agent' };
  const registered = new Map([['ep_quota', { ...sender, status: 'active', public_key: keys.publicKey }]]);
  const repository = createMemoryRepository();
  const template = JSON.parse(fs.readFileSync(new URL('../contracts/v1/envelope.example.json', import.meta.url)));
  const send = async (n) => {
    const envelope = { ...template, message_id: `msg_quota_${n}`, conversation_id: 'conv_quota', sender, recipient: sender, idempotency_key: `send_quota_${n}`, body: { task_id: `task_q${n}`, instruction: 'x' }, created_at: '2026-08-16T12:00:00Z', expires_at: '2026-08-16T13:00:00Z' };
    envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.privateKey).toString('base64url');
    return acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:00:00Z'), rateLimits: { endpoint: 2 } });
  };
  assert.equal((await send(1)).status, 202);
  assert.equal((await send(2)).status, 202);
  const third = await send(3);
  assert.equal(third.status, 429);
  assert.equal(third.body.code, 'RATE_LIMITED');
  // A 4th send in the SAME window must see the count still at 2 (rejected #3
  // never incremented past what #1/#2 already reserved) -- not 3 or 4.
  const fourthOverLimit = await send(4);
  assert.equal(fourthOverLimit.status, 429);
});
```

- [ ] **Step 2: Run to verify passing**

Run: `node --test sigil/integration/vertical-slice.test.mjs`
Expected: PASS. Note: `memory-repository.mjs`'s `withTransaction` is a no-op passthrough (Task 6, Step 5) — it does not actually roll back a rejected reservation the way `PostgresRepository`'s real `ROLLBACK` does. This test only proves the *observable* contract (rejected sends stay rejected, accepted count never exceeds the limit); it does NOT prove memory-repository rolls back a partial increment on error, because `reserveRateLimit`'s increment happens fully before the `RATE_LIMITED` throw either way at these call counts. This is an accepted limitation of the in-memory repository's no-op transaction — flag it in the commit message rather than papering over it with a false assertion.

- [ ] **Step 3: Commit**

```bash
git add sigil/integration/vertical-slice.test.mjs
git commit -m "test(C): rollback-on-reject rate-limit proof (memory-repository transaction is a no-op passthrough, PostgresRepository's real ROLLBACK covered by postgres-repository.test.mjs)"
```

---

## Task 16: E1 — audit_events conversation binding + delivery-transition audit

**Files:**
- Create: `sigil/migrations/008_audit_conversation_binding.sql`
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Modify: `sigil/relay/v1/postgres-repository.test.mjs`
- Modify: `sigil/relay/v1/accept-envelope.mjs`

**Interfaces:**
- Produces: `audit_events.conversation_id` column. `acknowledgeDelivery`/`transitionDelivery` write an audit row in the same transaction as the state change.

- [ ] **Step 1: Write the migration**

```sql
-- sigil/migrations/008_audit_conversation_binding.sql
-- Nullable: identity/token/grant events legitimately have no conversation
-- context. Populated whenever the audited action has one (design §9).
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS conversation_id TEXT REFERENCES conversations(conversation_id);

CREATE INDEX IF NOT EXISTS audit_events_conversation_idx ON audit_events(conversation_id, created_at);
```

- [ ] **Step 2: Write the failing envelope-accept audit test**

Add to `sigil/relay/v1/postgres-repository.test.mjs`:

```javascript
test('persistAcceptedEnvelope writes an audit row with conversation_id bound', async () => {
  const pool = fakePool();
  const row = await new PostgresRepository({ pool }).persistAcceptedEnvelope({ envelope, canonical_bytes: Buffer.from('c'), action_hash: 'sha256:x' });
  const audit = pool.calls.find((call) => call.text?.includes('INSERT INTO audit_events'));
  assert.match(audit.text, /conversation_id/);
  assert.equal(audit.values.includes('conv_1'), true);
});
```

- [ ] **Step 3: Write failing delivery-transition audit tests**

```javascript
test('acknowledgeDelivery writes a delivery.acknowledged audit row in the same transaction', async () => {
  const pool = fakePool();
  const repository = new PostgresRepository({ pool });
  await repository.acknowledgeDelivery({ deliveryId: 'del_1', endpointId: 'ep_claude', now: new Date('2026-08-16T12:00:00Z') });
  const audit = pool.calls.find((call) => call.text?.includes('INSERT INTO audit_events') && call.values?.includes('delivery.acknowledged'));
  assert.ok(audit);
});

test('transitionDelivery writes a delivery.<state> audit row in the same transaction', async () => {
  const pool = fakePool();
  const repository = new PostgresRepository({ pool });
  await repository.transitionDelivery('del_1', 'ep_claude', 'processed', { next: { state: 'processed', updated_at: '2026-08-16T12:00:00Z' } });
  const audit = pool.calls.find((call) => call.text?.includes('INSERT INTO audit_events') && call.values?.includes('delivery.processed'));
  assert.ok(audit);
});
```

(`fakePool`'s default client `query` handler already returns `{ rows: [{ message_id: values?.[0] }] }` for non-BEGIN/COMMIT/ROLLBACK queries, which is enough for these transitions' own `SELECT`/`UPDATE` calls to not throw — they just won't return realistic delivery rows, which these tests don't inspect.)

- [ ] **Step 4: Run to verify failure**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: FAIL — no `conversation_id` column reference yet, no delivery-transition audit inserts yet.

- [ ] **Step 5: Add conversation_id to the envelope-accept audit insert**

In `#insertAcceptedEnvelope` (Task 6), update the `audit_events` insert:

```javascript
    await client.query(
      `INSERT INTO audit_events (event_id, event_type, subject_id, actor_id, conversation_id, payload, created_at)
       VALUES ($1, 'envelope.accepted', $2, $3, $4, $5, $6)`,
      [`audit_${crypto.randomUUID()}`, row.envelope.message_id, row.envelope.sender.endpoint_id, row.envelope.conversation_id, JSON.stringify({ recipient_endpoint_id: row.envelope.recipient?.endpoint_id ?? null }), row.envelope.created_at]
    );
```

- [ ] **Step 6: Add audit rows to acknowledgeDelivery and transitionDelivery**

In `PostgresRepository.acknowledgeDelivery`, after the successful `UPDATE deliveries SET state = 'acknowledged' ...` query (inside the same `withTransaction` block), add:

```javascript
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, endpoint_id, conversation_id, payload, created_at)
         SELECT $1, 'delivery.acknowledged', $2, $3, e.conversation_id, '{}', $4
         FROM deliveries d JOIN envelopes e ON e.message_id = d.message_id WHERE d.delivery_id = $2`,
        [`audit_${crypto.randomUUID()}`, deliveryId, endpointId, timestamp]
      );
```

(Placed right before the `return { delivery_id: deliveryId, duplicate: false, delivery: result.rows[0] };` line.) In `PostgresRepository.transitionDelivery`, after the `UPDATE deliveries ...` query, add:

```javascript
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, endpoint_id, conversation_id, payload, reason, created_at)
         SELECT $1, $2, $3, $4, e.conversation_id, '{}', $5, $6
         FROM deliveries d JOIN envelopes e ON e.message_id = d.message_id WHERE d.delivery_id = $3`,
        [`audit_${crypto.randomUUID()}`, `delivery.${next.state}`, deliveryId, endpointId, next.failure_reason ?? null, next.updated_at ?? new Date().toISOString()]
      );
```

(Placed right before `return result.rows[0];`.) Both use a `SELECT ... FROM deliveries d JOIN envelopes e` subquery to resolve `conversation_id` without requiring the caller to look it up separately — consistent with keeping the audit write inside the same transaction and on the same client as the state mutation (design §9's "mutate-and-audit in one transaction").

- [ ] **Step 7: Run to verify passing**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add sigil/migrations/008_audit_conversation_binding.sql sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/postgres-repository.test.mjs
git commit -m "feat(E): audit_events.conversation_id + delivery-transition audit coverage (§18 #19)"
```

---

## Task 17: E2 — GET /v1/audit route

**Files:**
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Modify: `sigil/relay/v1/postgres-repository.test.mjs`
- Modify: `sigil/relay/v1/http-server.mjs`
- Modify: `sigil/relay/v1/http-server.test.mjs`

**Interfaces:**
- Produces: `repository.isConversationMember(endpointId, conversationId): Promise<boolean>`, `repository.listAuditEventsForConversation(conversationId): Promise<Array>`. New route `GET /v1/audit?conversation_id=<id>`.

- [ ] **Step 1: Write failing repository tests**

Add to `sigil/relay/v1/postgres-repository.test.mjs`:

```javascript
test('isConversationMember checks conversation_members for an active (non-removed) row', async () => {
  const pool = fakePool();
  const repository = new PostgresRepository({ pool });
  await repository.isConversationMember('ep_claude', 'conv_1');
  const query = pool.calls.find((call) => call.text?.includes('conversation_members'));
  assert.match(query.text, /removed_at IS NULL/);
});

test('listAuditEventsForConversation orders by created_at', async () => {
  const pool = fakePool();
  const repository = new PostgresRepository({ pool });
  await repository.listAuditEventsForConversation('conv_1');
  const query = pool.calls.find((call) => call.text?.includes('FROM audit_events'));
  assert.match(query.text, /ORDER BY created_at/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement both methods**

Add to `PostgresRepository`:

```javascript
  async isConversationMember(endpointId, conversationId, client = this.pool) {
    const result = await client.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND endpoint_id = $2 AND removed_at IS NULL',
      [conversationId, endpointId]
    );
    return result.rows.length > 0;
  }
  async listAuditEventsForConversation(conversationId, client = this.pool) {
    const result = await client.query(
      'SELECT event_id, event_type, subject_id, actor_id, actor_human_id, endpoint_id, object_type, object_id, outcome, reason, created_at FROM audit_events WHERE conversation_id = $1 ORDER BY created_at',
      [conversationId]
    );
    return result.rows;
  }
```

- [ ] **Step 4: Run to verify passing**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: PASS

- [ ] **Step 5: Write the failing route test**

Check `sigil/relay/v1/http-server.test.mjs` for its existing request-helper pattern first (it will already have one, since every other route is tested there); reuse it. Add:

```javascript
test('GET /v1/audit requires conversation_id and membership, then returns the conversation timeline', async () => {
  // Follow this file's existing pattern for constructing a repository double
  // and issuing a request against createRelayServer(...) -- mirror whatever
  // helper the file already uses for e.g. the /v1/inbox test, substituting:
  // repository.isConversationMember -> true, repository.listAuditEventsForConversation -> [{...}]
  // Assert: 400 with no conversation_id query param; 403 when isConversationMember
  // resolves false; 200 with { code: 'OK', events: [...] } when true.
});
```

(Write this test using the file's own established request-issuing helper — do not invent a new one; if the file has no such helper yet, that is itself a signal to look again, since every existing route already has a test using one.)

- [ ] **Step 6: Add the route**

In `sigil/relay/v1/http-server.mjs`, add near the end of the route chain (before the final 404 fallback), following the file's existing structure exactly:

```javascript
    if (request.method === 'GET' && request.url.startsWith('/v1/audit')) {
      const conversationId = new URL(request.url, 'http://sigil.local').searchParams.get('conversation_id');
      if (!conversationId) { response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'conversation_id query parameter is required', details: {} })); }
      if (!repository?.isConversationMember || !repository?.listAuditEventsForConversation) return response.writeHead(503).end();
      const isMember = await repository.isConversationMember(principal.endpoint_id, conversationId);
      if (!isMember) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'ROUTE_NOT_AUTHORIZED', message: 'Not a member of this conversation', details: {} })); }
      const events = await repository.listAuditEventsForConversation(conversationId);
      response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(JSON.stringify({ request_id: requestId, code: 'OK', events }));
    }
```

(Conversation-scoped only, per design §9: no cross-conversation or global audit query in v1.)

- [ ] **Step 7: Run to verify passing**

Run: `node --test sigil/relay/v1/http-server.test.mjs`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/postgres-repository.test.mjs sigil/relay/v1/http-server.mjs sigil/relay/v1/http-server.test.mjs
git commit -m "feat(E): GET /v1/audit conversation-scoped audit query (§18 #19)"
```

---

## Task 18: E3 — Rejection-audit durability (two-tier fallback)

**Files:**
- Create: `sigil/relay/v1/rejection-audit.mjs`
- Create: `sigil/relay/v1/rejection-audit.test.mjs`
- Modify: `sigil/relay/v1/accept-envelope.mjs`
- Modify: `sigil/relay/v1/accept-envelope.test.mjs`

**Interfaces:**
- Produces: `writeRejectionAudit({ repository, event, fallbackLog }): Promise<{written: boolean, degraded: boolean}>` — a bounded, best-effort contract: one fresh-transaction attempt, one retry after a short fixed delay, then a best-effort fallback log write. Never throws; never blocks the caller's response.

- [ ] **Step 1: Write failing tests**

```javascript
// sigil/relay/v1/rejection-audit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeRejectionAudit } from './rejection-audit.mjs';

function repositoryThatFails(times) {
  let calls = 0;
  return {
    calls: 0,
    async recordAuditEvent() {
      calls += 1;
      this.calls = calls;
      if (calls <= times) throw new Error('transient');
      return { event_id: 'audit_ok' };
    }
  };
}

test('writes on the first attempt when the repository succeeds immediately', async () => {
  const repository = repositoryThatFails(0);
  const result = await writeRejectionAudit({ repository, event: { eventType: 'envelope.rejected' }, delayMs: 0 });
  assert.deepEqual(result, { written: true, degraded: false });
  assert.equal(repository.calls, 1);
});

test('retries exactly once after a transient failure, then succeeds', async () => {
  const repository = repositoryThatFails(1);
  const result = await writeRejectionAudit({ repository, event: { eventType: 'envelope.rejected' }, delayMs: 0 });
  assert.deepEqual(result, { written: true, degraded: false });
  assert.equal(repository.calls, 2);
});

test('falls back to the log after the retry also fails, without throwing', async () => {
  const repository = repositoryThatFails(5);
  const fallbackLog = { entries: [], async append(entry) { this.entries.push(entry); } };
  const result = await writeRejectionAudit({ repository, event: { eventType: 'envelope.rejected', subjectId: 'msg_1' }, fallbackLog, delayMs: 0 });
  assert.deepEqual(result, { written: false, degraded: true });
  assert.equal(repository.calls, 2);
  assert.equal(fallbackLog.entries.length, 1);
  assert.equal(fallbackLog.entries[0].eventType, 'envelope.rejected');
});

test('a fallback-log failure is swallowed, never thrown to the caller', async () => {
  const repository = repositoryThatFails(5);
  const fallbackLog = { async append() { throw new Error('disk full'); } };
  await assert.doesNotReject(() => writeRejectionAudit({ repository, event: { eventType: 'x' }, fallbackLog, delayMs: 0 }));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test sigil/relay/v1/rejection-audit.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement rejection-audit.mjs**

```javascript
// sigil/relay/v1/rejection-audit.mjs
// A rejected envelope's audit row can't live in the transaction that
// rejected and rolled back -- it would roll back too. Written in a separate,
// immediately-following transaction on a fresh client. Bounded two-tier
// contract (design §9, round 3 blocker 5): one retry after a short fixed
// delay, then a best-effort fallback log. Never throws; never delays the
// rejection response to the caller past the retry.
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function writeRejectionAudit({ repository, event, fallbackLog, delayMs = 250, degradedCounter } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await repository.recordAuditEvent(event);
      return { written: true, degraded: false };
    } catch {
      if (attempt === 0) await sleep(delayMs);
    }
  }
  try {
    await fallbackLog?.append?.(event);
  } catch {
    // Best-effort: a fallback-log failure is swallowed, not retried, and
    // never propagated -- the rejection response is never blocked on this.
  }
  degradedCounter?.increment?.();
  return { written: false, degraded: true };
}
```

- [ ] **Step 4: Run to verify passing**

Run: `node --test sigil/relay/v1/rejection-audit.test.mjs`
Expected: PASS

- [ ] **Step 5: Wire into acceptEnvelopeAsync's rejection path**

In `sigil/relay/v1/accept-envelope.mjs`, add the import:

```javascript
import { writeRejectionAudit } from './rejection-audit.mjs';
```

Change `acceptWithRepository`'s `.catch(...)` tail to fire the rejection audit for capability/replay/quota rejections specifically (not every rejection — a malformed-JSON `INVALID_ENVELOPE` before signature verification has no meaningful `sender`/`conversation_id` to audit against, so scope this to the codes that represent a real, attributable security-relevant rejection):

```javascript
const AUDITED_REJECTION_CODES = new Set(['CAPABILITY_DENIED', 'REPLAY_DETECTED', 'RATE_LIMITED', 'QUOTA_EXCEEDED']);

async function acceptWithRepository(envelope, options) {
  const { repository, now = new Date() } = options;
  return repository.withTransaction(async (client) => {
    /* ... unchanged body from Task 13/14 ... */
  }).catch(async (error) => {
    const response = toResponse(options, error);
    if (AUDITED_REJECTION_CODES.has(error.code) && repository.recordAuditEvent) {
      await writeRejectionAudit({
        repository,
        event: { eventType: `envelope.rejected.${error.code.toLowerCase()}`, subjectId: envelope.message_id, endpointId: envelope.sender?.endpoint_id, outcome: 'rejected', reason: error.message, now },
        fallbackLog: options.rejectionAuditFallbackLog,
        degradedCounter: options.rejectionAuditDegradedCounter,
      });
    }
    return response;
  });
}
```

(The full function body between the `return repository.withTransaction(async (client) => {` line and its closing `})` is the accumulated result of Tasks 6/8/11/13/14 — unchanged here, only the `.catch(...)` tail changes.)

- [ ] **Step 6: Add the integration test**

Add to `sigil/relay/v1/accept-envelope.test.mjs`:

```javascript
test('a CAPABILITY_DENIED rejection triggers a best-effort rejection audit', async () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([['ep_claude', { owner_id: 'usr_claude', status: 'active', key_id: 'key_claude', public_key: keys.publicKey }]]);
  const envelope = makeEnvelope({ keys, messageType: 'chat.message', body: { text: 'hi' } });
  envelope.capabilities = ['sigil.task/submit'];
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.privateKey).toString('base64url');
  const auditCalls = [];
  const repository = { ...fakeTransactionalRepositoryWithMessages(), async lookupCapabilityRegistration() { return null; }, async recordAuditEvent(event) { auditCalls.push(event); return { event_id: 'audit_1' }; } };
  const result = await acceptEnvelopeAsync(envelope, { registered, repository, now: new Date('2026-08-16T12:01:00Z') });
  assert.equal(result.status, 403);
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].eventType, 'envelope.rejected.capability_denied');
});
```

- [ ] **Step 7: Run to verify passing**

Run: `node --test sigil/relay/v1/accept-envelope.test.mjs sigil/relay/v1/rejection-audit.test.mjs`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add sigil/relay/v1/rejection-audit.mjs sigil/relay/v1/rejection-audit.test.mjs sigil/relay/v1/accept-envelope.mjs sigil/relay/v1/accept-envelope.test.mjs
git commit -m "feat(E): bounded rejection-audit durability (one retry, best-effort fallback)"
```

---

## Task 19: H1 — Sender-side delivery.receipt push

**Files:**
- Modify: `sigil/relay/v1/stream-server.mjs`
- Modify: `sigil/relay/v1/stream-server.test.mjs`
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Modify: `sigil/relay/v1/postgres-repository.test.mjs`
- Modify: `sigil/cli/memory-repository.mjs`

**Interfaces:**
- Produces: `stream.notifyReceipt(senderEndpointId, { message_id, delivery_id, state, at }): boolean` on the `createStreamServer(...)` return value, alongside the existing `notify(endpointId, deliveryId)`. Delivery-state transitions resolve the message's sender via a new `repository.lookupMessageSender(messageId, client): Promise<{endpoint_id} | null>` so the transition code (not the caller) can push the receipt.

- [ ] **Step 1: Write failing stream-server tests**

Add to `sigil/relay/v1/stream-server.test.mjs` (following the file's existing test structure for `notify`):

```javascript
test('notifyReceipt pushes a small delivery.receipt payload to the SENDER, not the recipient', () => {
  // Mirror this file's existing `notify` test setup exactly (same fake
  // WebSocketServer/socket doubles), but connect as the SENDER endpoint and
  // assert stream.notifyReceipt(senderEndpointId, {...}) sends
  // { type: 'delivery.receipt', message_id, delivery_id, state, at } to that
  // socket -- and that stream.notify (recipient path) is unaffected.
});
```

(Write this using whatever fake-socket/fake-`WebSocketServer` doubles `stream-server.test.mjs` already uses for its `notify` test — do not invent a new mocking approach.)

- [ ] **Step 2: Run to verify failure**

Run: `node --test sigil/relay/v1/stream-server.test.mjs`
Expected: FAIL — `notifyReceipt` doesn't exist.

- [ ] **Step 3: Add notifyReceipt to stream-server.mjs**

In `sigil/relay/v1/stream-server.mjs`, add to the object returned by `createStreamServer(...)`, alongside `notify`:

```javascript
    notifyReceipt(endpointId, receipt) {
      const socket = clients.get(endpointId);
      if (!socket || socket.readyState !== 1) return false;
      socket.send(JSON.stringify({ type: 'delivery.receipt', ...receipt }));
      return true;
    },
```

(`clients` is the same `Map` the existing `notify` closes over — same connection registry serves both the recipient's `delivered` notification and the sender's receipt stream, per design §10: "just adds the sender as a second notify target alongside the recipient.")

- [ ] **Step 4: Run to verify passing**

Run: `node --test sigil/relay/v1/stream-server.test.mjs`
Expected: PASS

- [ ] **Step 5: Add lookupMessageSender**

Add to `PostgresRepository`:

```javascript
  async lookupMessageSender(messageId, client) {
    const result = await client.query('SELECT sender_endpoint_id FROM envelopes WHERE message_id = $1', [messageId]);
    return result.rows[0] ? { endpoint_id: result.rows[0].sender_endpoint_id } : null;
  }
```

And to `memory-repository.mjs`:

```javascript
    async lookupMessageSender(messageId) {
      const row = envelopes.get(messageId);
      return row ? { endpoint_id: row.envelope.sender.endpoint_id } : null;
    },
```

- [ ] **Step 6: Write failing tests for the transition-time receipt hook**

Add to `sigil/relay/v1/postgres-repository.test.mjs`:

```javascript
test('acknowledgeDelivery resolves the message sender for receipt notification', async () => {
  const pool = fakePool();
  const repository = new PostgresRepository({ pool });
  const result = await repository.acknowledgeDelivery({ deliveryId: 'del_1', endpointId: 'ep_claude', now: new Date('2026-08-16T12:00:00Z') });
  assert.ok('delivery' in result);
});
```

(This test mostly documents the existing return shape stays compatible; the actual receipt *push* happens at the HTTP-route layer in Task 20, using `lookupMessageSender` + `stream.notifyReceipt` together — `acknowledgeDelivery` itself doesn't need to change further here, since it already returns the updated `delivery` row, and `http-server.mjs`'s ack route already has `deliveryId` in scope to resolve the sender from.)

- [ ] **Step 7: Run to verify passing**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: PASS (no new failures — this step is a documentation/regression check, not new behavior)

- [ ] **Step 8: Commit**

```bash
git add sigil/relay/v1/stream-server.mjs sigil/relay/v1/stream-server.test.mjs sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/postgres-repository.test.mjs sigil/cli/memory-repository.mjs
git commit -m "feat(H): notifyReceipt stream channel + lookupMessageSender"
```

---

## Task 20: H2 — Wire receipts into delivery routes + heartbeat ping/pong framing

**Files:**
- Modify: `sigil/relay/v1/http-server.mjs`
- Modify: `sigil/relay/v1/http-server.test.mjs`
- Modify: `sigil/relay/v1/stream-server.mjs`
- Modify: `sigil/relay/v1/stream-server.test.mjs`

**Interfaces:**
- Consumes: `stream.notifyReceipt`, `repository.lookupMessageSender` (Task 19), `resolveHeartbeat`/`DEFAULT_HEARTBEAT` (Task 13's `relay-config.mjs`).
- Produces: relay replies to `{"type":"ping",...}` frames with `{"type":"pong",...}` on the same stream connection.

- [ ] **Step 1: Wire receipt push into the ack/processing routes**

In `sigil/relay/v1/http-server.mjs`'s `/v1/deliveries/:id/(ack|processing)` handler, after a successful `acknowledgeDelivery` call and after a successful `transitionDelivery` call, push the receipt to the sender. For the `ack` branch:

```javascript
      if (action === 'ack' && repository?.acknowledgeDelivery) {
        try {
          const acked = await repository.acknowledgeDelivery({ deliveryId, endpointId: principal.endpoint_id, now });
          if (stream && repository.lookupMessageSender) {
            const senderLookup = await repository.lookupMessageSender(acked.delivery?.message_id ?? acked.message_id);
            if (senderLookup) stream.notifyReceipt(senderLookup.endpoint_id, { message_id: acked.delivery?.message_id ?? acked.message_id, delivery_id: deliveryId, state: 'acknowledged', at: now instanceof Date ? now.toISOString() : new Date(now ?? Date.now()).toISOString() });
          }
          response.writeHead(204, { 'x-sigil-request-id': requestId });
          return response.end();
        } catch (error) {
          response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
          return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'DELIVERY_UNAVAILABLE', message: error.message, details: {} }));
        }
      }
```

For the `processing`/`processing_failed`/`processed` branch (the generic `transitionDelivery` path right below it):

```javascript
      if (!repository?.transitionDelivery || !repository?.getDelivery) return response.writeHead(503).end();
      try {
        const current = await repository.getDelivery(deliveryId, principal.endpoint_id);
        const next = transitionDelivery(current, target, { now, reason: body.reason ?? null });
        await repository.transitionDelivery(deliveryId, principal.endpoint_id, target, { next });
        if (stream && repository.lookupMessageSender) {
          const senderLookup = await repository.lookupMessageSender(current.message_id);
          if (senderLookup) stream.notifyReceipt(senderLookup.endpoint_id, { message_id: current.message_id, delivery_id: deliveryId, state: next.state, at: next.updated_at });
        }
        response.writeHead(204, { 'x-sigil-request-id': requestId });
        return response.end();
      } catch (error) {
        response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'DELIVERY_UNAVAILABLE', message: error.message, details: {} }));
      }
```

This covers every transition design §10 lists (`delivered` is already pushed via the existing `notify` at accept-time in the recipient's direction — the sender's `delivered` receipt fires from the same accept-time `stream.notify` call site, extended below; `acknowledged`/`processing`/`processed`/`processing_failed`/`dead_letter` all flow through `transitionDelivery`/`acknowledgeDelivery` here).

- [ ] **Step 2: Extend the accept-time notify to also push the sender's "delivered" receipt**

In `sigil/relay/v1/http-server.mjs`'s `/v1/envelopes` handler (from Task 6, Step 6), extend `onPersisted`:

```javascript
        onPersisted: async ({ envelope: accepted, persisted }) => {
          if (stream && accepted.recipient?.endpoint_id && !persisted?.duplicate) {
            stream.notify(accepted.recipient.endpoint_id, persisted.message_id);
            stream.notifyReceipt(accepted.sender.endpoint_id, { message_id: persisted.message_id, delivery_id: `del_${persisted.message_id}`, state: 'delivered', at: accepted.created_at });
          }
        }
```

(`del_${persisted.message_id}` matches the delivery-id-generation convention already used at `#insertAcceptedEnvelope`'s `row.delivery_id ?? \`del_${crypto.randomUUID()}\`` fallback and `memory-repository.mjs`'s `\`del_${row.message_id}\``, when no explicit `delivery_id` was passed in — acceptable for the receipt payload since it's informational, not used to look anything up.)

- [ ] **Step 3: Write failing heartbeat framing tests**

Add to `sigil/relay/v1/stream-server.test.mjs`:

```javascript
test('relay replies to a JSON ping frame with a JSON pong frame on the same connection', () => {
  // Mirror this file's existing connection-double setup. Simulate the
  // client socket emitting a 'message' event with JSON.stringify({ type:
  // 'ping', timestamp: '...' }); assert the socket's .send(...) was called
  // with JSON.stringify({ type: 'pong', timestamp: '...' }) -- NOT a native
  // WebSocket control-frame ping/pong (no socket.ping()/socket.pong() call).
});
```

- [ ] **Step 4: Run to verify failure**

Run: `node --test sigil/relay/v1/stream-server.test.mjs`
Expected: FAIL — no ping/pong handling yet.

- [ ] **Step 5: Implement JSON ping/pong in stream-server.mjs**

In `createStreamServer`'s `wss.on('connection', ...)` handler, add a `message` listener right after `clients.set(endpointId, socket)`:

```javascript
    socket.on('message', (raw) => {
      let message; try { message = JSON.parse(raw); } catch { return; }
      if (message?.type === 'ping') socket.send(JSON.stringify({ type: 'pong', timestamp: message.timestamp }));
    });
```

(JSON application-frame ping/pong, not native WS control frames — per design §10 round 4 guidance, so a future browser connector can inspect these identically to a Node connector.)

- [ ] **Step 6: Run to verify passing**

Run: `node --test sigil/relay/v1/stream-server.test.mjs`
Expected: PASS

- [ ] **Step 7: Run the full http-server + stream-server suite**

Run: `node --test sigil/relay/v1/http-server.test.mjs sigil/relay/v1/stream-server.test.mjs`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add sigil/relay/v1/http-server.mjs sigil/relay/v1/http-server.test.mjs sigil/relay/v1/stream-server.mjs sigil/relay/v1/stream-server.test.mjs
git commit -m "feat(H): sender delivery receipts on every state transition + JSON ping/pong framing"
```

---

## Task 21: H3 — Connector-side heartbeat + "relay unreachable" surfacing

**Files:**
- Modify: `sigil/cli/inbox-wait.mjs`
- Modify: `sigil/cli/inbox-wait.test.mjs`

**Interfaces:**
- Consumes: `resolveHeartbeat`/`DEFAULT_HEARTBEAT` (Task 13).
- Produces: a new `INBOX_WAIT_EXIT_CODES.RELAY_UNREACHABLE` exit code; `waitForOneInboxMessage` sends periodic JSON `ping` frames and fails with that code if `missedBeforeTimeout` consecutive pongs are missed.

- [ ] **Step 1: Write failing tests**

Add to `sigil/cli/inbox-wait.test.mjs` (matching the file's existing `WebSocketImpl` fake-socket injection pattern used for its other stream tests):

```javascript
test('surfaces RELAY_UNREACHABLE after missedBeforeTimeout consecutive missed heartbeats', async () => {
  // Use this file's existing fake WebSocketImpl pattern: a socket that opens
  // successfully, never replies to any 'ping' frame sent on it, and never
  // delivers an inbox item. Pass heartbeat: { intervalMs: 10, missedBeforeTimeout: 2 }
  // (short values so the test doesn't wait on the real 15s/45s defaults).
  // Assert the wait rejects with an InboxWaitError whose exitCode is
  // INBOX_WAIT_EXIT_CODES.RELAY_UNREACHABLE, distinct from TIMEOUT --
  // this is the whole point of §10's incident: silence must be
  // distinguishable from "nothing new."
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test sigil/cli/inbox-wait.test.mjs`
Expected: FAIL

- [ ] **Step 3: Add the exit code**

In `sigil/cli/inbox-wait.mjs`, extend `INBOX_WAIT_EXIT_CODES`:

```javascript
export const INBOX_WAIT_EXIT_CODES = Object.freeze({ TIMEOUT: 2, AUTH: 3, CONNECTION: 4, MALFORMED: 5, RELAY_UNREACHABLE: 6, SIGINT: 130, SIGTERM: 143 });
```

- [ ] **Step 4: Wire heartbeat ping/pong + timeout detection into waitForOneInboxMessage**

Add a `heartbeat` option (defaulting via `resolveHeartbeat` from `relay-config.mjs`) to `waitForOneInboxMessage`'s signature, import it, and add heartbeat state alongside the existing `reconnectTimer`/`fallbackTimer` declarations:

```javascript
import { resolveHeartbeat } from '../relay/v1/relay-config.mjs';
```

```javascript
export async function waitForOneInboxMessage({ relay, identity, streamUrl, timeoutMs = 300_000, WebSocketImpl = DefaultWebSocket, print = console.log, signalSource = process, ledgerPath, heartbeat: heartbeatOverrides } = {}) {
  const heartbeat = resolveHeartbeat(heartbeatOverrides);
  if (!relay || !identity?.relay_token || !streamUrl) throw new Error('relay, identity, and streamUrl are required');
  let socket; let stopped = false; let reconnectTimer; let fallbackTimer; let timeoutTimer; let reconnectDelay = 250; let polling = false;
  let heartbeatTimer; let missedHeartbeats = 0;
  let resolveWait; let rejectWait;
```

In `cleanup()`, add `clearInterval(heartbeatTimer);` alongside the existing `clearTimeout`/`clearInterval` calls. In `connect()`'s `socket.once('open', ...)` handler, start the heartbeat loop:

```javascript
      socket.once('open', () => {
        opened = true; reconnectDelay = 250; missedHeartbeats = 0;
        clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          missedHeartbeats += 1;
          if (missedHeartbeats > heartbeat.missedBeforeTimeout) { fail(new InboxWaitError('Relay unreachable: no heartbeat reply', INBOX_WAIT_EXIT_CODES.RELAY_UNREACHABLE)); return; }
          try { socket.send(JSON.stringify({ type: 'ping', timestamp: new Date().toISOString() })); } catch {}
        }, heartbeat.intervalMs);
      });
```

Extend the existing `socket.on('message', ...)` handler to reset the missed-heartbeat counter on a `pong`, alongside its existing `delivered` handling:

```javascript
      socket.on('message', (raw) => {
        try { const event = JSON.parse(raw); if (event.type === 'delivered') poll(); if (event.type === 'pong') missedHeartbeats = 0; }
        catch (error) { fail(new InboxWaitError(`Malformed stream event: ${error.message}`, INBOX_WAIT_EXIT_CODES.MALFORMED, { cause: error })); }
      });
```

- [ ] **Step 5: Run to verify passing**

Run: `node --test sigil/cli/inbox-wait.test.mjs`
Expected: PASS

- [ ] **Step 6: Run the full CLI test suite for regressions**

Run: `node --test sigil/cli/`
Expected: PASS — the new `heartbeat` option is additive-optional (defaults apply when omitted), so every existing `waitForOneInboxMessage` call site and test is unaffected.

- [ ] **Step 7: Commit**

```bash
git add sigil/cli/inbox-wait.mjs sigil/cli/inbox-wait.test.mjs
git commit -m "feat(H): connector heartbeat, surface RELAY_UNREACHABLE distinct from TIMEOUT"
```

---

## Task 22: H4 — `sigil send --wait-for-receipt`

**Files:**
- Modify: `sigil/cli/sigil.mjs`

**Interfaces:**
- Consumes: `stream.notifyReceipt` events pushed in Task 20 (the sender's own `--stream-url` connection now receives `delivery.receipt` frames after `cmdSend` submits an envelope).

- [ ] **Step 1: Add the flag and receipt-tracking loop to cmdSend**

In `sigil/cli/sigil.mjs`, add `'wait-for-receipt': { type: 'boolean' }` to `cmdSend`'s `parseArgs` options. After the existing `console.log(\`Sent. message_id=...\`)` line, add:

```javascript
  if (Boolean(args.values['wait-for-receipt'])) {
    const streamUrl = resolved.streamUrl ?? (() => { const url = new URL(relayUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.port = String((Number(url.port || (url.protocol === 'wss:' ? 443 : 80)) + 1)); url.pathname = '/v1/stream'; return url.toString(); })();
    await new Promise((resolvePromise) => {
      const socket = new WebSocket(streamUrl, { headers: { authorization: `Bearer ${identity.relay_token}` } });
      const seen = new Set();
      const terminal = new Set(['acknowledged', 'processed', 'processing_failed', 'dead_letter']);
      const finish = () => { try { socket.close(); } catch {} resolvePromise(); };
      const timer = setTimeout(finish, 60_000);
      socket.on('message', (raw) => {
        let event; try { event = JSON.parse(raw); } catch { return; }
        if (event.type !== 'delivery.receipt' || event.message_id !== result.message_id || seen.has(event.state)) return;
        seen.add(event.state);
        console.log(`  -> ${event.state} (${event.at})`);
        if (terminal.has(event.state)) { clearTimeout(timer); finish(); }
      });
      socket.once('error', () => { clearTimeout(timer); finish(); });
    });
  }
```

`resolved.streamUrl` needs to be added to `resolveConfig`'s `flags` object earlier in `cmdSend` — add `'stream-url': { type: 'string' }` to `cmdSend`'s `parseArgs` options and pass `streamUrl: opt(args, ['stream-url'])` into the `resolveConfig({ flags: {...} })` call, matching `cmdInbox`'s existing pattern exactly.

- [ ] **Step 2: Update the usage string**

In `usage()`, update the `send` line:

```
  send [--identity path] [--relay-url url] [--stream-url url] [--wait-for-receipt] --to endpoint_id --to-owner owner_id --message "text" [--conversation id]
```

- [ ] **Step 3: Manually verify against a local relay**

Run:
```bash
node sigil/cli/sigil.mjs init alice --owner usr_alice
node sigil/cli/sigil.mjs init bob --owner usr_bob
node sigil/cli/sigil.mjs relay up --port 8791 &
node sigil/cli/sigil.mjs send --identity .sigil/alice.identity.json --relay-url http://127.0.0.1:8791 --to ep_bob --to-owner usr_bob --message "hi" --wait-for-receipt
```
Expected: `Sent. message_id=...` followed by `  -> delivered (...)` printed within a second or two (no `acknowledged`/`processed` line yet, since nothing has acked it — that's expected; the 60s timeout in Step 1 caps the wait). Stop the relay process after.

- [ ] **Step 4: Commit**

```bash
git add sigil/cli/sigil.mjs
git commit -m "feat(H): sigil send --wait-for-receipt prints delivery-state progression"
```

---

## Task 23: G1 — Display-name collision (DB-enforced)

**Files:**
- Create: `sigil/migrations/009_display_name_collision.sql`
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Modify: `sigil/relay/v1/postgres-repository.test.mjs`
- Modify: `sigil/contracts/v1/errors-and-states.json`
- Modify: `sigil/contracts/v1/validate-contracts.mjs`

**Interfaces:**
- Produces: `repository.createEndpointWithAudit({...}): Promise<{endpoint_id, ...}>`, throwing `DISPLAY_NAME_COLLISION` on constraint violation. New error code in the contract.

- [ ] **Step 1: Write the migration**

```sql
-- sigil/migrations/009_display_name_collision.sql
-- Case-folded, whitespace-trimmed uniqueness per owner (design §11).
-- Generated column so existing display_name values need no backfill script
-- and the normalization rule can never drift out of sync with the index.
ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS normalized_display_name TEXT
  GENERATED ALWAYS AS (lower(trim(display_name))) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS endpoints_owner_display_name_idx ON endpoints(owner_id, normalized_display_name);
```

- [ ] **Step 2: Add the error code to the contract**

In `sigil/contracts/v1/errors-and-states.json`, add `"DISPLAY_NAME_COLLISION"` to the `errors` array (after `"DUPLICATE_MESSAGE"`, alphabetically-adjacent grouping isn't enforced elsewhere in the file, so append is fine):

```json
    "DUPLICATE_MESSAGE",
    "DISPLAY_NAME_COLLISION",
    "REPLAY_DETECTED",
```

- [ ] **Step 3: Write failing repository tests**

Add to `sigil/relay/v1/postgres-repository.test.mjs`:

```javascript
test('createEndpointWithAudit inserts the endpoint and an audit row in one transaction', async () => {
  const pool = fakePool();
  const repository = new PostgresRepository({ pool });
  const endpoint = await repository.createEndpointWithAudit({ endpointId: 'ep_new', ownerId: 'usr_1', installationId: 'inst_1', runtime: 'claude', displayName: 'Alice Agent', keyId: 'key_1', publicKey: Buffer.from('pk'), now: new Date('2026-08-16T12:00:00Z') });
  assert.ok(endpoint);
  assert.ok(pool.calls.some((call) => call.text?.includes('INSERT INTO audit_events')));
});

test('createEndpointWithAudit maps a unique-constraint violation on normalized_display_name to DISPLAY_NAME_COLLISION', async () => {
  const client = { async query(text) { if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] }; if (text.startsWith('INSERT INTO endpoints')) throw Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'endpoints_owner_display_name_idx' }); return { rows: [] }; }, release() {} };
  const pool = { async connect() { return client; } };
  const repository = new PostgresRepository({ pool });
  await assert.rejects(
    () => repository.createEndpointWithAudit({ endpointId: 'ep_new', ownerId: 'usr_1', installationId: 'inst_1', runtime: 'claude', displayName: 'Alice Agent', keyId: 'key_1', publicKey: Buffer.from('pk'), now: new Date() }),
    (error) => error.code === 'DISPLAY_NAME_COLLISION'
  );
});
```

- [ ] **Step 4: Run to verify failure**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: FAIL

- [ ] **Step 5: Implement createEndpointWithAudit**

Add to `PostgresRepository`, following the exact `*WithAudit` shape already used by `createCapabilityGrantWithAudit` (mutation + `audit_events` insert, same client, same transaction):

```javascript
  async createEndpointWithAudit({ endpointId, ownerId, installationId, runtime, displayName, keyId, publicKey, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      try {
        const endpoint = await client.query(
          `INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
           VALUES ($1, $2, $3, $4, $5, 'active', $6) RETURNING endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at`,
          [endpointId, ownerId, runtime, installationId, displayName, timestamp]
        );
        await client.query(
          `INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ($1, $2, 'Ed25519', $3, 'active', $4)`,
          [keyId, endpointId, publicKey, timestamp]
        );
        await client.query(
          `INSERT INTO audit_events (event_id, event_type, subject_id, actor_id, object_type, object_id, outcome, created_at)
           VALUES ($1, 'endpoint.created', $2, $3, 'endpoint', $2, 'success', $4)`,
          [`audit_${crypto.randomUUID()}`, endpointId, ownerId, timestamp]
        );
        return endpoint.rows[0];
      } catch (error) {
        if (error.code === '23505' && error.constraint === 'endpoints_owner_display_name_idx') {
          throw Object.assign(new Error('An endpoint with this display name already exists for this owner'), { code: 'DISPLAY_NAME_COLLISION' });
        }
        throw error;
      }
    });
  }
```

- [ ] **Step 6: Run to verify passing**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: PASS

- [ ] **Step 7: Run the contracts validator**

Run: `node sigil/contracts/v1/validate-contracts.mjs`
Expected: prints `Sigil v1 contracts valid` (the new error code doesn't break any existing assertion — `validate-contracts.mjs` only checks specific named codes like `APPROVAL_REQUIRED`/`VERSION_UNSUPPORTED` are present, not an exhaustive list).

- [ ] **Step 8: Commit**

```bash
git add sigil/migrations/009_display_name_collision.sql sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/postgres-repository.test.mjs sigil/contracts/v1/errors-and-states.json
git commit -m "feat(G): DB-enforced normalized display-name collision per owner (§18 #22)"
```

---

## Task 24: G2 — Endpoint acknowledgements (unverified-endpoint presentation)

**Files:**
- Create: `sigil/migrations/010_endpoint_acknowledgements.sql`
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Modify: `sigil/relay/v1/postgres-repository.test.mjs`
- Modify: `sigil/relay/v1/http-server.mjs`
- Modify: `sigil/relay/v1/http-server.test.mjs`

**Interfaces:**
- Produces: `repository.acknowledgeEndpoint({viewerOwnerId, acknowledgedEndpointId, now}): Promise<{...}>`. New route `POST /v1/endpoint-acknowledgements`.

- [ ] **Step 1: Write the migration**

```sql
-- sigil/migrations/010_endpoint_acknowledgements.sql
-- Per-viewer relay state: "this owner has seen this endpoint's identity"
-- (design §11). Upsert on repeat ack (e.g. after key rotation); never
-- auto-cleared on the acknowledged endpoint's later revocation -- that's a
-- separate, independently-checked live status.
CREATE TABLE IF NOT EXISTS endpoint_acknowledgements (
  viewer_owner_id TEXT NOT NULL REFERENCES humans(human_id),
  acknowledged_endpoint_id TEXT NOT NULL REFERENCES endpoints(endpoint_id),
  acknowledged_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (viewer_owner_id, acknowledged_endpoint_id)
);
```

- [ ] **Step 2: Write failing tests**

Add to `sigil/relay/v1/postgres-repository.test.mjs`:

```javascript
test('acknowledgeEndpoint upserts and writes an audit row in one transaction', async () => {
  const pool = fakePool();
  const repository = new PostgresRepository({ pool });
  await repository.acknowledgeEndpoint({ viewerOwnerId: 'usr_1', acknowledgedEndpointId: 'ep_2', now: new Date('2026-08-16T12:00:00Z') });
  const insert = pool.calls.find((call) => call.text?.includes('INSERT INTO endpoint_acknowledgements'));
  assert.match(insert.text, /ON CONFLICT/);
  const audit = pool.calls.find((call) => call.text?.includes('endpoint_acknowledgement.created'));
  assert.ok(audit);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: FAIL

- [ ] **Step 4: Implement acknowledgeEndpoint**

Add to `PostgresRepository`:

```javascript
  async acknowledgeEndpoint({ viewerOwnerId, acknowledgedEndpointId, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    return this.withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO endpoint_acknowledgements (viewer_owner_id, acknowledged_endpoint_id, acknowledged_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (viewer_owner_id, acknowledged_endpoint_id) DO UPDATE SET acknowledged_at = $3
         RETURNING viewer_owner_id, acknowledged_endpoint_id, acknowledged_at`,
        [viewerOwnerId, acknowledgedEndpointId, timestamp]
      );
      await client.query(
        `INSERT INTO audit_events (event_id, event_type, subject_id, actor_human_id, object_type, object_id, outcome, created_at)
         VALUES ($1, 'endpoint_acknowledgement.created', $2, $3, 'endpoint', $2, 'success', $4)`,
        [`audit_${crypto.randomUUID()}`, acknowledgedEndpointId, viewerOwnerId, timestamp]
      );
      return result.rows[0];
    });
  }
```

- [ ] **Step 5: Run to verify passing**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: PASS

- [ ] **Step 6: Write the failing route test**

Add to `sigil/relay/v1/http-server.test.mjs`, matching the file's existing route-test pattern:

```javascript
test('POST /v1/endpoint-acknowledgements records the acknowledgement under the authenticated caller owner_id', async () => {
  // Mirror this file's existing route-test pattern (e.g. the
  // /v1/capability-grants test): authenticate as a principal with
  // owner/human_id set, POST { acknowledged_endpoint_id: 'ep_2' }, assert
  // repository.acknowledgeEndpoint was called with viewerOwnerId equal to
  // the AUTHENTICATED principal's owner_id -- never a value taken from the
  // request body -- and assert the response is 201 with the acknowledgement.
});
```

- [ ] **Step 7: Add the route**

In `sigil/relay/v1/http-server.mjs`, add near the capability-grants routes (same authentication shape — `principal.owner_id` derived from the bearer token, per design §11's "same authentication path every other route in http-server.mjs already uses"):

```javascript
    if (request.method === 'POST' && request.url === '/v1/endpoint-acknowledgements') {
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body?.acknowledged_endpoint_id) { response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'acknowledged_endpoint_id is required', details: {} })); }
      if (!repository?.acknowledgeEndpoint) return response.writeHead(503).end();
      const acknowledgement = await repository.acknowledgeEndpoint({ viewerOwnerId: principal.owner_id, acknowledgedEndpointId: body.acknowledged_endpoint_id, now });
      response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(JSON.stringify({ request_id: requestId, code: 'OK', acknowledgement }));
    }
```

(`viewerOwnerId: principal.owner_id` — never `body.viewer_owner_id` or similar — is the whole point of design §11's "a caller cannot acknowledge on behalf of another owner.")

- [ ] **Step 8: Run to verify passing**

Run: `node --test sigil/relay/v1/http-server.test.mjs`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add sigil/migrations/010_endpoint_acknowledgements.sql sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/postgres-repository.test.mjs sigil/relay/v1/http-server.mjs sigil/relay/v1/http-server.test.mjs
git commit -m "feat(G): POST /v1/endpoint-acknowledgements, authenticated + audited (§18 #22)"
```

---

## Task 25: G3 — Unverified flag on inbox listings + upsert/revocation-independence proof

**Files:**
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Modify: `sigil/relay/v1/postgres-repository.test.mjs`
- Modify: `sigil/relay/v1/http-server.mjs`
- Modify: `sigil/integration/vertical-slice.test.mjs`

**Interfaces:**
- Modifies: `repository.listInbox(endpointId, since)` return shape gains `sender_unverified: boolean` per item, joined against `endpoint_acknowledgements` for the requesting viewer.

- [ ] **Step 1: Write the failing listInbox test**

Add to `sigil/relay/v1/postgres-repository.test.mjs`:

```javascript
test('listInbox joins endpoint_acknowledgements to flag unacknowledged senders as unverified', async () => {
  const pool = fakePool();
  const repository = new PostgresRepository({ pool });
  await repository.listInbox('ep_claude', '', 'usr_claude_owner');
  const query = pool.calls.find((call) => call.text?.includes('FROM deliveries'));
  assert.match(query.text, /endpoint_acknowledgements/);
  assert.match(query.text, /sender_unverified/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: FAIL

- [ ] **Step 3: Extend listInbox with the viewer-scoped join**

Replace `PostgresRepository.listInbox`, adding a third `viewerOwnerId` param:

```javascript
  async listInbox(endpointId, since = '', viewerOwnerId = null) {
    const result = await this.pool.query(
      `SELECT d.delivery_id, d.message_id, d.recipient_endpoint_id, d.state, d.attempts, d.queued_at,
              e.protocol, e.message_type, e.body, e.context_refs, e.capabilities, e.correlation_id,
              e.sender_endpoint_id, e.expires_at, e.created_at,
              (ea.acknowledged_endpoint_id IS NULL) AS sender_unverified
       FROM deliveries d JOIN envelopes e ON e.message_id = d.message_id
       LEFT JOIN endpoint_acknowledgements ea ON ea.acknowledged_endpoint_id = e.sender_endpoint_id AND ea.viewer_owner_id = $3
       WHERE d.recipient_endpoint_id = $1 AND d.state = 'queued' AND ($2 = '' OR d.queued_at > $2)
       ORDER BY d.queued_at, d.delivery_id`, [endpointId, since, viewerOwnerId]
    );
    return result.rows;
  }
```

- [ ] **Step 4: Run to verify passing**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs`
Expected: PASS

- [ ] **Step 5: Pass the viewer's owner_id from the /v1/inbox route**

In `sigil/relay/v1/http-server.mjs`'s `GET /v1/inbox` handler, change the `repository.listInbox(...)` call to pass the authenticated viewer's `owner_id`:

```javascript
      const items = await repository.listInbox(principal.endpoint_id, since, principal.owner_id ?? null);
```

- [ ] **Step 6: Write the upsert/revocation-independence integration proof**

Add to `sigil/integration/vertical-slice.test.mjs` — this exercises `createMemoryRepository()`, so first give `memory-repository.mjs` the matching acknowledgement + `listInbox` viewer-flag behavior (small addition, same shape as the postgres path):

Add to `createMemoryRepository()`'s closure state:

```javascript
  const acknowledgements = new Map();
```

Add to the returned object:

```javascript
    async acknowledgeEndpoint({ viewerOwnerId, acknowledgedEndpointId, now = new Date() }) {
      const key = `${viewerOwnerId}:${acknowledgedEndpointId}`;
      const record = { viewer_owner_id: viewerOwnerId, acknowledged_endpoint_id: acknowledgedEndpointId, acknowledged_at: (now instanceof Date ? now : new Date(now)).toISOString() };
      acknowledgements.set(key, record);
      return record;
    },
```

And change `listInbox` in `memory-repository.mjs` to accept and apply `viewerOwnerId`:

```javascript
    async listInbox(endpointId, since = '', viewerOwnerId = null) {
      return [...deliveries.values()]
        .filter((d) => d.recipient_endpoint_id === endpointId && d.state === 'delivered' && d.queued_at > since)
        .map((d) => {
          const row = envelopes.get(d.message_id);
          const acknowledged = viewerOwnerId ? acknowledgements.has(`${viewerOwnerId}:${row.envelope.sender.endpoint_id}`) : false;
          return { delivery_id: d.delivery_id, message_id: d.message_id, envelope: row.envelope, queued_at: d.queued_at, sender_unverified: !acknowledged };
        });
    },
```

Then add the integration test to `sigil/integration/vertical-slice.test.mjs`:

```javascript
test('unverified flag clears after acknowledgement, upsert re-acknowledges without error, revocation does not clear it (§18 #22)', async () => {
  const { createMemoryRepository } = await import('../cli/memory-repository.mjs');
  const repository = createMemoryRepository();
  const senderKeys = crypto.generateKeyPairSync('ed25519');
  const sender = { owner_id: 'usr_sender', endpoint_id: 'ep_sender', key_id: 'key_sender', kind: 'agent' };
  const template = JSON.parse(fs.readFileSync(new URL('../contracts/v1/envelope.example.json', import.meta.url)));
  const envelope = { ...template, message_id: 'msg_unverified_1', conversation_id: 'conv_unverified', sender, recipient: { owner_id: 'usr_viewer', endpoint_id: 'ep_viewer' }, created_at: '2026-08-16T12:00:00Z', expires_at: '2026-08-16T13:00:00Z' };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), senderKeys.privateKey).toString('base64url');
  await repository.persistAcceptedEnvelope({ envelope, message_id: envelope.message_id });

  const beforeAck = await repository.listInbox('ep_viewer', '', 'usr_viewer');
  assert.equal(beforeAck[0].sender_unverified, true);

  await repository.acknowledgeEndpoint({ viewerOwnerId: 'usr_viewer', acknowledgedEndpointId: 'ep_sender', now: new Date('2026-08-16T12:01:00Z') });
  const afterAck = await repository.listInbox('ep_viewer', '', 'usr_viewer');
  assert.equal(afterAck[0].sender_unverified, false);

  // Re-acknowledging (e.g. after key rotation) is an upsert, not an error.
  await assert.doesNotReject(() => repository.acknowledgeEndpoint({ viewerOwnerId: 'usr_viewer', acknowledgedEndpointId: 'ep_sender', now: new Date('2026-08-16T12:02:00Z') }));

  // Endpoint status (active/revoked) is independent, live, checked elsewhere
  // (validateEnvelope's ENDPOINT_REVOKED check) -- acknowledging never
  // auto-clears, and this repository has no code path that would clear it.
  const stillAcked = await repository.listInbox('ep_viewer', '', 'usr_viewer');
  assert.equal(stillAcked[0].sender_unverified, false);
});
```

- [ ] **Step 7: Run the full suite**

Run: `node --test sigil/relay/v1/postgres-repository.test.mjs sigil/relay/v1/http-server.test.mjs sigil/cli/memory-repository.test.mjs sigil/integration/vertical-slice.test.mjs`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/postgres-repository.test.mjs sigil/relay/v1/http-server.mjs sigil/cli/memory-repository.mjs sigil/integration/vertical-slice.test.mjs
git commit -m "feat(G): viewer-scoped unverified-endpoint flag on inbox listings, upsert + revocation-independence proof"
```

---

## Task 26: Full-suite regression pass + migration idempotency check

**Files:** none (verification-only task)

- [ ] **Step 1: Run the entire unit test suite**

Run: `node --test sigil/`
Expected: PASS, all files (existing + everything added by this plan).

- [ ] **Step 2: Verify migration idempotency**

Run every new migration file's SQL twice in a row against a scratch Postgres database (`SIGIL_TEST_DATABASE_URL`, if configured) to confirm the `IF NOT EXISTS`/`ON CONFLICT DO NOTHING` guards actually make re-application a no-op rather than an error:

```bash
psql "$SIGIL_TEST_DATABASE_URL" -f sigil/migrations/005_message_lookup_index.sql -f sigil/migrations/006_capability_registry.sql -f sigil/migrations/007_rate_quota.sql -f sigil/migrations/008_audit_conversation_binding.sql -f sigil/migrations/009_display_name_collision.sql -f sigil/migrations/010_endpoint_acknowledgements.sql
psql "$SIGIL_TEST_DATABASE_URL" -f sigil/migrations/005_message_lookup_index.sql -f sigil/migrations/006_capability_registry.sql -f sigil/migrations/007_rate_quota.sql -f sigil/migrations/008_audit_conversation_binding.sql -f sigil/migrations/009_display_name_collision.sql -f sigil/migrations/010_endpoint_acknowledgements.sql
```

Expected: both runs succeed with no errors. If `SIGIL_TEST_DATABASE_URL` isn't set in this environment, skip this step and note it as unverified in the session wrap — do not claim it passed without running it.

- [ ] **Step 3: Run postgres-repository.integration.test.mjs if a test database is available**

Run: `SIGIL_TEST_DATABASE_URL=... node --test sigil/relay/v1/postgres-repository.integration.test.mjs`
Expected: PASS if configured; otherwise this test is gated and skips (existing convention — do not treat a skip as a pass for the purposes of claiming full verification).

- [ ] **Step 4: Run the contracts validator one more time**

Run: `node sigil/contracts/v1/validate-contracts.mjs`
Expected: `Sigil v1 contracts valid`

- [ ] **Step 5: Commit (only if this step surfaced fixes)**

If Steps 1-4 are all clean, there is nothing to commit — this task is verification-only. If any step surfaces a bug, fix it, add a regression test, and commit that fix on its own with a message describing what full-suite regression testing caught.

---

## Self-Review Notes (author's own pass, not a task)

- **Spec coverage:** every §18 item (#8, #10, #13, #14, #19, #21, #22, #23) plus H is implemented by at least one task above; §3's cross-cutting transactional foundation is Tasks 5-6, reused by every workstream after B.
- **Placeholder scan:** no `TBD`/"add error handling"/"similar to Task N" patterns — every step has real code or an explicit "mirror this file's existing X pattern" instruction naming the exact pattern to mirror (used only for HTTP-route test scaffolding, where the existing test file's own helper is the correct source of truth and duplicating it inline would drift).
- **Type/name consistency checked:** `repository.persistAcceptedEnvelope(row, client)` (Task 6) is called consistently with a `client` second arg everywhere after Task 6; `acceptWithRepository`'s accumulated body (Tasks 6/8/11/13/14/18) is written as one coherent function at each step rather than fragments, so an executor reading Task 18 alone can see the full accreted shape it's modifying the tail of.
- **Known accepted limitation:** `memory-repository.mjs`'s `withTransaction` is a no-op passthrough (Task 6) — it gives the same *call signature* as `PostgresRepository` for dual-repository testing, but not the same rollback guarantee. Flagged explicitly in Task 15 rather than silently asserted as equivalent.
- **Known pre-existing gap, not fixed here:** `pg` is not declared in `sigil-repo`'s own `package.json`/lock (resolves today only because it's hoisted from `C:\dev\node_modules`). Out of scope for this design; flag to the user separately if `sigil-repo` is ever published or moved.

