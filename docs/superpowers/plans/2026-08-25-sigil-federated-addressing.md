# Sigil Federated Addressing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `endpoint_id`/`owner_id` domain-qualified (`ep_foo@relay.example.com`) and give a relay that knows its own domain a loud, immediate rejection for envelopes addressed to a different federation member, replacing today's silent accept-and-never-deliver.

**Architecture:** One new pure module (`sigil/relay/v1/federated-id.mjs`) owns all parsing/formatting/validation of the new ID shape. `sigil init` and `sigil relay up` each gain a `--domain` flag that calls into it. `validateEnvelope` gains one new check, gated on a `relayDomain` option threaded through `createRelayServer` → `acceptEnvelopeAsync` → `validateEnvelope`. Every other consumer of these IDs (Postgres schema, in-memory registry `Map`s, capability grants, directory-trust, transport-auth) needs zero changes — confirmed by a repo-wide survey that they all treat the ID as an opaque, exact-match string.

**Tech Stack:** Node.js (`node --test`, `node:assert/strict`, `node:dns/promises`, `node:util` `parseArgs`), no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-24-sigil-federated-addressing.md`

## Global Constraints

- Domain grammar: RFC 1035-style labels (letters/digits/hyphens, no underscores), dot-separated, max 253 chars total / 63 per label, ASCII only. Two literal exceptions valid without dots: `local` and `localhost`.
- Port: optional `:port`, numeric, 1–65535. No IPv6 literals.
- `local` is a reserved sentinel: skips DNS resolution entirely, matched by exact string comparison before grammar validation, never treated as a routable domain anywhere.
- Domain comparison (`isLocalDomain`) is case-insensitive and port-significant (`example.com` ≠ `example.com:443`). Local-part comparison stays case-sensitive everywhere. Nothing is ever canonicalized/lowercased at storage or formatting time — only at comparison time inside `isLocalDomain`.
- DNS resolution (`resolveDomainOrThrow`) runs only at `sigil init` time, strips the port before calling the resolver, and is bounded by an independent timer (same race pattern as `checkRelayConnectivity` in `sigil/cli/doctor.mjs:65-84`) so a non-cooperating resolver can't hang it.
- `sigil relay up --domain` validates syntax only via `parseDomain` — never calls `resolveDomainOrThrow`, no DNS at relay startup.
- No auto-migration: bare (non-`@`) IDs stay valid forever on relays with no configured domain; a domain-configured relay never accepts them.
- No forwarding of non-local envelopes — rejection only.

---

### Task 1: `federated-id.mjs` — parsing, formatting, locality (no DNS)

**Files:**
- Create: `sigil/relay/v1/federated-id.mjs`
- Test: `sigil/relay/v1/federated-id.test.mjs`

**Interfaces:**
- Produces: `parseDomain(domain)` → `{ host, port }` (`port` is `null` if absent), throws `Error` with `.code = 'INVALID_DOMAIN_SYNTAX'` or `.code = 'INVALID_PORT'`.
- Produces: `parseFederatedId(id)` → `{ localPart, domain }` (`domain` is the raw, unmodified domain substring), throws `Error` with `.code = 'MALFORMED_FEDERATED_ID'` (wrong `@` count or empty local part) or whatever `parseDomain` throws.
- Produces: `formatFederatedId({ localPart, domain })` → `` `${localPart}@${domain}` ``, no validation.
- Produces: `isLocalDomain(id, thisRelayDomain)` → `boolean`. Parses `id` via `parseFederatedId`; if that throws, returns `false` (a malformed ID is never local — callers that need to distinguish "malformed" from "foreign" call `parseFederatedId` themselves first, as Task 5 does).

- [ ] **Step 1: Write failing tests for `parseDomain`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDomain, parseFederatedId, formatFederatedId, isLocalDomain } from './federated-id.mjs';

test('parseDomain accepts a simple dotted hostname', () => {
  assert.deepEqual(parseDomain('relay.example.com'), { host: 'relay.example.com', port: null });
});

test('parseDomain accepts a hostname with a valid port', () => {
  assert.deepEqual(parseDomain('relay.example.com:8443'), { host: 'relay.example.com', port: 8443 });
});

test('parseDomain accepts the "local" sentinel without dots', () => {
  assert.deepEqual(parseDomain('local'), { host: 'local', port: null });
});

test('parseDomain accepts "localhost" without dots', () => {
  assert.deepEqual(parseDomain('localhost'), { host: 'localhost', port: null });
});

test('parseDomain rejects a bare label that is not local/localhost', () => {
  assert.throws(() => parseDomain('relay'), (error) => error.code === 'INVALID_DOMAIN_SYNTAX');
});

test('parseDomain rejects underscores', () => {
  assert.throws(() => parseDomain('relay_1.example.com'), (error) => error.code === 'INVALID_DOMAIN_SYNTAX');
});

test('parseDomain rejects a label over 63 characters', () => {
  const longLabel = 'a'.repeat(64);
  assert.throws(() => parseDomain(`${longLabel}.example.com`), (error) => error.code === 'INVALID_DOMAIN_SYNTAX');
});

test('parseDomain rejects a domain over 253 characters total', () => {
  const longDomain = Array.from({ length: 40 }, () => 'abcdefg').join('.') + '.com';
  assert.throws(() => parseDomain(longDomain), (error) => error.code === 'INVALID_DOMAIN_SYNTAX');
});

test('parseDomain rejects non-ASCII characters', () => {
  assert.throws(() => parseDomain('relay.exämple.com'), (error) => error.code === 'INVALID_DOMAIN_SYNTAX');
});

test('parseDomain rejects a non-numeric port', () => {
  assert.throws(() => parseDomain('relay.example.com:abc'), (error) => error.code === 'INVALID_PORT');
});

test('parseDomain rejects a port of 0', () => {
  assert.throws(() => parseDomain('relay.example.com:0'), (error) => error.code === 'INVALID_PORT');
});

test('parseDomain rejects a port over 65535', () => {
  assert.throws(() => parseDomain('relay.example.com:70000'), (error) => error.code === 'INVALID_PORT');
});
```

- [ ] **Step 2: Run tests, verify they fail with "not defined" / module-not-found**

Run: `node --test sigil/relay/v1/federated-id.test.mjs`
Expected: FAIL — `federated-id.mjs` does not exist yet.

- [ ] **Step 3: Implement `parseDomain`**

```js
const LABEL = /^[a-zA-Z0-9-]{1,63}$/;

export function parseDomain(domain) {
  if (typeof domain !== 'string' || domain.length === 0) {
    throw Object.assign(new Error('Domain must be a non-empty string'), { code: 'INVALID_DOMAIN_SYNTAX' });
  }
  const colonIndex = domain.lastIndexOf(':');
  const hasPort = colonIndex !== -1;
  const host = hasPort ? domain.slice(0, colonIndex) : domain;
  const portRaw = hasPort ? domain.slice(colonIndex + 1) : null;

  if (host.length === 0 || host.length > 253) {
    throw Object.assign(new Error(`Invalid domain "${domain}": host must be 1-253 characters`), { code: 'INVALID_DOMAIN_SYNTAX' });
  }
  if (!/^[\x00-\x7F]*$/.test(host)) {
    throw Object.assign(new Error(`Invalid domain "${domain}": ASCII only in v1 (no IDNA/punycode)`), { code: 'INVALID_DOMAIN_SYNTAX' });
  }
  if (host === 'local' || host === 'localhost') {
    // no-op: these two are valid without dots, checked below
  } else {
    const labels = host.split('.');
    if (labels.length < 2 || labels.some((label) => !LABEL.test(label))) {
      throw Object.assign(new Error(`Invalid domain "${domain}": must be a dotted hostname, or the literal "local"/"localhost"`), { code: 'INVALID_DOMAIN_SYNTAX' });
    }
  }

  let port = null;
  if (hasPort) {
    if (!/^[0-9]+$/.test(portRaw)) {
      throw Object.assign(new Error(`Invalid port "${portRaw}" in domain "${domain}": must be numeric`), { code: 'INVALID_PORT' });
    }
    port = Number(portRaw);
    if (port < 1 || port > 65535) {
      throw Object.assign(new Error(`Invalid port ${port} in domain "${domain}": must be 1-65535`), { code: 'INVALID_PORT' });
    }
  }

  return { host, port };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test sigil/relay/v1/federated-id.test.mjs`
Expected: PASS on all `parseDomain` tests.

- [ ] **Step 5: Write failing tests for `parseFederatedId` and `formatFederatedId`**

```js
test('parseFederatedId splits local-part and domain', () => {
  assert.deepEqual(parseFederatedId('ep_codex@relay.example.com'), { localPart: 'ep_codex', domain: 'relay.example.com' });
});

test('parseFederatedId rejects an id with no @', () => {
  assert.throws(() => parseFederatedId('ep_codex'), (error) => error.code === 'MALFORMED_FEDERATED_ID');
});

test('parseFederatedId rejects an id with multiple @', () => {
  assert.throws(() => parseFederatedId('ep_codex@relay@example.com'), (error) => error.code === 'MALFORMED_FEDERATED_ID');
});

test('parseFederatedId rejects an empty local part', () => {
  assert.throws(() => parseFederatedId('@relay.example.com'), (error) => error.code === 'MALFORMED_FEDERATED_ID');
});

test('parseFederatedId rejects an empty domain', () => {
  assert.throws(() => parseFederatedId('ep_codex@'), (error) => error.code === 'MALFORMED_FEDERATED_ID');
});

test('parseFederatedId propagates a bad domain as INVALID_DOMAIN_SYNTAX', () => {
  assert.throws(() => parseFederatedId('ep_codex@relay_1.example.com'), (error) => error.code === 'INVALID_DOMAIN_SYNTAX');
});

test('formatFederatedId joins local-part and domain', () => {
  assert.equal(formatFederatedId({ localPart: 'ep_codex', domain: 'relay.example.com' }), 'ep_codex@relay.example.com');
});

test('formatFederatedId round-trips through parseFederatedId', () => {
  const id = formatFederatedId({ localPart: 'ep_codex', domain: 'relay.example.com:8443' });
  assert.deepEqual(parseFederatedId(id), { localPart: 'ep_codex', domain: 'relay.example.com:8443' });
});
```

- [ ] **Step 6: Run tests, verify they fail**

Run: `node --test sigil/relay/v1/federated-id.test.mjs`
Expected: FAIL — `parseFederatedId`/`formatFederatedId` not defined.

- [ ] **Step 7: Implement `parseFederatedId` and `formatFederatedId`**

```js
export function parseFederatedId(id) {
  if (typeof id !== 'string') {
    throw Object.assign(new Error('Federated id must be a string'), { code: 'MALFORMED_FEDERATED_ID' });
  }
  const parts = id.split('@');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw Object.assign(new Error(`Malformed federated id "${id}": expected exactly one "@" with a non-empty local part and domain`), { code: 'MALFORMED_FEDERATED_ID' });
  }
  const [localPart, domain] = parts;
  parseDomain(domain); // throws INVALID_DOMAIN_SYNTAX / INVALID_PORT on a bad domain
  return { localPart, domain };
}

export function formatFederatedId({ localPart, domain }) {
  return `${localPart}@${domain}`;
}
```

- [ ] **Step 8: Run tests, verify they pass**

Run: `node --test sigil/relay/v1/federated-id.test.mjs`
Expected: PASS on all `parseFederatedId`/`formatFederatedId` tests.

- [ ] **Step 9: Write failing tests for `isLocalDomain`**

```js
test('isLocalDomain is true when domains match exactly', () => {
  assert.equal(isLocalDomain('ep_codex@relay.example.com', 'relay.example.com'), true);
});

test('isLocalDomain is case-insensitive on the domain', () => {
  assert.equal(isLocalDomain('ep_codex@RELAY.EXAMPLE.COM', 'relay.example.com'), true);
});

test('isLocalDomain is false for a different domain', () => {
  assert.equal(isLocalDomain('ep_codex@other.example.com', 'relay.example.com'), false);
});

test('isLocalDomain treats a present port as significant', () => {
  assert.equal(isLocalDomain('ep_codex@relay.example.com:443', 'relay.example.com'), false);
});

test('isLocalDomain matches when host and port both match, regardless of host case', () => {
  assert.equal(isLocalDomain('ep_codex@RELAY.example.com:443', 'relay.example.com:443'), true);
});

test('isLocalDomain returns false, not a throw, for a malformed id', () => {
  assert.equal(isLocalDomain('ep_codex', 'relay.example.com'), false);
});

test('isLocalDomain never treats local-part case as relevant to locality, but the local part is preserved verbatim by parse/format', () => {
  assert.equal(isLocalDomain('EP_Codex@relay.example.com', 'relay.example.com'), true);
  assert.equal(parseFederatedId('EP_Codex@relay.example.com').localPart, 'EP_Codex');
});
```

- [ ] **Step 10: Run tests, verify they fail**

Run: `node --test sigil/relay/v1/federated-id.test.mjs`
Expected: FAIL — `isLocalDomain` not defined.

- [ ] **Step 11: Implement `isLocalDomain`**

```js
export function isLocalDomain(id, thisRelayDomain) {
  let parsed;
  try {
    parsed = parseFederatedId(id);
  } catch {
    return false;
  }
  return parsed.domain.toLowerCase() === thisRelayDomain.toLowerCase();
}
```

- [ ] **Step 12: Run the full file's tests, verify all pass**

Run: `node --test sigil/relay/v1/federated-id.test.mjs`
Expected: PASS, all tests green.

- [ ] **Step 13: Commit**

```bash
git add sigil/relay/v1/federated-id.mjs sigil/relay/v1/federated-id.test.mjs
git commit -m "feat(sigil): add federated-id parsing/formatting/locality module"
```

---

### Task 2: `resolveDomainOrThrow` — bounded, port-stripping DNS check

**Files:**
- Modify: `sigil/relay/v1/federated-id.mjs`
- Test: `sigil/relay/v1/federated-id.test.mjs`

**Interfaces:**
- Consumes: nothing new from Task 1 beyond the same file.
- Produces: `resolveDomainOrThrow(domain, { timeoutMs = 5000, lookupImpl = dns.promises.lookup } = {})` → `Promise<void>` on success; throws `Error` with `.code` ∈ `DNS_NOT_FOUND` / `DNS_TIMEOUT` / `DNS_LOOKUP_FAILED`, plus `.domain` and `.timeoutMs` fields, and (for `DNS_LOOKUP_FAILED`) `.cause` set to the original error. Special-cases `domain === 'local'`: returns immediately, never calls `lookupImpl`.

- [ ] **Step 1: Write failing tests**

```js
test('resolveDomainOrThrow resolves without throwing when lookupImpl succeeds', async () => {
  await assert.doesNotReject(resolveDomainOrThrow('relay.example.com', {
    lookupImpl: async (host) => { assert.equal(host, 'relay.example.com'); return { address: '10.0.0.1' }; },
  }));
});

test('resolveDomainOrThrow strips the port before calling lookupImpl', async () => {
  let receivedHost;
  await resolveDomainOrThrow('relay.example.com:8443', {
    lookupImpl: async (host) => { receivedHost = host; return { address: '10.0.0.1' }; },
  });
  assert.equal(receivedHost, 'relay.example.com');
});

test('resolveDomainOrThrow skips lookupImpl entirely for the "local" sentinel', async () => {
  let called = false;
  await resolveDomainOrThrow('local', { lookupImpl: async () => { called = true; return {}; } });
  assert.equal(called, false);
});

test('resolveDomainOrThrow classifies ENOTFOUND as DNS_NOT_FOUND with structured fields', async () => {
  await assert.rejects(
    resolveDomainOrThrow('nowhere.example.com', {
      lookupImpl: async () => { throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); },
    }),
    (error) => error.code === 'DNS_NOT_FOUND' && error.domain === 'nowhere.example.com' && error.timeoutMs === 5000,
  );
});

test('resolveDomainOrThrow classifies an unrelated lookup failure as DNS_LOOKUP_FAILED with cause', async () => {
  const original = new Error('boom');
  await assert.rejects(
    resolveDomainOrThrow('relay.example.com', { lookupImpl: async () => { throw original; } }),
    (error) => error.code === 'DNS_LOOKUP_FAILED' && error.cause === original,
  );
});

test('resolveDomainOrThrow times out instead of hanging when lookupImpl never settles', async () => {
  await assert.rejects(
    resolveDomainOrThrow('relay.example.com', { timeoutMs: 20, lookupImpl: () => new Promise(() => {}) }),
    (error) => error.code === 'DNS_TIMEOUT' && error.timeoutMs === 20,
  );
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test sigil/relay/v1/federated-id.test.mjs`
Expected: FAIL — `resolveDomainOrThrow` not defined.

- [ ] **Step 3: Implement `resolveDomainOrThrow`**

Add to the top of `federated-id.mjs`:

```js
import dns from 'node:dns';
```

Append to the file:

```js
export async function resolveDomainOrThrow(domain, { timeoutMs = 5000, lookupImpl = dns.promises.lookup } = {}) {
  if (domain === 'local') return;
  const colonIndex = domain.lastIndexOf(':');
  const host = colonIndex !== -1 ? domain.slice(0, colonIndex) : domain;

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      lookupImpl(host).then((result) => ({ result })),
      timeout,
    ]);
    if (outcome.timedOut) {
      throw Object.assign(new Error(`DNS lookup for "${host}" did not resolve within ${timeoutMs}ms`), { code: 'DNS_TIMEOUT', domain, timeoutMs });
    }
  } catch (error) {
    if (error.code === 'DNS_TIMEOUT') throw error;
    if (error.code === 'ENOTFOUND') {
      throw Object.assign(new Error(`Domain "${host}" does not resolve`), { code: 'DNS_NOT_FOUND', domain, timeoutMs });
    }
    throw Object.assign(new Error(`DNS lookup for "${host}" failed: ${error.message}`), { code: 'DNS_LOOKUP_FAILED', domain, timeoutMs, cause: error });
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test sigil/relay/v1/federated-id.test.mjs`
Expected: PASS, all tests including the new `resolveDomainOrThrow` ones.

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/federated-id.mjs sigil/relay/v1/federated-id.test.mjs
git commit -m "feat(sigil): add resolveDomainOrThrow with bounded, port-stripping DNS check"
```

---

### Task 3: `sigil init --domain` wiring

**Files:**
- Modify: `sigil/cli/sigil.mjs:71-84` (`cmdInit`)
- Modify: `sigil/cli/sigil.mjs:35-53` (`usage()`)
- Test: `sigil/cli/init-domain.test.mjs` (new — CLI-level, spawns the real `sigil` entrypoint, matching the pattern already used in `cli-wrappers.test.mjs` at the repo root)

**Interfaces:**
- Consumes: `parseDomain`, `resolveDomainOrThrow` from `sigil/relay/v1/federated-id.mjs` (Tasks 1-2).
- Produces: `cmdInit` now accepts `--domain <domain>` (optional, default `local`) and validates `<name>` against `/^[a-z0-9_-]+$/`. On success, `identity.owner_id`/`identity.endpoint_id` are `usr_${name}@${domain}` / `ep_${name}@${domain}`.

- [ ] **Step 1: Write the failing CLI test**

```js
// sigil/cli/init-domain.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');

function runInit(args, cwd) {
  return execFileSync(process.execPath, [sigilCli, 'init', ...args], { cwd, encoding: 'utf8' });
}

function tmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-init-domain-test-'));
}

function readIdentity(cwd, name) {
  return JSON.parse(fs.readFileSync(path.join(cwd, '.sigil', `${name}.identity.json`), 'utf8'));
}

test('sigil init with no --domain defaults to the "local" sentinel', () => {
  const cwd = tmpCwd();
  try {
    runInit(['alice'], cwd);
    const identity = readIdentity(cwd, 'alice');
    assert.equal(identity.endpoint_id, 'ep_alice@local');
    assert.equal(identity.owner_id, 'usr_alice@local');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('sigil init --domain rejects a bad domain and writes no identity file', () => {
  const cwd = tmpCwd();
  try {
    assert.throws(() => runInit(['alice', '--domain', 'not a domain!'], cwd));
    assert.equal(fs.existsSync(path.join(cwd, '.sigil', 'alice.identity.json')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('sigil init rejects a name with a disallowed character', () => {
  const cwd = tmpCwd();
  try {
    assert.throws(() => runInit(['ali@ce'], cwd));
    assert.equal(fs.existsSync(path.join(cwd, '.sigil')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('sigil init --domain aborts identity creation when the domain does not resolve', () => {
  // "nonexistent.invalid" uses the .invalid TLD reserved by RFC 2606 --
  // guaranteed to never resolve, so this is a real, deterministic DNS
  // failure without needing to reach the live internet or mock a resolver.
  const cwd = tmpCwd();
  try {
    assert.throws(() => runInit(['alice', '--domain', 'nonexistent.invalid'], cwd));
    assert.equal(fs.existsSync(path.join(cwd, '.sigil', 'alice.identity.json')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --test sigil/cli/init-domain.test.mjs`
Expected: FAIL — `endpoint_id` is `ep_alice`, not `ep_alice@local` (current behavior has no domain suffix at all).

- [ ] **Step 3: Implement the flag and validation in `cmdInit`**

Owner validation is part of this task, not a follow-up: supplied `--owner` values are complete federated IDs. `parseFederatedId` handles malformed/bare values; `isLocalDomain` mismatch becomes `OWNER_DOMAIN_MISMATCH`. Both failures occur before `saveIdentity` and `addEndpointToRegistry`.

Replace `sigil/cli/sigil.mjs:71-84`:

```js
const NAME_CHARSET = /^[a-z0-9_-]+$/;

async function cmdInit(argv) {
  const args = parseArgs({ args: argv, options: { owner: { type: 'string' }, registry: { type: 'string' }, kind: { type: 'string' }, domain: { type: 'string' } }, allowPositionals: true });
  const name = args.positionals[0];
  if (!name) throw new Error('usage: sigil init <name> --owner <owner_id> [--domain domain]');
  if (!NAME_CHARSET.test(name)) throw new Error(`sigil init: <name> "${name}" must match ${NAME_CHARSET} (it becomes the federated id's local part)`);
  const domain = opt(args, ['domain']) ?? 'local';
  const { parseDomain, parseFederatedId, isLocalDomain, resolveDomainOrThrow } = await import('../relay/v1/federated-id.mjs');
  parseDomain(domain);
  if (domain !== 'local') await resolveDomainOrThrow(domain);
  const owner = opt(args, ['owner']) ?? `usr_${name}@${domain}`;
  if (opt(args, ['owner']) !== undefined) {
    parseFederatedId(owner);
    if (!isLocalDomain(owner, domain)) throw Object.assign(new Error(`sigil init: --owner domain must match --domain`), { code: 'OWNER_DOMAIN_MISMATCH' });
  }
  const registryPath = opt(args, ['registry']) ?? DEFAULT_REGISTRY;
  const identityPath = path.join('.sigil', `${name}.identity.json`);
  const identity = createIdentity({ ownerId: owner, endpointId: `ep_${name}@${domain}`, kind: opt(args, ['kind']) ?? 'human' });
  saveIdentity(identityPath, identity);
  addEndpointToRegistry(registryPath, identity);
  console.log(`Created identity: ${identityPath}`);
  console.log(`Registered ${identity.endpoint_id} (owner ${identity.owner_id}) in ${registryPath}`);
  console.log(`\nKeep ${identityPath} private -- it holds this endpoint's private key and tokens.`);
}
```

Update the usage string in `sigil/cli/sigil.mjs:39` (inside `usage()`):

```
  init <name> --owner <owner_id> [--registry path] [--domain domain]      Create a local identity and register it (domain defaults to "local")
```

- [ ] **Step 4: Run test, verify it passes**

Run: `node --test sigil/cli/init-domain.test.mjs`
Expected: PASS, all four tests green.

- [ ] **Step 5: Run the full existing test suite to check for regressions**

Run: `node --test`
Expected: PASS. Note: any existing test that hardcodes an expected `ep_<name>`/`usr_<name>` string produced by an actual `sigil init` invocation (as opposed to a fixture literal like `ep_codex` built directly, which is untouched) will now see `@local` appended -- if any such test fails, update its expected string to match (this is the one place callers of `cmdInit` see behavior change; every other test in the suite builds its own fixture IDs directly and is unaffected, per the survey in the spec).

- [ ] **Step 6: Commit**

```bash
git add sigil/cli/sigil.mjs sigil/cli/init-domain.test.mjs
git commit -m "feat(sigil): add --domain flag to sigil init, domain-qualify generated ids"
```

---

### Task 4: `sigil relay up --domain` wiring (syntax-only, no DNS)

**Files:**
- Modify: `sigil/cli/sigil.mjs:106-183` (`cmdRelayUp`)
- Modify: `sigil/cli/sigil.mjs:35-53` (`usage()`)
- Modify: `sigil/relay/v1/http-server.mjs` (`createRelayServer` signature)
- Test: `sigil/cli/relay-up-domain.test.mjs` (new — CLI-level, mirrors Task 3's pattern)

**Interfaces:**
- Consumes: `parseDomain` from Task 1.
- Produces: `createRelayServer({ ..., relayDomain })` — new optional param, `undefined` by default, threaded through unchanged to every existing caller.

- [ ] **Step 1: Write the failing CLI test**

```js
// sigil/cli/relay-up-domain.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const sigilCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');

function tmpCwdWithRegistry() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-relay-domain-test-'));
  execFileSync(process.execPath, [sigilCli, 'init', 'alice'], { cwd, encoding: 'utf8' });
  return cwd;
}

test('sigil relay up rejects a malformed --domain before binding a port', () => {
  const cwd = tmpCwdWithRegistry();
  try {
    assert.throws(
      () => execFileSync(process.execPath, [sigilCli, 'relay', 'up', '--port', '0', '--domain', 'not a domain!'], { cwd, encoding: 'utf8', timeout: 5000 }),
      (error) => /INVALID_DOMAIN_SYNTAX|sigil: /.test(String(error.stderr ?? error.message)),
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('sigil relay up starts successfully with a syntactically valid --domain', async () => {
  const cwd = tmpCwdWithRegistry();
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [sigilCli, 'relay', 'up', '--port', '0', '--domain', 'relay.example.com'], { cwd });
  try {
    const listening = await new Promise((resolve, reject) => {
      let output = '';
      const onData = (chunk) => {
        output += chunk;
        if (output.includes('Sigil relay listening on')) { child.stdout.off('data', onData); resolve(true); }
      };
      child.stdout.on('data', onData);
      child.on('exit', (code) => reject(new Error(`sigil relay up exited early with code ${code}: ${output}`)));
      setTimeout(() => reject(new Error(`timed out waiting for relay to start: ${output}`)), 5000);
    });
    assert.equal(listening, true);
  } finally {
    child.kill();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test sigil/cli/relay-up-domain.test.mjs`
Expected: FAIL — `--domain` is not a recognized flag yet (`parseArgs` will throw an unrecognized-option error for the first test; the second test will fail because the relay starts but nothing validated the flag, or because `--domain` being unrecognized crashes startup entirely — either way, not the specific `INVALID_DOMAIN_SYNTAX` behavior being tested).

- [ ] **Step 3: Add `relayDomain` to `createRelayServer`'s signature**

In `sigil/relay/v1/http-server.mjs`, find the `createRelayServer` destructured parameter list (starts `export function createRelayServer({ registry, idempotency = new Map(), ...`) and add `relayDomain` to it:

```js
export function createRelayServer({ registry, idempotency = new Map(), lookupIdempotency, persist, repository, authenticate, tokenHashes, now: configuredNow = () => new Date(), stream, relayOrigin, rpId, approvalChallenges = new Map(), maxPendingApprovals = 100, oidcIssuerAllowList = new Set(), lookupHumanCredential, verifyAssertion, enableMockOidc = false, oidcFetchImpl = fetch, relayDomain } = {}) {
```

(`relayDomain` is deliberately given no default — `undefined` is the "no federation" state, checked explicitly by Task 5's code.)

- [ ] **Step 4: Add `--domain` flag and validation to `cmdRelayUp`**

In `sigil/cli/sigil.mjs`, modify the `parseArgs` options object and add validation right after the existing `oidcIssuerRefreshIntervalMs` validation block (`sigil/cli/sigil.mjs:107-117`):

```js
async function cmdRelayUp(argv) {
  const args = parseArgs({ args: argv, options: { registry: { type: 'string' }, port: { type: 'string' }, 'stream-port': { type: 'string' }, 'database-url': { type: 'string' }, 'enable-mock-oidc': { type: 'boolean' }, 'oidc-issuer-refresh-interval-ms': { type: 'string' }, domain: { type: 'string' } } });
  const registryPath = opt(args, ['registry']) ?? DEFAULT_REGISTRY;
  const port = Number(opt(args, ['port']) ?? 0);
  const streamPort = Number(opt(args, ['stream-port']) ?? (port ? port + 1 : 0));
  const databaseUrl = opt(args, ['database-url']) ?? process.env.SIGIL_DATABASE_URL;
  const enableMockOidc = Boolean(args.values['enable-mock-oidc']) || process.env.SIGIL_ENABLE_MOCK_OIDC === '1';
  const oidcIssuerRefreshIntervalMsRaw = opt(args, ['oidc-issuer-refresh-interval-ms']);
  const oidcIssuerRefreshIntervalMs = oidcIssuerRefreshIntervalMsRaw === undefined ? 30_000 : Number(oidcIssuerRefreshIntervalMsRaw);
  if (!Number.isInteger(oidcIssuerRefreshIntervalMs) || oidcIssuerRefreshIntervalMs <= 0) {
    throw new Error(`--oidc-issuer-refresh-interval-ms must be a positive integer, got "${oidcIssuerRefreshIntervalMsRaw}"`);
  }
  const relayDomain = opt(args, ['domain']);
  if (relayDomain !== undefined) {
    const { parseDomain } = await import('../relay/v1/federated-id.mjs');
    parseDomain(relayDomain); // throws INVALID_DOMAIN_SYNTAX / INVALID_PORT before anything else runs
  }
```

(the rest of `cmdRelayUp`'s body is unchanged up to the `createRelayServer(...)` call at `sigil/cli/sigil.mjs:174`, which becomes:)

```js
  server = createRelayServer({ registry, repository, tokenHashes, stream, relayOrigin, enableMockOidc, oidcIssuerAllowList, relayDomain });
```

Update the usage string in `sigil/cli/sigil.mjs:40` (inside `usage()`):

```
  relay up [--registry path] [--port N] [--enable-mock-oidc] [--oidc-issuer-refresh-interval-ms N] [--domain domain] Run a local relay (blocks; Ctrl+C to stop)
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `node --test sigil/cli/relay-up-domain.test.mjs`
Expected: PASS, both tests green.

- [ ] **Step 6: Run the full existing test suite to check for regressions**

Run: `node --test`
Expected: PASS — `relayDomain` is optional and unused by every existing `createRelayServer(...)` call site, so nothing else changes behavior.

- [ ] **Step 7: Commit**

```bash
git add sigil/cli/sigil.mjs sigil/relay/v1/http-server.mjs sigil/cli/relay-up-domain.test.mjs
git commit -m "feat(sigil): add --domain flag to sigil relay up (syntax validation only, no DNS)"
```

---

### Task 5: Accept-time recipient-locality check

**Files:**
- Modify: `sigil/relay/v1/accept-envelope.mjs:11-26` (`statusByCode`)
- Modify: `sigil/relay/v1/validate-envelope.mjs:39-84` (`validateEnvelope`)
- Modify: `sigil/relay/v1/http-server.mjs` (`/v1/envelopes` handler — thread `relayDomain` into the options object passed to `acceptEnvelopeAsync`)
- Test: `sigil/relay/v1/validate-envelope.test.mjs` (unit)
- Test: `sigil/relay/v1/http-server.test.mjs` (integration)

**Interfaces:**
- Consumes: `parseFederatedId`, `isLocalDomain` from `sigil/relay/v1/federated-id.mjs` (Task 1).
- Produces: `validateEnvelope(envelope, { ..., relayDomain })` — when `relayDomain` is set and `envelope.recipient` is present, throws `MALFORMED_FEDERATED_ID` (400) for a bare/malformed `recipient.endpoint_id`, or `RECIPIENT_NOT_LOCAL` (400, `details: { recipientDomain, relayDomain }`) for a well-formed but foreign-domain one. Unchanged when `relayDomain` is `undefined`, or when the envelope is a broadcast (no `recipient`).

- [ ] **Step 1: Write the failing unit tests**

Add to `sigil/relay/v1/validate-envelope.test.mjs` (after the existing tests, using the same `base`/`options`/`privateKey` fixtures already defined at the top of that file):

```js
test('accepts a federated recipient whose domain matches relayDomain', () => {
  const candidate = structuredClone(base);
  candidate.recipient = { endpoint_id: 'ep_claude@relay.example.com', owner_id: 'usr_claude_owner' };
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  assert.equal(validateEnvelope(candidate, { ...options, relayDomain: 'relay.example.com' }).accepted, true);
});

test('rejects a federated recipient on a different domain with RECIPIENT_NOT_LOCAL', () => {
  const candidate = structuredClone(base);
  candidate.recipient = { endpoint_id: 'ep_claude@other.example.com', owner_id: 'usr_claude_owner' };
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  assert.throws(
    () => validateEnvelope(candidate, { ...options, relayDomain: 'relay.example.com' }),
    (error) => error.code === 'RECIPIENT_NOT_LOCAL' && error.details.recipientDomain === 'other.example.com' && error.details.relayDomain === 'relay.example.com',
  );
});

test('rejects a bare recipient on a domain-configured relay with MALFORMED_FEDERATED_ID', () => {
  const candidate = structuredClone(base);
  candidate.recipient = { endpoint_id: 'ep_claude', owner_id: 'usr_claude_owner' };
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  assert.throws(
    () => validateEnvelope(candidate, { ...options, relayDomain: 'relay.example.com' }),
    (error) => error.code === 'MALFORMED_FEDERATED_ID',
  );
});

test('accepts a bare recipient unchanged when relayDomain is not set (legacy/non-federated relay)', () => {
  const candidate = structuredClone(base);
  candidate.recipient = { endpoint_id: 'ep_claude', owner_id: 'usr_claude_owner' };
  candidate.signature.value = crypto.sign(null, signedBytes(candidate), privateKey).toString('base64url');
  assert.equal(validateEnvelope(candidate, options).accepted, true);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test sigil/relay/v1/validate-envelope.test.mjs`
Expected: FAIL — the two new rejection tests currently succeed instead of throwing (no check exists yet), so `assert.throws` fails; the acceptance tests should already pass (nothing checks recipient locality today), confirming they're not accidentally red for the wrong reason.

- [ ] **Step 3: Implement the check in `validateEnvelope`**

Add the import at the top of `sigil/relay/v1/validate-envelope.mjs`:

```js
import { parseFederatedId, isLocalDomain } from './federated-id.mjs';
```

Insert into `validateEnvelope`, immediately after the existing `hasRecipient`/`hasBroadcast` block (`sigil/relay/v1/validate-envelope.mjs:68-71`):

```js
  const hasRecipient = Boolean(envelope.recipient);
  const hasBroadcast = Boolean(envelope.broadcast_scope);
  if (hasRecipient === hasBroadcast) throw reject('INVALID_ENVELOPE', 'Exactly one recipient or broadcast scope is required');
  if (hasRecipient && relayDomain) {
    let recipientId;
    try {
      recipientId = parseFederatedId(envelope.recipient.endpoint_id);
    } catch {
      throw reject('MALFORMED_FEDERATED_ID', `recipient.endpoint_id "${envelope.recipient.endpoint_id}" is not a well-formed federated id, required by this relay's --domain configuration`, { recipient_endpoint_id: envelope.recipient.endpoint_id });
    }
    if (!isLocalDomain(envelope.recipient.endpoint_id, relayDomain)) {
      throw reject('RECIPIENT_NOT_LOCAL', `recipient domain "${recipientId.domain}" does not match this relay's domain "${relayDomain}"`, { recipientDomain: recipientId.domain, relayDomain });
    }
  }
  if (hasBroadcast && (typeof broadcastAuthorizer !== 'function' || !broadcastAuthorizer(envelope.broadcast_scope, envelope))) throw reject('ROUTE_NOT_AUTHORIZED', 'Broadcast scope is not authorized for this conversation');
```

And add `relayDomain` to `validateEnvelope`'s destructured options (`sigil/relay/v1/validate-envelope.mjs:39`):

```js
export function validateEnvelope(envelope, { now = new Date(), registered = new Map(), idempotency = new Map(), broadcastAuthorizer, requiresApproval, approvedActionHashes = new Set(), capabilityGrants: capabilityGrants_ = [], relayDomain } = {}) {
```

Add the two new codes to `statusByCode` in `sigil/relay/v1/accept-envelope.mjs:11-26`:

```js
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
  QUOTA_EXCEEDED: 429,
  DIRECTORY_LINK_REQUIRED: 403,
  MALFORMED_FEDERATED_ID: 400,
  RECIPIENT_NOT_LOCAL: 400
});
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test sigil/relay/v1/validate-envelope.test.mjs`
Expected: PASS, all tests including the four new ones.

- [ ] **Step 5: Thread `relayDomain` through the `/v1/envelopes` handler**

In `sigil/relay/v1/http-server.mjs`, find the `POST /v1/envelopes` handler (around line 212, `const result = await acceptEnvelopeAsync(envelope, { registered: registry, ... })`) and add `relayDomain` to the options object:

```js
      const result = await acceptEnvelopeAsync(envelope, {
        registered: registry, request_id: requestId, now, repository, relayDomain,
        onPersisted: async ({ envelope: accepted, persisted }) => {
```

(`relayDomain` is already in scope here — it's one of `createRelayServer`'s destructured parameters from Task 4's Step 3 — and flows unchanged through `acceptEnvelopeAsync` → `acceptWithRepository`/legacy path → `validateEnvelope`, since every intermediate call spreads `options` rather than allowlisting its keys, confirmed by reading `sigil/relay/v1/accept-envelope.mjs:128` and `:162`.)

- [ ] **Step 6: Write the failing integration tests**

Add to `sigil/relay/v1/http-server.test.mjs` (near the existing envelope-acceptance tests; reuse the file's existing `request()` helper and the `crypto.generateKeyPairSync('ed25519')` + `signedBytes` + fixture-loading pattern already used throughout the file):

```js
test('a relay with --domain configured rejects a foreign-domain recipient with RECIPIENT_NOT_LOCAL', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  envelope.created_at = '2026-08-25T12:00:00.000Z'; envelope.expires_at = '2026-08-25T13:00:00.000Z';
  envelope.recipient = { endpoint_id: 'ep_claude@other.example.com', owner_id: 'usr_claude_owner' };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  const server = createRelayServer({
    registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]),
    persist: () => {}, now: new Date('2026-08-25T12:01:00Z'), relayDomain: 'relay.example.com',
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/envelopes', body: envelope });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'RECIPIENT_NOT_LOCAL');
  assert.equal(result.body.details.recipientDomain, 'other.example.com');
  assert.equal(result.body.details.relayDomain, 'relay.example.com');
});

test('a relay with --domain configured rejects a bare recipient with MALFORMED_FEDERATED_ID', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  envelope.created_at = '2026-08-25T12:00:00.000Z'; envelope.expires_at = '2026-08-25T13:00:00.000Z';
  envelope.recipient = { endpoint_id: 'ep_claude', owner_id: 'usr_claude_owner' };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  const server = createRelayServer({
    registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]),
    persist: () => {}, now: new Date('2026-08-25T12:01:00Z'), relayDomain: 'relay.example.com',
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/envelopes', body: envelope });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'MALFORMED_FEDERATED_ID');
});

test('a relay with no --domain still accepts a bare legacy recipient unchanged (regression)', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  envelope.created_at = '2026-08-25T12:00:00.000Z'; envelope.expires_at = '2026-08-25T13:00:00.000Z';
  envelope.recipient = { endpoint_id: 'ep_claude', owner_id: 'usr_claude_owner' };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  const server = createRelayServer({
    registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]),
    persist: () => {}, now: new Date('2026-08-25T12:01:00Z'),
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/envelopes', body: envelope });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 202);
});

test('local-part case is significant: ep_Foo@x.com and ep_foo@x.com are distinct recipients through the real accept path', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  envelope.created_at = '2026-08-25T12:00:00.000Z'; envelope.expires_at = '2026-08-25T13:00:00.000Z';
  envelope.recipient = { endpoint_id: 'ep_Foo@relay.example.com', owner_id: 'usr_claude_owner' };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  let persistedRecipient;
  const server = createRelayServer({
    registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]),
    persist: ({ envelope: accepted }) => { persistedRecipient = accepted.recipient.endpoint_id; },
    now: new Date('2026-08-25T12:01:00Z'), relayDomain: 'relay.example.com',
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/envelopes', body: envelope });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 202);
  // proves the exact-case string reached persistence unmodified -- a lowercased
  // "ep_foo@relay.example.com" here would silently merge two distinct endpoints.
  assert.equal(persistedRecipient, 'ep_Foo@relay.example.com');
});
```

- [ ] **Step 7: Run tests, verify they pass**

Run: `node --test sigil/relay/v1/http-server.test.mjs`
Expected: PASS, all tests including the four new ones (41 existing + 4 new).

- [ ] **Step 8: Run the full existing test suite to check for regressions**

Run: `node --test`
Expected: PASS. This is the highest-blast-radius task in the plan (it touches the shared `validateEnvelope`/`acceptEnvelopeAsync` path every envelope flows through) — confirm the full suite (592+ tests per the last full run) is still green, not just the two files touched directly.

- [ ] **Step 9: Commit**

```bash
git add sigil/relay/v1/accept-envelope.mjs sigil/relay/v1/validate-envelope.mjs sigil/relay/v1/validate-envelope.test.mjs sigil/relay/v1/http-server.mjs sigil/relay/v1/http-server.test.mjs
git commit -m "feat(sigil): reject mis-addressed envelopes at accept time (MALFORMED_FEDERATED_ID, RECIPIENT_NOT_LOCAL)"
```

---

### Task 6: Update the roadmap doc

**Files:**
- Modify: `docs/meta/sigil-cli-roadmap.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Mark federated addressing (sub-project #1) as landed**

In the "Future direction: H2H / A2H / multi-agent group chats" and the earlier "Other future candidates" sections' surrounding context is unrelated; instead, find wherever `docs/meta/sigil-cli-roadmap.md` currently lists federation sub-project #1 (addressing) as a candidate (added in commits `4832d79`/`c975920`/`65c2f52`/`e3da232` this session) and mark it done, referencing the spec and this plan, in the same style as the existing "done, landed 2026-08-24" entries elsewhere in the file (e.g. the `sigil oidc-issuer list/remove` entry). State plainly: `endpoint_id`/`owner_id` are now optionally domain-qualified via `--domain` on `sigil init`/`sigil relay up`; a domain-configured relay rejects foreign-domain and malformed recipients at accept time; sub-projects #2 (inter-relay trust/discovery), #3 (routing), #4 (cross-federation directory), #5 (operational tooling) remain unbuilt and unspec'd.

- [ ] **Step 2: Commit**

```bash
git add docs/meta/sigil-cli-roadmap.md
git commit -m "docs(sigil): mark federated addressing sub-project as landed"
```

