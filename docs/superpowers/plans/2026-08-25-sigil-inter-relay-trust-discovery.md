# Sigil Inter-Relay Trust/Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a relay operator a way to discover a foreign domain's relay endpoint + signing keys over HTTPS (`.well-known/sigil`), and durably pin that trust (TOFU, with fail-closed key-rotation detection) via a new `sigil peer` CLI surface. No envelope forwarding — that's sub-project #3.

**Architecture:** A new pure-ish module, `sigil/relay/v1/peer-discovery.mjs`, owns the outbound `.well-known/sigil` fetch (`discoverPeer`) and the TOFU decision logic (`resolvePeer`, `rotatePeer`), taking a repository as a parameter rather than owning storage itself. New `PeerRelayRepository` methods (`upsertPeer`/`getPeerByDomain`/`listPeers`/`removePeer`) are added to both `createMemoryRepository` and `PostgresRepository`, mirroring the existing `oidc_issuer_allowlist` add/list/remove shape and its Postgres migration. `sigil/cli/sigil.mjs` gains a `sigil peer <subcommand>` CLI surface that always requires `--database-url`/`SIGIL_DATABASE_URL`, exactly like `sigil oidc-issuer` already does — an in-memory relay has no durable peer directory to provision.

**Tech Stack:** Node.js (`node --test`, `node:assert/strict`, `node:util` `parseArgs`), `pg` (already a dependency), no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-25-sigil-inter-relay-trust-discovery.md`

## Global Constraints

- Discovery fetch: `GET https://<domain>/.well-known/sigil`, `redirect: 'error'`, `AbortSignal.timeout(5000)` — same shape as `oidc-client.mjs`'s `outboundFetchOptions()`. No IP-range/loopback/private-range SSRF guardrails, no DNS-rebinding socket pinning — matches this repo's existing precedent.
- Self-match required: the response's `domain` field must equal the requested domain, or `PEER_DOMAIN_MISMATCH`.
- Only `alg: "Ed25519"` keys are accepted — this repo has no RSA/EC key material outside the OIDC-IdP side.
- `relay.endpoint` (and `relay.ws_endpoint` if present) must be a well-formed absolute `https://` URL; `http://` is accepted only when `process.env.NODE_ENV !== 'production'`.
- `keys` must be a non-empty array; every entry needs non-empty `kid`, `alg === 'Ed25519'`, non-empty `publicKey`.
- Rotation-grace key match compares **both** `kid` AND `publicKey` (exact string equality on both) — matching `kid` alone would let a spoofed response reuse a known `kid` with a new key.
- `trustMode: 'static'` records (`sigil peer add`) are never auto-updated by discovery and never trigger a network call during `resolvePeer`.
- No auto-forwarding, no discovery on the envelope-accept hot path, no background polling timer — discovery only runs from `sigil peer resolve`/`rotate`.
- Every mutating action calls `repository.recordAuditEvent(...)` directly (not through `writeRejectionAudit`'s retry wrapper — that's specific to envelope-rejection transaction rollback timing). Event types: `peer.tofu_pinned`, `peer.rotated` (`payload.forced` distinguishes grace-rotation from `--confirm`), `peer.static_pinned`, `peer.removed`, `peer.key_mismatch_rejected`.
- All repository record fields are camelCase (`relayUrl`, `wsUrl`, `trustMode`, `discoveredAt`, `updatedAt`, `lastResolvedAt`) — matches how `listOidcIssuerAllowlist` already returns `clientId`/`assuranceLevel`, not the Postgres snake_case column names.

---

### Task 1: `peer-discovery.mjs` — `discoverPeer` (pure fetch + validation, no repository)

**Files:**
- Create: `sigil/relay/v1/peer-discovery.mjs`
- Test: `sigil/relay/v1/peer-discovery.test.mjs`

**Interfaces:**
- Produces: `discoverPeer(domain, { fetchImpl = fetch } = {})` → `Promise<{ domain, relayUrl, wsUrl, keys }>` where `keys` is `[{ kid, alg: 'Ed25519', publicKey }, ...]` and `wsUrl` is `null` when the response omits `ws_endpoint`. Throws `Error` with `.code` one of: `PEER_DISCOVERY_FAILED` (unreachable/timeout/non-2xx), `PEER_MALFORMED_RESPONSE` (bad JSON), `PEER_DOMAIN_MISMATCH`, `PEER_INVALID_ENDPOINT`, `PEER_NO_KEYS`, `PEER_INVALID_KEY`.

- [ ] **Step 1: Write failing tests for `discoverPeer`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverPeer } from './peer-discovery.mjs';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

const VALID_BODY = {
  domain: 'relay.example.com',
  relay: { endpoint: 'https://relay.example.com:8443/v1', ws_endpoint: 'wss://relay.example.com:8443/v1/stream' },
  keys: [{ kid: 'key-2026-08', alg: 'Ed25519', publicKey: 'pubkey-a' }],
};

test('discoverPeer fetches .well-known/sigil and returns the parsed record', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://relay.example.com/.well-known/sigil');
    assert.equal(options.redirect, 'error');
    return jsonResponse(VALID_BODY);
  };
  const result = await discoverPeer('relay.example.com', { fetchImpl });
  assert.deepEqual(result, {
    domain: 'relay.example.com',
    relayUrl: 'https://relay.example.com:8443/v1',
    wsUrl: 'wss://relay.example.com:8443/v1/stream',
    keys: [{ kid: 'key-2026-08', alg: 'Ed25519', publicKey: 'pubkey-a' }],
  });
});

test('discoverPeer defaults wsUrl to null when ws_endpoint is omitted', async () => {
  const body = { domain: 'relay.example.com', relay: { endpoint: 'https://relay.example.com/v1' }, keys: VALID_BODY.keys };
  const fetchImpl = async () => jsonResponse(body);
  const result = await discoverPeer('relay.example.com', { fetchImpl });
  assert.equal(result.wsUrl, null);
});

test('discoverPeer rejects on a network error', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_DISCOVERY_FAILED' });
});

test('discoverPeer rejects on a non-ok HTTP status', async () => {
  const fetchImpl = async () => jsonResponse({}, { ok: false, status: 500 });
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_DISCOVERY_FAILED' });
});

test('discoverPeer rejects on malformed JSON', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_MALFORMED_RESPONSE' });
});

test('discoverPeer rejects when the response domain does not match the requested domain', async () => {
  const fetchImpl = async () => jsonResponse({ ...VALID_BODY, domain: 'attacker.example.com' });
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_DOMAIN_MISMATCH' });
});

test('discoverPeer rejects a non-https relay.endpoint in production', async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const fetchImpl = async () => jsonResponse({ ...VALID_BODY, relay: { endpoint: 'http://relay.example.com/v1' } });
    await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_INVALID_ENDPOINT' });
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test('discoverPeer accepts a non-https relay.endpoint outside production', async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    const fetchImpl = async () => jsonResponse({ ...VALID_BODY, relay: { endpoint: 'http://relay.example.com/v1' } });
    const result = await discoverPeer('relay.example.com', { fetchImpl });
    assert.equal(result.relayUrl, 'http://relay.example.com/v1');
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test('discoverPeer rejects a malformed relay.endpoint URL', async () => {
  const fetchImpl = async () => jsonResponse({ ...VALID_BODY, relay: { endpoint: 'not a url' } });
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_INVALID_ENDPOINT' });
});

test('discoverPeer rejects a missing relay object entirely', async () => {
  const fetchImpl = async () => jsonResponse({ domain: 'relay.example.com', keys: VALID_BODY.keys });
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_INVALID_ENDPOINT' });
});

test('discoverPeer rejects an empty keys array', async () => {
  const fetchImpl = async () => jsonResponse({ ...VALID_BODY, keys: [] });
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_NO_KEYS' });
});

test('discoverPeer rejects a key entry with a non-Ed25519 alg', async () => {
  const fetchImpl = async () => jsonResponse({ ...VALID_BODY, keys: [{ kid: 'k1', alg: 'RSA', publicKey: 'x' }] });
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_INVALID_KEY' });
});

test('discoverPeer rejects a key entry with an empty kid', async () => {
  const fetchImpl = async () => jsonResponse({ ...VALID_BODY, keys: [{ kid: '', alg: 'Ed25519', publicKey: 'x' }] });
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_INVALID_KEY' });
});
```

- [ ] **Step 2: Run tests, verify they fail with module-not-found**

Run: `node --test sigil/relay/v1/peer-discovery.test.mjs`
Expected: FAIL — `peer-discovery.mjs` does not exist yet.

- [ ] **Step 3: Implement `discoverPeer`**

```js
// sigil/relay/v1/peer-discovery.mjs
function peerError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

// Mirrors oidc-client.mjs's outboundFetchOptions(): a fixed timeout and a
// hard no-follow redirect policy so a hung/redirecting peer can't hold the
// request open or redirect trust to an unvetted URL. AbortSignal.timeout is
// called fresh per request -- a shared signal fires once and stays aborted.
function outboundFetchOptions() {
  return { signal: AbortSignal.timeout(5000), redirect: 'error' };
}

function isValidEndpointUrl(url) {
  if (typeof url !== 'string') return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && process.env.NODE_ENV !== 'production';
}

export async function discoverPeer(domain, { fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(`https://${domain}/.well-known/sigil`, outboundFetchOptions());
  } catch {
    throw peerError(`Failed to reach https://${domain}/.well-known/sigil`, 'PEER_DISCOVERY_FAILED', { domain });
  }
  if (!response.ok) {
    throw peerError(`.well-known/sigil for "${domain}" returned HTTP ${response.status}`, 'PEER_DISCOVERY_FAILED', { domain, status: response.status });
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw peerError(`Malformed .well-known/sigil response for "${domain}"`, 'PEER_MALFORMED_RESPONSE', { domain });
  }
  // Self-match, mirroring discoverIssuer's RFC 8414 SS3.3 issuer-match check:
  // without this, a response served from (or proxied through) an unexpected
  // host could redirect trust to an endpoint/keys the caller never vetted.
  if (data.domain !== domain) {
    throw peerError(`.well-known/sigil domain mismatch: expected "${domain}", got "${data.domain}"`, 'PEER_DOMAIN_MISMATCH', { domain, responseDomain: data.domain });
  }
  if (!isValidEndpointUrl(data.relay?.endpoint)) {
    throw peerError(`Invalid relay.endpoint in .well-known/sigil response for "${domain}"`, 'PEER_INVALID_ENDPOINT', { domain });
  }
  if (data.relay.ws_endpoint !== undefined && !isValidEndpointUrl(data.relay.ws_endpoint)) {
    throw peerError(`Invalid relay.ws_endpoint in .well-known/sigil response for "${domain}"`, 'PEER_INVALID_ENDPOINT', { domain });
  }
  if (!Array.isArray(data.keys) || data.keys.length === 0) {
    throw peerError(`.well-known/sigil response for "${domain}" has no keys`, 'PEER_NO_KEYS', { domain });
  }
  for (const key of data.keys) {
    if (typeof key?.kid !== 'string' || key.kid.length === 0 || key.alg !== 'Ed25519' || typeof key.publicKey !== 'string' || key.publicKey.length === 0) {
      throw peerError(`.well-known/sigil response for "${domain}" has an invalid key entry`, 'PEER_INVALID_KEY', { domain });
    }
  }
  return { domain, relayUrl: data.relay.endpoint, wsUrl: data.relay.ws_endpoint ?? null, keys: data.keys };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test sigil/relay/v1/peer-discovery.test.mjs`
Expected: PASS (all 13 tests)

- [ ] **Step 5: Commit**

```bash
git add sigil/relay/v1/peer-discovery.mjs sigil/relay/v1/peer-discovery.test.mjs
git commit -m "feat(sigil): add discoverPeer for .well-known/sigil discovery"
```

---

### Task 2: memory repository — `PeerRelayRepository` methods + `resolvePeer`/`rotatePeer` TOFU logic

**Files:**
- Modify: `sigil/cli/memory-repository.mjs`
- Modify: `sigil/relay/v1/peer-discovery.mjs`
- Test: `sigil/cli/memory-repository.peer.test.mjs`
- Test: `sigil/relay/v1/peer-discovery.test.mjs` (append `resolvePeer`/`rotatePeer` tests)

**Interfaces:**
- Consumes: `discoverPeer(domain, { fetchImpl })` from Task 1.
- Produces (memory repository, mirrors `oidc_issuer_allowlist`'s add/list/remove shape): `upsertPeer({ domain, relayUrl, wsUrl = null, keys, trustMode, now = new Date() })` → the stored record; `getPeerByDomain(domain)` → record or `null`; `listPeers()` → `record[]`; `removePeer(domain)` → `boolean`. Record shape: `{ domain, relayUrl, wsUrl, keys, trustMode, discoveredAt, updatedAt, lastResolvedAt }` (all ISO-string timestamps except `keys`, which is `[{ kid, alg, publicKey }, ...]`).
- Produces: `resolvePeer(domain, repository, { fetchImpl = fetch, now = new Date() } = {})` → `Promise<record>`. Throws `PEER_KEY_MISMATCH` (with `.pinnedKeys`/`.fetchedKeys`) or whatever `discoverPeer` throws.
- Produces: `rotatePeer(domain, repository, { fetchImpl = fetch, now = new Date() } = {})` → `Promise<record>`, force-overwriting regardless of any existing pin.

- [ ] **Step 1: Write failing tests for the memory repository's peer methods**

```js
// sigil/cli/memory-repository.peer.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

const KEYS = [{ kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' }];

test('getPeerByDomain returns null for an unknown domain', async () => {
  const repository = createMemoryRepository();
  assert.equal(await repository.getPeerByDomain('relay.example.com'), null);
});

test('upsertPeer inserts a record that getPeerByDomain can read back', async () => {
  const repository = createMemoryRepository();
  const now = new Date('2026-08-25T00:00:00Z');
  const record = await repository.upsertPeer({ domain: 'relay.example.com', relayUrl: 'https://relay.example.com/v1', wsUrl: null, keys: KEYS, trustMode: 'tofu', now });
  assert.equal(record.domain, 'relay.example.com');
  assert.equal(record.trustMode, 'tofu');
  assert.equal(record.discoveredAt, now.toISOString());
  assert.equal(record.updatedAt, now.toISOString());
  assert.deepEqual(await repository.getPeerByDomain('relay.example.com'), record);
});

test('upsertPeer preserves discoveredAt across a later update but bumps updatedAt/lastResolvedAt', async () => {
  const repository = createMemoryRepository();
  const first = new Date('2026-08-25T00:00:00Z');
  const second = new Date('2026-08-26T00:00:00Z');
  await repository.upsertPeer({ domain: 'relay.example.com', relayUrl: 'https://relay.example.com/v1', keys: KEYS, trustMode: 'tofu', now: first });
  const updated = await repository.upsertPeer({ domain: 'relay.example.com', relayUrl: 'https://relay.example.com/v2', keys: KEYS, trustMode: 'tofu', now: second });
  assert.equal(updated.discoveredAt, first.toISOString());
  assert.equal(updated.updatedAt, second.toISOString());
  assert.equal(updated.relayUrl, 'https://relay.example.com/v2');
});

test('listPeers returns all pinned peers', async () => {
  const repository = createMemoryRepository();
  await repository.upsertPeer({ domain: 'a.example.com', relayUrl: 'https://a.example.com/v1', keys: KEYS, trustMode: 'tofu' });
  await repository.upsertPeer({ domain: 'b.example.com', relayUrl: 'https://b.example.com/v1', keys: KEYS, trustMode: 'static' });
  const domains = (await repository.listPeers()).map((p) => p.domain).sort();
  assert.deepEqual(domains, ['a.example.com', 'b.example.com']);
});

test('removePeer deletes a pinned peer and returns true, false if nothing was there', async () => {
  const repository = createMemoryRepository();
  await repository.upsertPeer({ domain: 'relay.example.com', relayUrl: 'https://relay.example.com/v1', keys: KEYS, trustMode: 'tofu' });
  assert.equal(await repository.removePeer('relay.example.com'), true);
  assert.equal(await repository.getPeerByDomain('relay.example.com'), null);
  assert.equal(await repository.removePeer('relay.example.com'), false);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test sigil/cli/memory-repository.peer.test.mjs`
Expected: FAIL — `upsertPeer` is not a function.

- [ ] **Step 3: Implement the memory repository's peer methods**

In `sigil/cli/memory-repository.mjs`, add a `peerRelays = new Map()` alongside the other `new Map()` declarations near the top of `createMemoryRepository()` (next to `oidcIssuerAllowlist`), and add these methods to the returned object, right after `disableOidcIssuerAllowlist`:

```js
    async upsertPeer({ domain, relayUrl, wsUrl = null, keys, trustMode, now = new Date() }) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const existing = peerRelays.get(domain);
      const record = {
        domain, relayUrl, wsUrl, keys, trustMode,
        discoveredAt: existing?.discoveredAt ?? timestamp,
        updatedAt: timestamp,
        lastResolvedAt: timestamp,
      };
      peerRelays.set(domain, record);
      return record;
    },
    async getPeerByDomain(domain) {
      return peerRelays.get(domain) ?? null;
    },
    async listPeers() {
      return [...peerRelays.values()];
    },
    async removePeer(domain) {
      return peerRelays.delete(domain);
    },
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test sigil/cli/memory-repository.peer.test.mjs`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Write failing tests for `resolvePeer`/`rotatePeer`**

Append to `sigil/relay/v1/peer-discovery.test.mjs`:

```js
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { resolvePeer, rotatePeer } from './peer-discovery.mjs';

function makeFetch(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

const BODY_V1 = {
  domain: 'relay.example.com',
  relay: { endpoint: 'https://relay.example.com/v1' },
  keys: [{ kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' }],
};

test('resolvePeer TOFU-pins on first resolve and audits peer.tofu_pinned', async () => {
  const repository = createMemoryRepository();
  const record = await resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(BODY_V1) });
  assert.equal(record.trustMode, 'tofu');
  assert.deepEqual(record.keys, BODY_V1.keys);
  const events = repository._debugGetAuditEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'peer.tofu_pinned');
  assert.equal(events[0].object_id, 'relay.example.com');
});

test('resolvePeer is a silent no-op re-confirmation when the key set is unchanged', async () => {
  const repository = createMemoryRepository();
  await resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(BODY_V1) });
  await resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(BODY_V1) });
  const events = repository._debugGetAuditEvents();
  assert.equal(events.length, 1); // only the original tofu_pinned -- no second audit event
});

test('resolvePeer accepts a rotation when the previously pinned key is still present in the new set', async () => {
  const repository = createMemoryRepository();
  await resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(BODY_V1) });
  const rotatedBody = { ...BODY_V1, keys: [...BODY_V1.keys, { kid: 'k2', alg: 'Ed25519', publicKey: 'pub-2' }] };
  const record = await resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(rotatedBody) });
  assert.equal(record.keys.length, 2);
  const events = repository._debugGetAuditEvents();
  assert.equal(events.length, 2);
  assert.equal(events[1].event_type, 'peer.rotated');
  assert.equal(events[1].payload.forced, false);
});

test('resolvePeer rejects a kid reused with a different publicKey (spoofing) and leaves the record untouched', async () => {
  const repository = createMemoryRepository();
  await resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(BODY_V1) });
  const spoofedBody = { ...BODY_V1, keys: [{ kid: 'k1', alg: 'Ed25519', publicKey: 'attacker-pub' }] };
  await assert.rejects(
    () => resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(spoofedBody) }),
    (error) => error.code === 'PEER_KEY_MISMATCH',
  );
  const stored = await repository.getPeerByDomain('relay.example.com');
  assert.deepEqual(stored.keys, BODY_V1.keys);
  const events = repository._debugGetAuditEvents();
  assert.equal(events[events.length - 1].event_type, 'peer.key_mismatch_rejected');
});

test('resolvePeer rejects when the previously pinned key is entirely absent from the new set', async () => {
  const repository = createMemoryRepository();
  await resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(BODY_V1) });
  const differentBody = { ...BODY_V1, keys: [{ kid: 'k9', alg: 'Ed25519', publicKey: 'pub-9' }] };
  await assert.rejects(
    () => resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(differentBody) }),
    (error) => error.code === 'PEER_KEY_MISMATCH',
  );
});

test('resolvePeer never fetches or overwrites a static-pinned record', async () => {
  const repository = createMemoryRepository();
  await repository.upsertPeer({ domain: 'relay.example.com', relayUrl: 'https://static.example.com/v1', keys: BODY_V1.keys, trustMode: 'static' });
  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return { ok: true, status: 200, json: async () => BODY_V1 }; };
  const record = await resolvePeer('relay.example.com', repository, { fetchImpl });
  assert.equal(fetchCalled, false);
  assert.equal(record.relayUrl, 'https://static.example.com/v1');
});

test('rotatePeer force-overwrites regardless of a prior key mismatch and audits forced: true', async () => {
  const repository = createMemoryRepository();
  await resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(BODY_V1) });
  const newBody = { ...BODY_V1, keys: [{ kid: 'k9', alg: 'Ed25519', publicKey: 'pub-9' }] };
  const record = await rotatePeer('relay.example.com', repository, { fetchImpl: makeFetch(newBody) });
  assert.deepEqual(record.keys, newBody.keys);
  const events = repository._debugGetAuditEvents();
  assert.equal(events[events.length - 1].event_type, 'peer.rotated');
  assert.equal(events[events.length - 1].payload.forced, true);
});
```

- [ ] **Step 6: Run tests, verify they fail**

Run: `node --test sigil/relay/v1/peer-discovery.test.mjs`
Expected: FAIL — `resolvePeer`/`rotatePeer` are not exported yet.

- [ ] **Step 7: Implement `resolvePeer`/`rotatePeer`**

Append to `sigil/relay/v1/peer-discovery.mjs`:

```js
function keyMatches(pinned, fetchedKeys) {
  return fetchedKeys.some((k) => k.kid === pinned.kid && k.publicKey === pinned.publicKey);
}

function sameKeySet(a, b) {
  if (a.length !== b.length) return false;
  const normalize = (keys) => keys.map((k) => `${k.kid}:${k.publicKey}`).sort().join('|');
  return normalize(a) === normalize(b);
}

function auditPayload(discovered, extra = {}) {
  return { relayUrl: discovered.relayUrl, keys: discovered.keys, ...extra };
}

export async function resolvePeer(domain, repository, { fetchImpl = fetch, now = new Date() } = {}) {
  const existing = await repository.getPeerByDomain(domain);
  if (existing && existing.trustMode === 'static') return existing;

  const discovered = await discoverPeer(domain, { fetchImpl });

  if (!existing) {
    const record = await repository.upsertPeer({ domain, relayUrl: discovered.relayUrl, wsUrl: discovered.wsUrl, keys: discovered.keys, trustMode: 'tofu', now });
    await repository.recordAuditEvent({ eventType: 'peer.tofu_pinned', subjectId: domain, objectType: 'peer_relay', objectId: domain, outcome: 'accepted', payload: auditPayload(discovered), now });
    return record;
  }

  const stillTrusted = existing.keys.some((pinned) => keyMatches(pinned, discovered.keys));
  if (!stillTrusted) {
    await repository.recordAuditEvent({ eventType: 'peer.key_mismatch_rejected', subjectId: domain, objectType: 'peer_relay', objectId: domain, outcome: 'rejected', payload: { pinnedKeys: existing.keys, fetchedKeys: discovered.keys }, now });
    throw peerError(`Peer "${domain}" key mismatch: previously pinned key not found in current .well-known/sigil response`, 'PEER_KEY_MISMATCH', { domain, pinnedKeys: existing.keys, fetchedKeys: discovered.keys });
  }

  const changed = !sameKeySet(existing.keys, discovered.keys);
  const record = await repository.upsertPeer({ domain, relayUrl: discovered.relayUrl, wsUrl: discovered.wsUrl, keys: discovered.keys, trustMode: 'tofu', now });
  if (changed) {
    await repository.recordAuditEvent({ eventType: 'peer.rotated', subjectId: domain, objectType: 'peer_relay', objectId: domain, outcome: 'accepted', payload: auditPayload(discovered, { forced: false }), now });
  }
  return record;
}

export async function rotatePeer(domain, repository, { fetchImpl = fetch, now = new Date() } = {}) {
  const discovered = await discoverPeer(domain, { fetchImpl });
  const record = await repository.upsertPeer({ domain, relayUrl: discovered.relayUrl, wsUrl: discovered.wsUrl, keys: discovered.keys, trustMode: 'tofu', now });
  await repository.recordAuditEvent({ eventType: 'peer.rotated', subjectId: domain, objectType: 'peer_relay', objectId: domain, outcome: 'accepted', payload: auditPayload(discovered, { forced: true }), now });
  return record;
}
```

- [ ] **Step 8: Run tests, verify they pass**

Run: `node --test sigil/relay/v1/peer-discovery.test.mjs sigil/cli/memory-repository.peer.test.mjs`
Expected: PASS (all tests in both files)

- [ ] **Step 9: Commit**

```bash
git add sigil/cli/memory-repository.mjs sigil/cli/memory-repository.peer.test.mjs sigil/relay/v1/peer-discovery.mjs sigil/relay/v1/peer-discovery.test.mjs
git commit -m "feat(sigil): add peer repository methods + TOFU resolvePeer/rotatePeer"
```

---

### Task 3: Postgres migration + `PostgresRepository` peer methods (repository parity)

**Files:**
- Create: `sigil/migrations/016_peer_relays.sql`
- Modify: `sigil/relay/v1/postgres-repository.mjs`
- Test: `sigil/relay/v1/postgres-repository.peer.test.mjs`

**Interfaces:**
- Consumes: nothing new — implements the same `upsertPeer`/`getPeerByDomain`/`listPeers`/`removePeer` signatures Task 2 defined for the memory repository, so `resolvePeer`/`rotatePeer` from Task 2 work unchanged against a `PostgresRepository` instance.
- Produces: same four methods, `PostgresRepository`-backed, same camelCase record shape.

- [ ] **Step 1: Add the migration**

```sql
-- sigil/migrations/016_peer_relays.sql
-- Sub-project #2 (inter-relay trust/discovery): a relay operator's durably
-- pinned trust record for a foreign domain's relay -- endpoint URL(s) and
-- the Ed25519 key set to trust for it. `keys` is a JSONB array (not a
-- single-key column) because TOFU rotation-grace matching (peer-discovery.mjs)
-- needs to compare against the whole set, not one key at a time.
CREATE TABLE IF NOT EXISTS peer_relays (
  domain            TEXT PRIMARY KEY,
  relay_url         TEXT NOT NULL,
  ws_url            TEXT,
  keys              JSONB NOT NULL,
  trust_mode        TEXT NOT NULL DEFAULT 'tofu',
  discovered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_resolved_at  TIMESTAMPTZ
);
```

No changes to `sigil/scripts/apply-migrations.mjs` are needed — it auto-discovers and applies any new `.sql` file in `sigil/migrations/` in sorted order; the manual `applied.has(...)` backfill blocks near the top of that file exist only for pre-migrations-table legacy detection of migrations 001–011 and don't need a new entry for 016.

- [ ] **Step 2: Write failing Postgres integration tests**

```js
// sigil/relay/v1/postgres-repository.peer.test.mjs
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

const KEYS = [{ kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' }];

test('getPeerByDomain returns null for an unknown domain', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  assert.equal(await repository.getPeerByDomain('relay.example.com'), null);
});

test('upsertPeer inserts a record that getPeerByDomain can read back', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const domain = `relay-${suffix}.example.com`;
  const record = await repository.upsertPeer({ domain, relayUrl: 'https://relay.example.com/v1', wsUrl: null, keys: KEYS, trustMode: 'tofu' });
  assert.equal(record.domain, domain);
  assert.equal(record.trustMode, 'tofu');
  assert.deepEqual(record.keys, KEYS);
  const fetched = await repository.getPeerByDomain(domain);
  assert.deepEqual(fetched, record);
});

test('upsertPeer preserves discoveredAt across a later update but bumps updatedAt', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const domain = `relay-${suffix}.example.com`;
  const first = new Date('2026-08-25T00:00:00Z');
  const second = new Date('2026-08-26T00:00:00Z');
  await repository.upsertPeer({ domain, relayUrl: 'https://relay.example.com/v1', keys: KEYS, trustMode: 'tofu', now: first });
  const updated = await repository.upsertPeer({ domain, relayUrl: 'https://relay.example.com/v2', keys: KEYS, trustMode: 'tofu', now: second });
  assert.equal(new Date(updated.discoveredAt).toISOString(), first.toISOString());
  assert.equal(new Date(updated.updatedAt).toISOString(), second.toISOString());
  assert.equal(updated.relayUrl, 'https://relay.example.com/v2');
});

test('listPeers returns all pinned peers ordered by domain', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const domainA = `a-${suffix}.example.com`;
  const domainB = `b-${suffix}.example.com`;
  await repository.upsertPeer({ domain: domainB, relayUrl: 'https://b.example.com/v1', keys: KEYS, trustMode: 'static' });
  await repository.upsertPeer({ domain: domainA, relayUrl: 'https://a.example.com/v1', keys: KEYS, trustMode: 'tofu' });
  const domains = (await repository.listPeers()).map((p) => p.domain);
  assert.ok(domains.indexOf(domainA) < domains.indexOf(domainB));
});

test('removePeer deletes a pinned peer and returns true, false if nothing was there', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const domain = `relay-${suffix}.example.com`;
  await repository.upsertPeer({ domain, relayUrl: 'https://relay.example.com/v1', keys: KEYS, trustMode: 'tofu' });
  assert.equal(await repository.removePeer(domain), true);
  assert.equal(await repository.getPeerByDomain(domain), null);
  assert.equal(await repository.removePeer(domain), false);
});
```

- [ ] **Step 3: Run tests, verify they fail (or skip cleanly with no `SIGIL_TEST_DATABASE_URL`)**

Run: `node --test sigil/relay/v1/postgres-repository.peer.test.mjs`
Expected: If `SIGIL_TEST_DATABASE_URL` is unset, all tests report `skipped`. If it's set (as it is in CI against the live PostgreSQL 16 service container), FAIL — `upsertPeer` is not a function yet.

- [ ] **Step 4: Implement the Postgres repository's peer methods**

In `sigil/relay/v1/postgres-repository.mjs`, add a module-level helper near the top (after the imports) and the four methods right after `disableOidcIssuerAllowlist`:

```js
function rowToPeerRecord(row) {
  return {
    domain: row.domain,
    relayUrl: row.relay_url,
    wsUrl: row.ws_url,
    keys: row.keys,
    trustMode: row.trust_mode,
    discoveredAt: row.discovered_at,
    updatedAt: row.updated_at,
    lastResolvedAt: row.last_resolved_at,
  };
}
```

```js
  async upsertPeer({ domain, relayUrl, wsUrl = null, keys, trustMode, now = new Date() } = {}) {
    const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const result = await this.pool.query(
      `INSERT INTO peer_relays (domain, relay_url, ws_url, keys, trust_mode, discovered_at, updated_at, last_resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6)
       ON CONFLICT (domain) DO UPDATE SET relay_url = $2, ws_url = $3, keys = $4, trust_mode = $5, updated_at = $6, last_resolved_at = $6
       RETURNING domain, relay_url, ws_url, keys, trust_mode, discovered_at, updated_at, last_resolved_at`,
      [domain, relayUrl, wsUrl, JSON.stringify(keys), trustMode, timestamp]
    );
    return rowToPeerRecord(result.rows[0]);
  }
  async getPeerByDomain(domain) {
    const result = await this.pool.query(
      'SELECT domain, relay_url, ws_url, keys, trust_mode, discovered_at, updated_at, last_resolved_at FROM peer_relays WHERE domain = $1',
      [domain]
    );
    return result.rows[0] ? rowToPeerRecord(result.rows[0]) : null;
  }
  async listPeers() {
    const result = await this.pool.query(
      'SELECT domain, relay_url, ws_url, keys, trust_mode, discovered_at, updated_at, last_resolved_at FROM peer_relays ORDER BY domain'
    );
    return result.rows.map(rowToPeerRecord);
  }
  async removePeer(domain) {
    const result = await this.pool.query('DELETE FROM peer_relays WHERE domain = $1', [domain]);
    return result.rowCount > 0;
  }
```

Note: `pg` returns a `JSONB` column already parsed into a JS array, so `row.keys` needs no `JSON.parse`; the write side uses `JSON.stringify(keys)` to match this file's existing convention for JSON columns (see `metadataRedacted` in `recordAuditEvent`).

- [ ] **Step 5: Run tests, verify they pass**

Run: `SIGIL_TEST_DATABASE_URL=<your local test db url> node --test sigil/relay/v1/postgres-repository.peer.test.mjs`
Expected: PASS (all 5 tests). If you don't have a local Postgres to test against, this is safe to defer to CI, which runs it against a live PostgreSQL 16 service container — but do not skip Step 4's implementation.

- [ ] **Step 6: Commit**

```bash
git add sigil/migrations/016_peer_relays.sql sigil/relay/v1/postgres-repository.mjs sigil/relay/v1/postgres-repository.peer.test.mjs
git commit -m "feat(sigil): add peer_relays migration + PostgresRepository peer methods"
```

---

### Task 4: `sigil peer` CLI surface

**Files:**
- Modify: `sigil/cli/sigil.mjs`
- Test: `sigil/cli/sigil-peer.test.mjs`

**Interfaces:**
- Consumes: `resolvePeer`, `rotatePeer` from `sigil/relay/v1/peer-discovery.mjs` (Task 2); `upsertPeer`/`getPeerByDomain`/`listPeers`/`removePeer` on `PostgresRepository` (Task 3).
- Produces: `sigil peer resolve|add|list|get|remove|rotate` subcommands, dispatched from `main()`.

- [ ] **Step 1: Write failing CLI tests (usage/flag errors only — no live DB required)**

```js
// sigil/cli/sigil-peer.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const sigilPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');

async function run(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [sigilPath, ...args], {
      env: { ...process.env, SIGIL_DATABASE_URL: '' },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code };
  }
}

test('sigil peer resolve requires a domain', async () => {
  const { stderr, exitCode } = await run(['peer', 'resolve']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /usage: sigil peer resolve/);
});

test('sigil peer resolve requires --database-url when SIGIL_DATABASE_URL is unset', async () => {
  const { stderr, exitCode } = await run(['peer', 'resolve', 'relay.example.com']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /--database-url/);
});

test('sigil peer add requires --relay-url/--public-key/--kid', async () => {
  const { stderr, exitCode } = await run(['peer', 'add', 'relay.example.com', '--database-url', 'postgres://placeholder']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /usage: sigil peer add/);
});

test('sigil peer add requires --database-url when SIGIL_DATABASE_URL is unset', async () => {
  const { stderr, exitCode } = await run(['peer', 'add', 'relay.example.com', '--relay-url', 'https://relay.example.com/v1', '--public-key', 'pub-1', '--kid', 'k1']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /--database-url/);
});

test('sigil peer rotate requires --confirm', async () => {
  const { stderr, exitCode } = await run(['peer', 'rotate', 'relay.example.com', '--database-url', 'postgres://placeholder']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /--confirm/);
});

test('sigil peer remove requires a domain', async () => {
  const { stderr, exitCode } = await run(['peer', 'remove']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /usage: sigil peer remove/);
});

test('sigil peer get requires a domain', async () => {
  const { stderr, exitCode } = await run(['peer', 'get']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /usage: sigil peer get/);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test sigil/cli/sigil-peer.test.mjs`
Expected: FAIL — `sigil peer` isn't wired into `main()` yet, so every case currently falls through to `usage()` and exits 0, not 1.

- [ ] **Step 3: Implement the `sigil peer` subcommands**

Add to `sigil/cli/sigil.mjs`, right after `cmdOidcIssuerRemove` (before `printDoctorReport`):

```js
async function cmdPeerResolve(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' } }, allowPositionals: true });
  const domain = args.positionals[0];
  if (!domain) throw new Error('usage: sigil peer resolve <domain> [--database-url url]');
  const databaseUrl = opt(args, ['database-url']) ?? process.env.SIGIL_DATABASE_URL;
  if (!databaseUrl) throw new Error('sigil peer resolve requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory');
  const { applyMigrations } = await import('../scripts/apply-migrations.mjs');
  await applyMigrations(databaseUrl);
  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const repository = new PostgresRepository({ pool });
    const { resolvePeer } = await import('../relay/v1/peer-discovery.mjs');
    const record = await resolvePeer(domain, repository);
    console.log(JSON.stringify(record, null, 2));
  } catch (error) {
    if (error.code === 'PEER_KEY_MISMATCH') {
      console.error(`sigil peer resolve: key mismatch for "${domain}"`);
      console.error(`  pinned:  ${error.pinnedKeys.map((k) => `${k.kid}=${k.publicKey}`).join(', ')}`);
      console.error(`  fetched: ${error.fetchedKeys.map((k) => `${k.kid}=${k.publicKey}`).join(', ')}`);
      console.error('  Run "sigil peer rotate <domain> --confirm" to accept the new key.');
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await pool.end();
  }
}

async function cmdPeerAdd(argv) {
  const args = parseArgs({ args: argv, options: { 'relay-url': { type: 'string' }, 'ws-url': { type: 'string' }, 'public-key': { type: 'string' }, kid: { type: 'string' }, 'database-url': { type: 'string' } }, allowPositionals: true });
  const domain = args.positionals[0];
  const relayUrl = opt(args, ['relay-url']);
  const publicKey = opt(args, ['public-key']);
  const kid = opt(args, ['kid']);
  if (!domain || !relayUrl || !publicKey || !kid) throw new Error('usage: sigil peer add <domain> --relay-url <url> --public-key <key> --kid <id> [--ws-url <url>] [--database-url url]');
  const databaseUrl = opt(args, ['database-url']) ?? process.env.SIGIL_DATABASE_URL;
  if (!databaseUrl) throw new Error('sigil peer add requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory');
  const { applyMigrations } = await import('../scripts/apply-migrations.mjs');
  await applyMigrations(databaseUrl);
  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const repository = new PostgresRepository({ pool });
    await repository.upsertPeer({ domain, relayUrl, wsUrl: opt(args, ['ws-url']) ?? null, keys: [{ kid, alg: 'Ed25519', publicKey }], trustMode: 'static' });
    await repository.recordAuditEvent({ eventType: 'peer.static_pinned', subjectId: domain, objectType: 'peer_relay', objectId: domain, outcome: 'accepted', payload: { relayUrl, kid } });
    console.log(`Statically pinned ${domain} -> ${relayUrl} (kid ${kid}).`);
  } finally {
    await pool.end();
  }
}

async function cmdPeerList(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' } } });
  const databaseUrl = opt(args, ['database-url']) ?? process.env.SIGIL_DATABASE_URL;
  if (!databaseUrl) throw new Error('sigil peer list requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory');
  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const repository = new PostgresRepository({ pool });
    const peers = await repository.listPeers();
    for (const peer of peers) console.log(`${peer.domain}\t${peer.relayUrl}\t${peer.trustMode}\t${peer.keys.map((k) => k.kid).join(',')}`);
  } finally {
    await pool.end();
  }
}

async function cmdPeerGet(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' } }, allowPositionals: true });
  const domain = args.positionals[0];
  if (!domain) throw new Error('usage: sigil peer get <domain> [--database-url url]');
  const databaseUrl = opt(args, ['database-url']) ?? process.env.SIGIL_DATABASE_URL;
  if (!databaseUrl) throw new Error('sigil peer get requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory');
  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const repository = new PostgresRepository({ pool });
    const peer = await repository.getPeerByDomain(domain);
    console.log(peer ? JSON.stringify(peer, null, 2) : `No peer pinned for "${domain}".`);
  } finally {
    await pool.end();
  }
}

async function cmdPeerRemove(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' } }, allowPositionals: true });
  const domain = args.positionals[0];
  if (!domain) throw new Error('usage: sigil peer remove <domain> [--database-url url]');
  const databaseUrl = opt(args, ['database-url']) ?? process.env.SIGIL_DATABASE_URL;
  if (!databaseUrl) throw new Error('sigil peer remove requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory');
  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const repository = new PostgresRepository({ pool });
    const removed = await repository.removePeer(domain);
    if (removed) {
      await repository.recordAuditEvent({ eventType: 'peer.removed', subjectId: domain, objectType: 'peer_relay', objectId: domain, outcome: 'accepted', payload: {} });
      console.log(`Removed peer pin for "${domain}".`);
    } else {
      console.log(`No peer pinned for "${domain}".`);
    }
  } finally {
    await pool.end();
  }
}

async function cmdPeerRotate(argv) {
  const args = parseArgs({ args: argv, options: { confirm: { type: 'boolean' }, 'database-url': { type: 'string' } }, allowPositionals: true });
  const domain = args.positionals[0];
  if (!domain) throw new Error('usage: sigil peer rotate <domain> --confirm [--database-url url]');
  if (!args.values.confirm) throw new Error('sigil peer rotate requires --confirm -- this force-overwrites a pinned peer key without the usual TOFU mismatch check');
  const databaseUrl = opt(args, ['database-url']) ?? process.env.SIGIL_DATABASE_URL;
  if (!databaseUrl) throw new Error('sigil peer rotate requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory');
  const { applyMigrations } = await import('../scripts/apply-migrations.mjs');
  await applyMigrations(databaseUrl);
  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const repository = new PostgresRepository({ pool });
    const { rotatePeer } = await import('../relay/v1/peer-discovery.mjs');
    const record = await rotatePeer(domain, repository);
    console.log(JSON.stringify(record, null, 2));
  } finally {
    await pool.end();
  }
}
```

Each `cmdPeer*` function inlines its own pool setup/teardown, matching exactly how `cmdOidcIssuerAdd`/`List`/`Remove` already do it in this file — no shared helper.

Wire into `main()`'s dispatch chain, after the `oidc-issuer` branches:

```js
    else if (command === 'peer' && sub === 'resolve') await cmdPeerResolve(rest);
    else if (command === 'peer' && sub === 'add') await cmdPeerAdd(rest);
    else if (command === 'peer' && sub === 'list') await cmdPeerList(rest);
    else if (command === 'peer' && sub === 'get') await cmdPeerGet(rest);
    else if (command === 'peer' && sub === 'remove') await cmdPeerRemove(rest);
    else if (command === 'peer' && sub === 'rotate') await cmdPeerRotate(rest);
```

Add to the `usage()` string, after the `oidc-issuer remove` line:

```
  peer resolve <domain> [--database-url url]               Discover and TOFU-pin a peer relay via https://<domain>/.well-known/sigil
  peer add <domain> --relay-url url --public-key key --kid id [--ws-url url] [--database-url url]
                                                            Manually (statically) pin a peer relay -- never auto-updated by discovery
  peer list [--database-url url]                           List all pinned peer relays
  peer get <domain> [--database-url url]                   Show one pinned peer relay
  peer remove <domain> [--database-url url]                Unpin a peer relay
  peer rotate <domain> --confirm [--database-url url]      Force-overwrite a pinned peer's key set, bypassing the TOFU mismatch check
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test sigil/cli/sigil-peer.test.mjs`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `node --test sigil/**/*.test.mjs` (or however this repo's `package.json` `test` script is invoked — check `npm test`)
Expected: PASS, no regressions in unrelated files.

- [ ] **Step 6: Commit**

```bash
git add sigil/cli/sigil.mjs sigil/cli/sigil-peer.test.mjs
git commit -m "feat(sigil): add sigil peer resolve/add/list/get/remove/rotate CLI"
```

---

## Post-plan: update the roadmap

After all four tasks land, update `docs/meta/sigil-cli-roadmap.md`'s federation bullet (currently: "sub-projects #2 (inter-relay trust/discovery), #3 (routing), #4 (cross-federation directory), and #5 (operational tooling) remain unbuilt and unspec'd") to mark #2 done, mirroring how #1 was marked done there, and linking this plan's spec.
