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
- Every mutating action calls `repository.recordAuditEvent(...)` directly (not through `writeRejectionAudit`'s retry wrapper — that's specific to envelope-rejection transaction rollback timing). Event types: `peer.tofu_pinned`, `peer.rotated` (`payload.forced` distinguishes `--confirm`-forced rotation from an audited endpoint-only change), `peer.static_pinned`, `peer.removed`, `peer.key_mismatch_rejected`.
- **No silent widening of ANY unauthenticated field.** `resolvePeer` never auto-accepts a changed `keys`, `relayUrl`, or `wsUrl` from an unauthenticated discovery response, even if the previously-pinned key is still present in the response — a public key is public (proves nothing about current domain control), and an endpoint is exactly as unauthenticated as a key. Any change to any of the three throws `PEER_KEY_MISMATCH`; the operator must run `sigil peer rotate <domain> --confirm` to accept it. (Reviewed 2026-08-25: eng review + Codex outside-voice both flagged the original design — key grace-accept, and separately auto-accepting endpoint changes on an audit-only basis — as inconsistent: "audit is observation, not authorization." Both are now the same fail-closed path.)
- **Domain input is validated before use.** `discoverPeer` and every `sigil peer <subcommand>` CLI entry point call the repo's existing `parseDomain()` (`sigil/relay/v1/federated-id.mjs`, already used by `sigil.mjs`'s other domain-taking commands) before any fetch or repository call. A malformed domain (embedded path/credentials/query, invalid port) is rejected with `INVALID_DOMAIN_SYNTAX`/`INVALID_PORT` instead of silently becoming a wrong fetch target or a duplicate-looking trust record.
- **`sigil peer add` reuses `discoverPeer`'s validators**, not just a manual field-presence check. A statically-pinned peer's `--relay-url`/`--ws-url` and key entry go through the same `isValidEndpointUrl`/`isValidWsEndpointUrl`/key-shape checks a discovered peer does, exported from `peer-discovery.mjs`. Static pin is the higher-trust path (it bypasses TOFU entirely); it should not accept a less-validated record than discovery does.
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

test('discoverPeer rejects a non-wss ws_endpoint (an https:// URL is not a valid WebSocket scheme)', async () => {
  const fetchImpl = async () => jsonResponse({ ...VALID_BODY, relay: { ...VALID_BODY.relay, ws_endpoint: 'https://relay.example.com/stream' } });
  await assert.rejects(() => discoverPeer('relay.example.com', { fetchImpl }), { code: 'PEER_INVALID_ENDPOINT' });
});

test('discoverPeer rejects a malformed domain before making any fetch call', async () => {
  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return jsonResponse(VALID_BODY); };
  await assert.rejects(() => discoverPeer('not a domain/with path', { fetchImpl }), { code: 'INVALID_DOMAIN_SYNTAX' });
  assert.equal(fetchCalled, false);
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

export function isValidEndpointUrl(url) {
  if (typeof url !== 'string') return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && process.env.NODE_ENV !== 'production';
}

// Separate from isValidEndpointUrl because ws_endpoint is a WebSocket URL,
// not an HTTP one -- wss:/ws: are the correct schemes, not https:/http:.
// (Caught by Codex outside-voice: the original single validator applied to
// both fields would reject the plan's own valid wss:// test fixture.)
export function isValidWsEndpointUrl(url) {
  if (typeof url !== 'string') return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol === 'wss:') return true;
  return parsed.protocol === 'ws:' && process.env.NODE_ENV !== 'production';
}

export function isValidKeyEntry(key) {
  return typeof key?.kid === 'string' && key.kid.length > 0 && key.alg === 'Ed25519' && typeof key.publicKey === 'string' && key.publicKey.length > 0;
}

export async function discoverPeer(domain, { fetchImpl = fetch } = {}) {
  const { parseDomain } = await import('./federated-id.mjs');
  parseDomain(domain); // throws INVALID_DOMAIN_SYNTAX / INVALID_PORT before any fetch or repository call
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
  if (data.relay.ws_endpoint !== undefined && !isValidWsEndpointUrl(data.relay.ws_endpoint)) {
    throw peerError(`Invalid relay.ws_endpoint in .well-known/sigil response for "${domain}"`, 'PEER_INVALID_ENDPOINT', { domain });
  }
  if (!Array.isArray(data.keys) || data.keys.length === 0) {
    throw peerError(`.well-known/sigil response for "${domain}" has no keys`, 'PEER_NO_KEYS', { domain });
  }
  for (const key of data.keys) {
    if (!isValidKeyEntry(key)) {
      throw peerError(`.well-known/sigil response for "${domain}" has an invalid key entry`, 'PEER_INVALID_KEY', { domain });
    }
  }
  return { domain, relayUrl: data.relay.endpoint, wsUrl: data.relay.ws_endpoint ?? null, keys: data.keys };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test sigil/relay/v1/peer-discovery.test.mjs`
Expected: PASS (all 15 tests)

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

test('resolvePeer rejects a key-set change even when the previously pinned key is still present (no silent grace-accept)', async () => {
  const repository = createMemoryRepository();
  await resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(BODY_V1) });
  const widenedBody = { ...BODY_V1, keys: [...BODY_V1.keys, { kid: 'k2', alg: 'Ed25519', publicKey: 'pub-2' }] };
  await assert.rejects(
    () => resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(widenedBody) }),
    (error) => error.code === 'PEER_KEY_MISMATCH',
  );
  const stored = await repository.getPeerByDomain('relay.example.com');
  assert.deepEqual(stored.keys, BODY_V1.keys); // untouched -- only "sigil peer rotate --confirm" can accept a new key set
});

test('resolvePeer rejects an endpoint-only change (relayUrl differs, keys unchanged) -- endpoint is exactly as unauthenticated as a key', async () => {
  const repository = createMemoryRepository();
  await resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(BODY_V1) });
  const movedBody = { ...BODY_V1, relay: { endpoint: 'https://relay.example.com/v2' } };
  await assert.rejects(
    () => resolvePeer('relay.example.com', repository, { fetchImpl: makeFetch(movedBody) }),
    (error) => error.code === 'PEER_KEY_MISMATCH' && error.endpointChanged === true && error.keysChanged === false,
  );
  const stored = await repository.getPeerByDomain('relay.example.com');
  assert.equal(stored.relayUrl, 'https://relay.example.com/v1'); // untouched -- only "sigil peer rotate --confirm" can accept
  const events = repository._debugGetAuditEvents();
  assert.equal(events[events.length - 1].event_type, 'peer.key_mismatch_rejected');
  assert.equal(events[events.length - 1].payload.endpointChanged, true);
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
// Structured comparison, not a delimiter-joined string -- kid/publicKey are
// untrusted response data, and a naive `${kid}:${publicKey}` join could let
// two distinct key sets collide (or a mismatched set compare equal) if either
// field ever contained the join delimiter. (Caught by Codex outside-voice.)
function sameKeySet(a, b) {
  if (a.length !== b.length) return false;
  const normalize = (keys) => [...keys].map((k) => ({ kid: k.kid, alg: k.alg, publicKey: k.publicKey })).sort((x, y) => (x.kid < y.kid ? -1 : x.kid > y.kid ? 1 : 0));
  const na = normalize(a);
  const nb = normalize(b);
  return na.every((k, i) => k.kid === nb[i].kid && k.alg === nb[i].alg && k.publicKey === nb[i].publicKey);
}

function auditPayload(discovered, extra = {}) {
  return { relayUrl: discovered.relayUrl, keys: discovered.keys, ...extra };
}

export async function resolvePeer(domain, repository, { fetchImpl = fetch, now = new Date() } = {}) {
  const { parseDomain } = await import('./federated-id.mjs');
  parseDomain(domain);
  const existing = await repository.getPeerByDomain(domain);
  if (existing && existing.trustMode === 'static') return existing;

  const discovered = await discoverPeer(domain, { fetchImpl });

  if (!existing) {
    const record = await repository.upsertPeer({ domain, relayUrl: discovered.relayUrl, wsUrl: discovered.wsUrl, keys: discovered.keys, trustMode: 'tofu', now });
    await repository.recordAuditEvent({ eventType: 'peer.tofu_pinned', subjectId: domain, objectType: 'peer_relay', objectId: domain, outcome: 'accepted', payload: auditPayload(discovered), now });
    return record;
  }

  // No grace-accept for ANY unauthenticated field -- keys, relayUrl, and
  // wsUrl are all just data in an unauthenticated HTTP response. A public
  // key being "still present" proves nothing about who controls the domain
  // right now, and an endpoint is exactly as unauthenticated as a key --
  // treating them differently (audit-only for endpoint, reject for keys) was
  // an inconsistent security posture (eng review + Codex outside-voice,
  // 2026-08-25). Any change to keys, relayUrl, or wsUrl is rejected exactly
  // like a full mismatch; the operator must run
  // `sigil peer rotate <domain> --confirm` to accept it.
  const keysChanged = !sameKeySet(existing.keys, discovered.keys);
  const endpointChanged = existing.relayUrl !== discovered.relayUrl || existing.wsUrl !== discovered.wsUrl;
  if (keysChanged || endpointChanged) {
    await repository.recordAuditEvent({ eventType: 'peer.key_mismatch_rejected', subjectId: domain, objectType: 'peer_relay', objectId: domain, outcome: 'rejected', payload: { pinnedKeys: existing.keys, fetchedKeys: discovered.keys, pinnedRelayUrl: existing.relayUrl, fetchedRelayUrl: discovered.relayUrl, pinnedWsUrl: existing.wsUrl, fetchedWsUrl: discovered.wsUrl, keysChanged, endpointChanged }, now });
    throw peerError(`Peer "${domain}" changed: run "sigil peer rotate ${domain} --confirm" to accept it`, 'PEER_KEY_MISMATCH', { domain, pinnedKeys: existing.keys, fetchedKeys: discovered.keys, keysChanged, endpointChanged });
  }

  // Nothing changed -- a silent re-confirmation, no new audit event.
  return repository.upsertPeer({ domain, relayUrl: discovered.relayUrl, wsUrl: discovered.wsUrl, keys: discovered.keys, trustMode: 'tofu', now });
}

export async function rotatePeer(domain, repository, { fetchImpl = fetch, now = new Date() } = {}) {
  const { parseDomain } = await import('./federated-id.mjs');
  parseDomain(domain);
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

test('sigil peer add rejects a non-https --relay-url', async () => {
  const { stderr, exitCode } = await run(['peer', 'add', 'relay.example.com', '--relay-url', 'ftp://relay.example.com', '--public-key', 'pub-1', '--kid', 'k1', '--database-url', 'postgres://placeholder']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /--relay-url/);
});

test('sigil peer add rejects a malformed domain', async () => {
  const { stderr, exitCode } = await run(['peer', 'add', 'not a domain', '--relay-url', 'https://relay.example.com/v1', '--public-key', 'pub-1', '--kid', 'k1', '--database-url', 'postgres://placeholder']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /INVALID_DOMAIN_SYNTAX/);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test sigil/cli/sigil-peer.test.mjs`
Expected: FAIL — `sigil peer` isn't wired into `main()` yet, so every case currently falls through to `usage()` and exits 0, not 1.

- [ ] **Step 3a: Extract `withRepository()` and refactor the existing `cmdOidcIssuer*` commands onto it**

Eng review flagged that this task was about to take sigil.mjs's inline `import pg` +
`new pg.Pool()` + `try { ... } finally { pool.end() }` boilerplate from 3 copies
(`cmdOidcIssuerAdd`/`List`/`Remove`) to 9 (adding 6 more `cmdPeer*` copies). Extract
it once, refactor the existing 3 onto it, and Step 3b's peer commands use it from
the start — no new duplication introduced.

Add to `sigil/cli/sigil.mjs`, right before `cmdOidcIssuerAdd`:

```js
// Shared by every command that needs a durable (Postgres-backed) repository:
// resolve --database-url/SIGIL_DATABASE_URL, optionally migrate, open a pool,
// run fn(repository), always close the pool. `requireDatabaseUrl` is the
// command-specific error message so each caller keeps its own wording.
async function withRepository(args, requireDatabaseUrl, fn, { migrate = false } = {}) {
  const databaseUrl = opt(args, ['database-url']) ?? process.env.SIGIL_DATABASE_URL;
  if (!databaseUrl) throw new Error(requireDatabaseUrl);
  if (migrate) {
    const { applyMigrations } = await import('../scripts/apply-migrations.mjs');
    await applyMigrations(databaseUrl);
  }
  const { PostgresRepository } = await import('../relay/v1/postgres-repository.mjs');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    return await fn(new PostgresRepository({ pool }));
  } finally {
    await pool.end();
  }
}
```

Refactor the three existing commands to call it (behavior unchanged, just de-duplicated):

```js
async function cmdOidcIssuerAdd(argv) {
  const args = parseArgs({ args: argv, options: { 'client-id': { type: 'string' }, label: { type: 'string' }, assurance: { type: 'string' }, 'database-url': { type: 'string' } }, allowPositionals: true });
  const issuer = args.positionals[0];
  const clientId = opt(args, ['client-id']);
  if (!issuer || !clientId) throw new Error('usage: sigil oidc-issuer add <issuer> --client-id <id> [--label text] [--assurance level] [--database-url url]');
  await withRepository(args, 'sigil oidc-issuer add requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable allow-list to provision', async (repository) => {
    await repository.upsertOidcIssuerAllowlist({ issuer, clientId, displayLabel: opt(args, ['label']) ?? issuer, assuranceLevel: opt(args, ['assurance']) ?? 'standard' });
    console.log(`Added ${issuer} (client_id ${clientId}) to the OIDC issuer allow-list. Restart the relay to pick it up.`);
  }, { migrate: true });
}

async function cmdOidcIssuerList(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' } } });
  await withRepository(args, 'sigil oidc-issuer list requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable allow-list to list', async (repository) => {
    const entries = await repository.listOidcIssuerAllowlist({ includeDisabled: true });
    for (const entry of entries) console.log(`${entry.issuer}\t${entry.clientId ?? ''}\t${entry.enabled}\t${entry.assuranceLevel}`);
  });
}

async function cmdOidcIssuerRemove(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' } }, allowPositionals: true });
  const issuer = args.positionals[0];
  if (!issuer) throw new Error('usage: sigil oidc-issuer remove <issuer> [--database-url url]');
  await withRepository(args, 'sigil oidc-issuer remove requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable allow-list to modify', async (repository) => {
    await repository.disableOidcIssuerAllowlist(issuer);
    console.log(`Disabled ${issuer} in the OIDC issuer allow-list. Restart the relay, or wait for the next poll, to pick it up.`);
  });
}
```

Run `node --test sigil/cli/sigil-oidc-issuer-add.test.mjs sigil/cli/sigil-oidc-issuer-list-remove.test.mjs` — expect PASS, no behavior change.

- [ ] **Step 3b: Implement the `sigil peer` subcommands on `withRepository()`**

Add to `sigil/cli/sigil.mjs`, right after `cmdOidcIssuerRemove` (before `printDoctorReport`):

```js
async function cmdPeerResolve(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' } }, allowPositionals: true });
  const domain = args.positionals[0];
  if (!domain) throw new Error('usage: sigil peer resolve <domain> [--database-url url]');
  try {
    await withRepository(args, 'sigil peer resolve requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory', async (repository) => {
      const { resolvePeer } = await import('../relay/v1/peer-discovery.mjs');
      const record = await resolvePeer(domain, repository);
      console.log(JSON.stringify(record, null, 2));
    }, { migrate: true });
  } catch (error) {
    if (error.code === 'PEER_KEY_MISMATCH') {
      console.error(`sigil peer resolve: key set changed for "${domain}"`);
      console.error(`  pinned:  ${error.pinnedKeys.map((k) => `${k.kid}=${k.publicKey}`).join(', ')}`);
      console.error(`  fetched: ${error.fetchedKeys.map((k) => `${k.kid}=${k.publicKey}`).join(', ')}`);
      console.error(`  Run "sigil peer rotate ${domain} --confirm" to accept the new key set.`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

async function cmdPeerAdd(argv) {
  const args = parseArgs({ args: argv, options: { 'relay-url': { type: 'string' }, 'ws-url': { type: 'string' }, 'public-key': { type: 'string' }, kid: { type: 'string' }, 'database-url': { type: 'string' } }, allowPositionals: true });
  const domain = args.positionals[0];
  const relayUrl = opt(args, ['relay-url']);
  const publicKey = opt(args, ['public-key']);
  const kid = opt(args, ['kid']);
  if (!domain || !relayUrl || !publicKey || !kid) throw new Error('usage: sigil peer add <domain> --relay-url <url> --public-key <key> --kid <id> [--ws-url <url>] [--database-url url]');
  const { parseDomain } = await import('../relay/v1/federated-id.mjs');
  parseDomain(domain); // throws INVALID_DOMAIN_SYNTAX / INVALID_PORT before anything else runs
  const { isValidEndpointUrl, isValidWsEndpointUrl, isValidKeyEntry } = await import('../relay/v1/peer-discovery.mjs');
  if (!isValidEndpointUrl(relayUrl)) throw new Error(`sigil peer add: --relay-url "${relayUrl}" is not a valid https:// URL`);
  const wsUrl = opt(args, ['ws-url']) ?? null;
  if (wsUrl !== null && !isValidWsEndpointUrl(wsUrl)) throw new Error(`sigil peer add: --ws-url "${wsUrl}" is not a valid wss:// URL`);
  if (!isValidKeyEntry({ kid, alg: 'Ed25519', publicKey })) throw new Error('sigil peer add: --kid/--public-key must be non-empty');
  await withRepository(args, 'sigil peer add requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory', async (repository) => {
    await repository.upsertPeer({ domain, relayUrl, wsUrl, keys: [{ kid, alg: 'Ed25519', publicKey }], trustMode: 'static' });
    await repository.recordAuditEvent({ eventType: 'peer.static_pinned', subjectId: domain, objectType: 'peer_relay', objectId: domain, outcome: 'accepted', payload: { relayUrl, kid } });
    console.log(`Statically pinned ${domain} -> ${relayUrl} (kid ${kid}).`);
  }, { migrate: true });
}

async function cmdPeerList(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' } } });
  await withRepository(args, 'sigil peer list requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory', async (repository) => {
    const peers = await repository.listPeers();
    for (const peer of peers) console.log(`${peer.domain}\t${peer.relayUrl}\t${peer.trustMode}\t${peer.keys.map((k) => k.kid).join(',')}`);
  });
}

async function cmdPeerGet(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' } }, allowPositionals: true });
  const domain = args.positionals[0];
  if (!domain) throw new Error('usage: sigil peer get <domain> [--database-url url]');
  const { parseDomain: parseDomainGet } = await import('../relay/v1/federated-id.mjs');
  parseDomainGet(domain);
  await withRepository(args, 'sigil peer get requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory', async (repository) => {
    const peer = await repository.getPeerByDomain(domain);
    console.log(peer ? JSON.stringify(peer, null, 2) : `No peer pinned for "${domain}".`);
  });
}

async function cmdPeerRemove(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' } }, allowPositionals: true });
  const domain = args.positionals[0];
  if (!domain) throw new Error('usage: sigil peer remove <domain> [--database-url url]');
  const { parseDomain: parseDomainRemove } = await import('../relay/v1/federated-id.mjs');
  parseDomainRemove(domain);
  await withRepository(args, 'sigil peer remove requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory', async (repository) => {
    const removed = await repository.removePeer(domain);
    if (removed) {
      await repository.recordAuditEvent({ eventType: 'peer.removed', subjectId: domain, objectType: 'peer_relay', objectId: domain, outcome: 'accepted', payload: {} });
      console.log(`Removed peer pin for "${domain}".`);
    } else {
      console.log(`No peer pinned for "${domain}".`);
    }
  });
}

async function cmdPeerRotate(argv) {
  const args = parseArgs({ args: argv, options: { confirm: { type: 'boolean' }, 'database-url': { type: 'string' } }, allowPositionals: true });
  const domain = args.positionals[0];
  if (!domain) throw new Error('usage: sigil peer rotate <domain> --confirm [--database-url url]');
  if (!args.values.confirm) throw new Error('sigil peer rotate requires --confirm -- this force-overwrites a pinned peer key without the usual TOFU mismatch check');
  await withRepository(args, 'sigil peer rotate requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory', async (repository) => {
    const { rotatePeer } = await import('../relay/v1/peer-discovery.mjs');
    const record = await rotatePeer(domain, repository);
    console.log(JSON.stringify(record, null, 2));
  }, { migrate: true });
}
```

All 9 `cmd*` functions (3 existing oidc-issuer + 6 new peer) now share one pool-lifecycle helper — no per-function duplication.

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
Expected: PASS (all 9 tests)

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `node --test sigil/**/*.test.mjs` (or however this repo's `package.json` `test` script is invoked — check `npm test`)
Expected: PASS, no regressions in unrelated files.

- [ ] **Step 6: Commit**

```bash
git add sigil/cli/sigil.mjs sigil/cli/sigil-peer.test.mjs
git commit -m "feat(sigil): add sigil peer resolve/add/list/get/remove/rotate CLI"
```

---

### Task 5: Selective expansions — `peer validate-document`, `peer resolve --all`, freshness display

> Added 2026-08-25 via `/plan-ceo-review` (SELECTIVE EXPANSION cherry-pick). Baseline scope (Tasks 1-4) held as-is; these three items were surfaced individually and accepted. A fourth candidate (`sigil doctor` health-ping for pinned peers) was deferred to TODOS.md — different feature shape (multi-target, partial-failure reporting), deserves its own design pass.
>
> Explicitly speculative (outside-voice, `/plan-ceo-review`): `resolve --all` and freshness display are operator-ergonomics tooling for a `peer_relays` directory that has no consumer yet — sub-project #3 (routing) doesn't exist, so nothing reads `relayUrl` in production today. Neither item is load-bearing for anything else in this plan; they're cheap, reused-logic convenience for an operator who has pinned peers and wants to keep them fresh manually (no background poller by design). Kept in scope on that basis, not because anything currently depends on them.

**Files:**
- Modify: `sigil/relay/v1/peer-discovery.mjs` (export a document-shape validator reusable without a network call)
- Modify: `sigil/cli/sigil.mjs` (`cmdPeerValidateDocument`, `cmdPeerResolveAll` + `--all` on `cmdPeerResolve`, freshness formatting in `cmdPeerGet`/`cmdPeerList`)
- Modify: `sigil/cli/sigil-peer.test.mjs`
- Modify: `sigil/relay/v1/peer-discovery.test.mjs`
- Create: `sigil/cli/sigil-peer-resolve-all.integration.test.mjs` (live-DB coverage for `cmdPeerResolveAll`'s actual multi-peer behavior — `/plan-ceo-review` Section 6, finding 6A: the usage-error-only tests in `sigil-peer.test.mjs` don't exercise the feature's core value)

**Interfaces:**
- Produces: `validatePeerDocument(data, { expectedDomain } = {})` in `peer-discovery.mjs` — the same field-shape checks `discoverPeer` runs (self-match only when `expectedDomain` is given, endpoint/ws-endpoint scheme, non-empty key array, key shape), factored out of `discoverPeer` so both the network path and the offline validator share one implementation. Returns `{ domain, relayUrl, wsUrl, keys }` on success; throws the same `PEER_*` codes `discoverPeer` already throws.
- Produces: `sigil peer validate-document <path> [--domain <domain>]` CLI subcommand — reads the file, `JSON.parse`s it, calls `validatePeerDocument`, prints the normalized record or a clear validation error. No repository, no network call, no `--database-url` requirement (this is a pure local check).
- Produces: `sigil peer resolve --all [--database-url url]` — `listPeers()`, filters to `trustMode === 'tofu'`, calls `resolvePeer` per domain sequentially (not concurrent — avoids the exact unordered-write race TODOS.md's CAS item already flags for a single domain; N domains resolved one at a time removes cross-domain surprise ordering, not the same-domain race), prints one result line per domain (`<domain>\tOK` or `<domain>\tPEER_KEY_MISMATCH — run 'sigil peer rotate <domain> --confirm'`), continues past a per-domain failure rather than aborting the batch, exits non-zero if any domain failed.
- Produces: freshness display — `sigil peer get`/`sigil peer list` compute `Math.floor((now - new Date(lastResolvedAt)) / 86400000)` and append `(resolved Nd ago)` / `(resolved today)` to the printed record. Pure formatting on an existing field; no schema change.

- [ ] **Step 1: Write failing tests for `validatePeerDocument`**

```js
// append to sigil/relay/v1/peer-discovery.test.mjs
import { validatePeerDocument } from './peer-discovery.mjs';

test('validatePeerDocument accepts a well-formed document with no domain check', () => {
  const result = validatePeerDocument(VALID_BODY);
  assert.deepEqual(result, {
    domain: 'relay.example.com',
    relayUrl: 'https://relay.example.com:8443/v1',
    wsUrl: 'wss://relay.example.com:8443/v1/stream',
    keys: VALID_BODY.keys,
  });
});

test('validatePeerDocument checks self-match only when expectedDomain is given', () => {
  assert.throws(() => validatePeerDocument(VALID_BODY, { expectedDomain: 'attacker.example.com' }), { code: 'PEER_DOMAIN_MISMATCH' });
  assert.doesNotThrow(() => validatePeerDocument(VALID_BODY, { expectedDomain: 'relay.example.com' }));
});

test('validatePeerDocument rejects an invalid key entry, same as discoverPeer', () => {
  assert.throws(() => validatePeerDocument({ ...VALID_BODY, keys: [{ kid: 'k1', alg: 'RSA', publicKey: 'x' }] }), { code: 'PEER_INVALID_KEY' });
});

test('validatePeerDocument rejects a non-object/null input', () => {
  assert.throws(() => validatePeerDocument(null), { code: 'PEER_MALFORMED_RESPONSE' });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test sigil/relay/v1/peer-discovery.test.mjs`
Expected: FAIL — `validatePeerDocument` is not exported yet.

- [ ] **Step 3: Factor `discoverPeer`'s validation body out into `validatePeerDocument`**

In `sigil/relay/v1/peer-discovery.mjs`, extract the validation block (self-match through the `keys` loop) out of `discoverPeer` into a new exported function, and have `discoverPeer` call it:

```js
export function validatePeerDocument(data, { expectedDomain } = {}) {
  if (data === null || typeof data !== 'object') {
    throw peerError('Malformed .well-known/sigil document: not an object', 'PEER_MALFORMED_RESPONSE', {});
  }
  if (expectedDomain !== undefined && data.domain !== expectedDomain) {
    throw peerError(`.well-known/sigil domain mismatch: expected "${expectedDomain}", got "${data.domain}"`, 'PEER_DOMAIN_MISMATCH', { domain: expectedDomain, responseDomain: data.domain });
  }
  if (!isValidEndpointUrl(data.relay?.endpoint)) {
    throw peerError(`Invalid relay.endpoint in .well-known/sigil document for "${data.domain}"`, 'PEER_INVALID_ENDPOINT', { domain: data.domain });
  }
  if (data.relay.ws_endpoint !== undefined && !isValidWsEndpointUrl(data.relay.ws_endpoint)) {
    throw peerError(`Invalid relay.ws_endpoint in .well-known/sigil document for "${data.domain}"`, 'PEER_INVALID_ENDPOINT', { domain: data.domain });
  }
  if (!Array.isArray(data.keys) || data.keys.length === 0) {
    throw peerError(`.well-known/sigil document for "${data.domain}" has no keys`, 'PEER_NO_KEYS', { domain: data.domain });
  }
  for (const key of data.keys) {
    if (!isValidKeyEntry(key)) {
      throw peerError(`.well-known/sigil document for "${data.domain}" has an invalid key entry`, 'PEER_INVALID_KEY', { domain: data.domain });
    }
  }
  return { domain: data.domain, relayUrl: data.relay.endpoint, wsUrl: data.relay.ws_endpoint ?? null, keys: data.keys };
}
```

Replace the corresponding block inside `discoverPeer` (from the self-match check through the `return` statement) with:

```js
  return validatePeerDocument(data, { expectedDomain: domain });
```

- [ ] **Step 4: Run tests, verify they pass, and re-run Task 1's original `discoverPeer` tests for regressions**

Run: `node --test sigil/relay/v1/peer-discovery.test.mjs`
Expected: PASS — all original `discoverPeer` tests (Task 1) plus the new `validatePeerDocument` tests.

- [ ] **Step 5: Write failing CLI tests**

```js
// append to sigil/cli/sigil-peer.test.mjs
import fs from 'node:fs/promises';
import os from 'node:os';

test('sigil peer validate-document accepts a well-formed file with no network/database access', async () => {
  const file = path.join(os.tmpdir(), `sigil-peer-doc-${Date.now()}.json`);
  await fs.writeFile(file, JSON.stringify({
    domain: 'relay.example.com',
    relay: { endpoint: 'https://relay.example.com/v1' },
    keys: [{ kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' }],
  }));
  const { stdout, exitCode } = await run(['peer', 'validate-document', file]);
  assert.equal(exitCode, 0);
  assert.match(stdout, /relay\.example\.com/);
  await fs.rm(file);
});

test('sigil peer validate-document rejects a malformed file with a clear error, not a stack trace', async () => {
  const file = path.join(os.tmpdir(), `sigil-peer-doc-bad-${Date.now()}.json`);
  await fs.writeFile(file, JSON.stringify({ domain: 'relay.example.com', keys: [] }));
  const { stderr, exitCode } = await run(['peer', 'validate-document', file]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /PEER_NO_KEYS/);
  await fs.rm(file);
});

test('sigil peer validate-document rejects a missing file with a clear error, not a stack trace', async () => {
  const { stderr, exitCode } = await run(['peer', 'validate-document', path.join(os.tmpdir(), 'does-not-exist-sigil-peer-doc.json')]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /cannot read/);
  assert.doesNotMatch(stderr, /at Object\.readFile/); // no raw Node stack trace
});

test('sigil peer validate-document rejects a malformed --domain before touching the file (path need not exist -- domain is validated first)', async () => {
  const { stderr, exitCode } = await run(['peer', 'validate-document', 'unused-nonexistent-path.json', '--domain', 'not a domain']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /INVALID_DOMAIN_SYNTAX/);
});

test('sigil peer validate-document requires a path', async () => {
  const { stderr, exitCode } = await run(['peer', 'validate-document']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /usage: sigil peer validate-document/);
});

test('sigil peer resolve --all requires --database-url when SIGIL_DATABASE_URL is unset', async () => {
  const { stderr, exitCode } = await run(['peer', 'resolve', '--all']);
  assert.equal(exitCode, 1);
  assert.match(stderr, /--database-url/);
});

test('freshness formats today, N days ago, and never resolved', async () => {
  const { freshness } = await import('./sigil.mjs');
  const now = new Date('2026-08-25T12:00:00Z');
  assert.equal(freshness('2026-08-25T01:00:00Z', now), 'resolved today');
  assert.equal(freshness('2026-08-22T12:00:00Z', now), 'resolved 3d ago');
  assert.equal(freshness(null, now), 'never resolved');
});
```

- [ ] **Step 6: Run tests, verify they fail**

Run: `node --test sigil/cli/sigil-peer.test.mjs`
Expected: FAIL — `validate-document` and `resolve --all` aren't wired into `main()` yet.

- [ ] **Step 7: Implement `cmdPeerValidateDocument`, `--all` on `cmdPeerResolve`, and freshness display**

Add to `sigil/cli/sigil.mjs`, right after `cmdPeerResolve`:

```js
async function cmdPeerValidateDocument(argv) {
  const args = parseArgs({ args: argv, options: { domain: { type: 'string' } }, allowPositionals: true });
  const filePath = args.positionals[0];
  if (!filePath) throw new Error('usage: sigil peer validate-document <path> [--domain <domain>]');
  const expectedDomain = opt(args, ['domain']);
  if (expectedDomain !== undefined) {
    const { parseDomain } = await import('../relay/v1/federated-id.mjs');
    parseDomain(expectedDomain); // keeps "every sigil peer subcommand validates domain input" true with no exception (/plan-ceo-review outside-voice finding OV2)
  }
  const { validatePeerDocument } = await import('../relay/v1/peer-discovery.mjs');
  let raw;
  try {
    raw = await (await import('node:fs/promises')).readFile(filePath, 'utf8');
  } catch (error) {
    console.error(`sigil peer validate-document: cannot read "${filePath}": ${error.code ?? error.message}`);
    process.exitCode = 1;
    return;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error(`sigil peer validate-document: "${filePath}" is not valid JSON`);
    process.exitCode = 1;
    return;
  }
  try {
    const record = validatePeerDocument(data, { expectedDomain });
    console.log(`Valid .well-known/sigil document for "${record.domain}".`);
    console.log(JSON.stringify(record, null, 2));
  } catch (error) {
    console.error(`sigil peer validate-document: ${error.code} — ${error.message}`);
    process.exitCode = 1;
  }
}
```

Add a `freshness(lastResolvedAt, now = new Date())` helper near `withRepository`, exported for
direct unit testing (matching the file's existing precedent of exporting `startOidcIssuerAllowlistPolling`
for the same reason — `/plan-ceo-review` Section 6, finding 6B: this new user-facing text had zero
test coverage):

```js
// Pure formatting on an already-stored field -- no schema change. Surfaces
// staleness for an operator, since this plan deliberately has no background
// poller (see Global Constraints) to do it automatically.
export function freshness(lastResolvedAt, now = new Date()) {
  if (!lastResolvedAt) return 'never resolved';
  const days = Math.floor((now - new Date(lastResolvedAt)) / 86400000);
  return days <= 0 ? 'resolved today' : `resolved ${days}d ago`;
}
```

Use it in `cmdPeerGet` and `cmdPeerList`:

```js
    console.log(peer ? `${JSON.stringify(peer, null, 2)}\n(${freshness(peer.lastResolvedAt)})` : `No peer pinned for "${domain}".`);
```

```js
    for (const peer of peers) console.log(`${peer.domain}\t${peer.relayUrl}\t${peer.trustMode}\t${peer.keys.map((k) => k.kid).join(',')}\t(${freshness(peer.lastResolvedAt)})`);
```

Extract the `--all` branch into its own function — `cmdPeerResolve` was branching 7+ times
combined (flag check, loop, nested try/catch, mismatch check, `anyFailed` check, plus the
single-domain path's own try/catch + mismatch check), over the "flag anything branching more
than 5 times" threshold (`/plan-ceo-review` Section 5, finding 5A). Splitting keeps each
function at ≤3 branches with no behavior change — same CLI surface, same tests:

```js
async function cmdPeerResolveAll(args) {
  await withRepository(args, 'sigil peer resolve --all requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory', async (repository) => {
    const { resolvePeer } = await import('../relay/v1/peer-discovery.mjs');
    const peers = (await repository.listPeers()).filter((p) => p.trustMode === 'tofu');
    let anyFailed = false;
    for (const peer of peers) {
      try {
        await resolvePeer(peer.domain, repository);
        console.log(`${peer.domain}\tOK`);
      } catch (error) {
        anyFailed = true;
        const suffix = error.code === 'PEER_KEY_MISMATCH' ? ` — run "sigil peer rotate ${peer.domain} --confirm"` : ` (${error.message})`;
        console.log(`${peer.domain}\t${error.code ?? 'ERROR'}${suffix}`);
      }
    }
    if (anyFailed) process.exitCode = 1;
  }, { migrate: true });
}

async function cmdPeerResolve(argv) {
  const args = parseArgs({ args: argv, options: { 'database-url': { type: 'string' }, all: { type: 'boolean' } }, allowPositionals: true });
  if (args.values.all) return cmdPeerResolveAll(args);
  const domain = args.positionals[0];
  if (!domain) throw new Error('usage: sigil peer resolve <domain> [--database-url url]');
  try {
    await withRepository(args, 'sigil peer resolve requires --database-url (or SIGIL_DATABASE_URL) -- in-memory relays have no durable peer directory', async (repository) => {
      const { resolvePeer } = await import('../relay/v1/peer-discovery.mjs');
      const record = await resolvePeer(domain, repository);
      console.log(JSON.stringify(record, null, 2));
    }, { migrate: true });
  } catch (error) {
    if (error.code === 'PEER_KEY_MISMATCH') {
      console.error(`sigil peer resolve: key set changed for "${domain}"`);
      console.error(`  pinned:  ${error.pinnedKeys.map((k) => `${k.kid}=${k.publicKey}`).join(', ')}`);
      console.error(`  fetched: ${error.fetchedKeys.map((k) => `${k.kid}=${k.publicKey}`).join(', ')}`);
      console.error(`  Run "sigil peer rotate ${domain} --confirm" to accept the new key set.`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}
```

Wire `validate-document` into `main()`'s dispatch chain, alongside the other `peer` branches:

```js
    else if (command === 'peer' && sub === 'validate-document') await cmdPeerValidateDocument(rest);
```

Add to the `usage()` string, after the `peer resolve` line:

```
  peer resolve <domain> [--database-url url]               Discover and TOFU-pin a peer relay via https://<domain>/.well-known/sigil
  peer resolve --all [--database-url url]                  Re-resolve every tofu-pinned peer; continues past per-domain failure, exits non-zero if any failed
  peer validate-document <path> [--domain <domain>]        Validate a local .well-known/sigil JSON file offline -- no network, no database
```

- [ ] **Step 7b: Write the live-DB integration test for `cmdPeerResolveAll`'s actual behavior**

```js
// sigil/cli/sigil-peer-resolve-all.integration.test.mjs
// Covers what sigil-peer.test.mjs's usage-error-only tests can't: --all's
// core value (per-domain OK/failure lines, continue-past-failure, exit
// code) requires seeded rows and a real subprocess run against them.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import fs from 'node:fs/promises';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';

const execFileAsync = promisify(execFile);
const sigilPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'sigil.mjs');
const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function run(args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [sigilPath, ...args], { env: { ...process.env, ...env } });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code };
  }
}

test('sigil peer resolve --all skips static peers entirely -- no network call, empty output, exit 0', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  await pool.query(
    `INSERT INTO peer_relays (domain, relay_url, keys, trust_mode) VALUES ($1, $2, $3, 'static'), ($4, $5, $3, 'static')`,
    ['a.example.com', 'https://a.example.com/v1', JSON.stringify([{ kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' }]), 'b.example.com', 'https://b.example.com/v1']
  );
  const { stdout, exitCode } = await run(['peer', 'resolve', '--all'], { SIGIL_DATABASE_URL: connectionString });
  assert.equal(exitCode, 0); // both static -- filtered out before any fetch, empty loop
  assert.equal(stdout.trim(), '');
});

test('sigil peer resolve --all prints a real OK line for a tofu peer that successfully re-resolves', { skip: !connectionString }, async (t) => {
  // Outside-voice finding (/plan-ceo-review, cross-model): the prior version of this
  // test file asserted only the static-peer no-op path -- the actual "<domain>\tOK"
  // success line (the feature's whole point) had zero coverage because it needs a
  // real HTTPS peer to resolve against. A throwaway local http server, with
  // NODE_ENV=test so the http:// (not https://) endpoint passes isValidEndpointUrl
  // per Global Constraints, closes that gap without a live second Sigil relay.
  const http = await import('node:http');
  const KEYS = [{ kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' }];
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ domain: `127.0.0.1:${server.address().port}`, relay: { endpoint: `http://127.0.0.1:${server.address().port}/v1` }, keys: KEYS }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const domain = `127.0.0.1:${server.address().port}`;

  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  await pool.query(
    `INSERT INTO peer_relays (domain, relay_url, keys, trust_mode) VALUES ($1, $2, $3, 'tofu')`,
    [domain, `http://127.0.0.1:${server.address().port}/v1`, JSON.stringify(KEYS)]
  );
  const { stdout, exitCode } = await run(['peer', 'resolve', '--all'], { SIGIL_DATABASE_URL: connectionString, NODE_ENV: 'test' });
  assert.equal(exitCode, 0);
  assert.match(stdout, new RegExp(`${domain.replace('.', '\\.')}\\tOK`));

  // Outside-voice finding OV4: only the pure freshness() formatter had a unit test --
  // nothing asserted cmdPeerGet actually wires it into real output. resolve --all
  // just set lastResolvedAt to now, so `peer get` should show "resolved today".
  const { stdout: getStdout } = await run(['peer', 'get', domain], { SIGIL_DATABASE_URL: connectionString });
  assert.match(getStdout, /\(resolved today\)/);
});

test('sigil peer resolve --all resolves a tofu peer against an unreachable domain and reports failure without aborting', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  // A tofu peer pointed at a domain that will not resolve/respond -- deterministic
  // PEER_DISCOVERY_FAILED without needing a live second relay.
  await pool.query(
    `INSERT INTO peer_relays (domain, relay_url, keys, trust_mode) VALUES ($1, $2, $3, 'tofu')`,
    ['nonexistent.invalid', 'https://nonexistent.invalid/v1', JSON.stringify([{ kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' }])]
  );
  const { stdout, exitCode } = await run(['peer', 'resolve', '--all'], { SIGIL_DATABASE_URL: connectionString });
  assert.equal(exitCode, 1);
  assert.match(stdout, /nonexistent\.invalid\tPEER_DISCOVERY_FAILED \(.+\)/);
  // Regression guard (eng review, this session): the failure line used to print
  // the error code twice -- "PEER_DISCOVERY_FAILED (PEER_DISCOVERY_FAILED)" --
  // because the parenthetical fell back to error.code instead of error.message.
  assert.doesNotMatch(stdout, /PEER_DISCOVERY_FAILED \(PEER_DISCOVERY_FAILED\)/);
});

test('sigil peer resolve --all prints the rotate hint, not a duplicated error code, for a key-mismatch peer', { skip: !connectionString }, async (t) => {
  const http = await import('node:http');
  const KEYS = [{ kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' }];
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ domain: `127.0.0.1:${server.address().port}`, relay: { endpoint: `http://127.0.0.1:${server.address().port}/v1` }, keys: [{ kid: 'k9', alg: 'Ed25519', publicKey: 'pub-9' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const domain = `127.0.0.1:${server.address().port}`;

  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  // Pinned key (k1/pub-1) differs from what the peer now serves (k9/pub-9) -- forces PEER_KEY_MISMATCH.
  await pool.query(
    `INSERT INTO peer_relays (domain, relay_url, keys, trust_mode) VALUES ($1, $2, $3, 'tofu')`,
    [domain, `http://127.0.0.1:${server.address().port}/v1`, JSON.stringify(KEYS)]
  );
  const { stdout, exitCode } = await run(['peer', 'resolve', '--all'], { SIGIL_DATABASE_URL: connectionString, NODE_ENV: 'test' });
  assert.equal(exitCode, 1);
  assert.match(stdout, new RegExp(`${domain.replace('.', '\\.')}\\tPEER_KEY_MISMATCH — run "sigil peer rotate ${domain.replace('.', '\\.')} --confirm"`));
});
```

Run: `SIGIL_TEST_DATABASE_URL=<your local test db url> node --test sigil/cli/sigil-peer-resolve-all.integration.test.mjs`
Expected: PASS (3 tests) if `SIGIL_TEST_DATABASE_URL` is set; skipped cleanly otherwise (safe to defer to CI, same convention as Task 3's Postgres tests).

- [ ] **Step 8: Run tests, verify they pass**

Run: `node --test sigil/cli/sigil-peer.test.mjs sigil/relay/v1/peer-discovery.test.mjs`
Expected: PASS (all tests, original Task 1-4 tests plus new Task 5 tests)

- [ ] **Step 9: Run the full test suite to check for regressions**

Run: `node --test sigil/**/*.test.mjs`
Expected: PASS, no regressions.

- [ ] **Step 10: Commit**

```bash
git add sigil/relay/v1/peer-discovery.mjs sigil/relay/v1/peer-discovery.test.mjs sigil/cli/sigil.mjs sigil/cli/sigil-peer.test.mjs sigil/cli/sigil-peer-resolve-all.integration.test.mjs
git commit -m "feat(sigil): add peer validate-document, resolve --all, freshness display"
```

---

## NOT in scope

- **Publishing this relay's own `.well-known/sigil` document.** This plan only builds the discovery *consumer*. Producing/serving the document is deferred — see TODOS.md.
- **Envelope forwarding / actually routing to a peer relay.** Explicitly sub-project #3 per the roadmap; this plan is trust/discovery only.
- **IP-range/loopback/private-range SSRF guardrails, DNS-rebinding socket pinning.** Matches `oidc-client.mjs`'s existing precedent (https-only + timeout + no-redirect + self-match). Revisit once sub-project #3 makes peer relays a live routing target, not before.
- **Background polling/refresh timer for pinned peers.** Purely on-demand via `sigil peer resolve`, matching the plan's explicit no-hot-path-discovery constraint.
- **Transactional mutation+audit writes.** Pre-existing repo-wide gap (see TODOS.md); fixing it only for the two new peer-relay methods would be inconsistent with every other mutation in `postgres-repository.mjs`.
- **Optimistic concurrency / CAS on `upsertPeer`.** No current caller creates realistic concurrent-write pressure (manual CLI only); see TODOS.md.
- **IDNA/punycode, IPv6 literals.** Peer domains are plain ASCII hostnames exactly as `federated-id.mjs`'s `parseDomain` already defines them; this plan doesn't touch that grammar.
- **`sigil doctor` health-ping for pinned peer relays.** Considered as a Task 5 candidate during `/plan-ceo-review` and deferred to TODOS.md — multi-target, partial-failure reachability reporting is a different feature shape than `sigil doctor`'s current single-`--relay-url` check and deserves its own small design pass.

## What already exists

- **`oidc_issuer_allowlist` add/list/remove shape** (`memory-repository.mjs`, `postgres-repository.mjs`, migration `014_oidc_issuer_client_id.sql`) — this plan's `PeerRelayRepository` methods mirror it directly (upsert/get/list/remove, camelCase record shape, `--database-url`-required CLI pattern). Reused, not rebuilt.
- **`oidc-client.mjs`'s `outboundFetchOptions()`** (fixed timeout + no-follow redirect) — `peer-discovery.mjs`'s fetch options mirror this exactly, same rationale (hung/redirecting peer can't hold the request open or redirect trust).
- **`federated-id.mjs`'s `parseDomain()`** — already used by `sigil.mjs` for other domain-taking commands; this review's fixes wire it into `discoverPeer`/`resolvePeer`/`rotatePeer`/all `sigil peer` CLI entry points, closing a gap where the plan's original draft never called it.
- **`recordAuditEvent`'s generic contract** on both repositories — reused as-is for all five new `peer.*` event types, no new audit infrastructure.
- **`apply-migrations.mjs`'s auto-discovery of `.sql` files by sorted filename** — migration `016_peer_relays.sql` needs no manual wiring, confirmed by reading the file (no per-migration entry required for new files).

## Failure modes

| Codepath | Realistic production failure | Test? | Error handling? | User-visible? |
|---|---|---|---|---|
| `discoverPeer` fetch | Peer's `.well-known/sigil` times out or DNS fails | Yes (Task 1) | Yes — `PEER_DISCOVERY_FAILED` | Clear CLI error |
| `discoverPeer` JSON parse | Peer returns HTML error page instead of JSON | Yes (Task 1) | Yes — `PEER_MALFORMED_RESPONSE` | Clear CLI error |
| `discoverPeer` domain proxy | Response proxied from/served by unexpected host | Yes (Task 1) | Yes — `PEER_DOMAIN_MISMATCH` | Clear CLI error |
| `resolvePeer` key-set change | Legitimate key rotation OR active domain compromise | Yes (this review) | Yes — rejects, requires `--confirm` | Clear CLI error + fingerprint diff |
| `resolvePeer` endpoint change | Legitimate ops move OR MITM redirect | Yes (this review) | Yes — rejects, requires `--confirm` | Clear CLI error + fingerprint diff |
| `resolvePeer`/`rotatePeer` domain input | Operator typo, malformed domain | Yes (this review) | Yes — `parseDomain` throws before any fetch/write | Clear CLI error |
| `cmdPeerAdd` static pin | Operator typo in `--relay-url`/`--kid`/`--public-key` | Yes (this review) | Yes — rejects before any write | Clear CLI error |
| Postgres pool/connection failure | DB unreachable, bad `--database-url` | No — matches existing `oidc-issuer` CLI test convention (unverified via CLI, only via repository-level Postgres integration tests gated on `SIGIL_TEST_DATABASE_URL`) | Yes — `pg` throws, propagates to `main()`'s top-level catch | Clear CLI error (`sigil: <message>`), no stack trace |
| Concurrent `resolvePeer` for same domain | Two terminal invocations race | No (TODOS.md — deferred, no current trigger) | No — last-write-wins | Silent (no error, but state could differ from operator's expectation) |
| `sigil peer resolve --all` per-domain failure | One pinned peer unreachable/mismatched, others fine | Yes (Task 5) | Yes — continues past the failure, prints per-domain result, exits non-zero if any failed | Clear per-line CLI output, no aborted batch |
| `sigil peer validate-document` malformed file | Operator hand-writes a bad JSON file or invalid `.well-known/sigil` shape | Yes (Task 5) | Yes — `JSON.parse` failure and `PEER_*` validation errors both caught, printed with the error code, no stack trace | Clear CLI error |
| `sigil peer validate-document` missing/unreadable file | Operator typo in `<path>` | Yes (Task 5, `/plan-ceo-review` gap 2A) | Yes — `readFile` wrapped in try/catch, prints `cannot read "<path>": <reason>` | Clear CLI error, no stack trace |
| `sigil peer resolve --all` pool death mid-loop | Postgres connection lost partway through a multi-peer batch | No (accepted, `/plan-ceo-review` gap 2B — same as the pre-existing Postgres pool/connection failure row above, not a new failure mode) | Yes — propagates to `main()`'s top-level catch, same as every other command | Clear top-level CLI error, no stack trace, no partial-progress summary |

No critical gap: every codepath with no test also has no error-handling gap and is not silent (the concurrent-write case is the one exception, tracked in TODOS.md as low-priority given no current automated caller). Task 5's `resolve --all` deliberately does not add its own concurrency control beyond sequential per-domain iteration — see TODOS.md's CAS item for the underlying same-domain race, which `--all` does not introduce or worsen (it only iterates *different* domains one at a time).

## Dream state delta

```
  CURRENT STATE                     THIS PLAN                              12-MONTH IDEAL (full federation)
  Addressing lands (#1): domain- --> Trust/discovery (#2): operator     --> #3 routing dials a pinned peer to
  qualified IDs, foreign            can discover + durably pin a          forward envelopes; #4 cross-fed
  recipients rejected with          peer relay's endpoint+keys via        directory finds peers without a
  RECIPIENT_NOT_LOCAL, no way       .well-known/sigil, fail-closed        prior manual pin; #5 ops tooling
  to learn where a foreign          TOFU with rotation detection.         (health dashboards, alerting) makes
  relay actually lives.             CLI-only, no envelope forwarding.     running a relay routine, not manual.
```

This plan is the second of five links, and closes exactly the gap it targets — `RECIPIENT_NOT_LOCAL` was a dead end with no follow-up path; after this lands, an operator has one. It does not create the producer side (`.well-known/sigil` publisher, TODOS.md T1) or routing (#3), so two live relays still can't fully federate end-to-end without a human hand-writing the peer's document — that remains the honest state of the roadmap, not a gap this plan silently leaves unaddressed.

## Worktree parallelization strategy

| Step | Modules touched | Depends on |
|------|----------------|------------|
| Task 1: `discoverPeer` | `sigil/relay/v1/` (new file) | — |
| Task 2: memory repository + `resolvePeer`/`rotatePeer` | `sigil/relay/v1/`, `sigil/cli/` (memory-repository.mjs) | Task 1 (imports `discoverPeer`) |
| Task 3: Postgres migration + repository | `sigil/relay/v1/`, `sigil/migrations/` | — (interface fully specified by Task 2's documented signatures; does not need Task 2's actual code, only the agreed shape) |
| Task 4: CLI surface | `sigil/cli/` (sigil.mjs) | Task 2 (imports `resolvePeer`/`rotatePeer`), Task 3 (imports `PostgresRepository` peer methods) |
| Task 5: selective expansions | `sigil/relay/v1/peer-discovery.mjs`, `sigil/cli/sigil.mjs` | Task 2 (factors `discoverPeer`'s validation into `validatePeerDocument`), Task 4 (`cmdPeerResolve`/`cmdPeerGet`/`cmdPeerList` already exist to extend) |

Lane A: Task 1 → Task 2 (sequential, shared `sigil/relay/v1/peer-discovery.mjs`)
Lane B: Task 3 (independent — needs only the interface contract already documented in Task 2's plan text, not Task 2's actual implementation)

Launch A + B in parallel worktrees. Merge both. Then Task 4 (waits on both). Then Task 5 (waits on Task 4 — extends `cmdPeerResolve`/`cmdPeerGet`/`cmdPeerList`, which don't exist until Task 4 lands).

No conflict flag: Lane A and Lane B touch disjoint files (`peer-discovery.mjs`+`memory-repository.mjs` vs. `postgres-repository.mjs`+migration) — no merge risk.

## Implementation Tasks

All findings from this review were fixed directly in the plan text above (not deferred as follow-up tasks) — the plan as written now reflects every fix. What remains are the three items deferred to TODOS.md:

- [ ] **T1 (P3, human: ~1-2h / CC: ~20min)** — federation — Build a `.well-known/sigil` publisher for this relay's own identity
  - Surfaced by: Codex outside-voice — "no producer-side task in this plan publishes `.well-known/sigil`"
  - Files: new, likely `sigil/relay/v1/` + `sigil/cli/sigil.mjs`
  - Verify: manual round-trip against another local relay instance
- [ ] **T2 (P3, human: ~1-2h / CC: ~20min)** — data — Wrap mutation+audit writes in a transaction, repo-wide
  - Surfaced by: Codex outside-voice — "peer mutation and audit insertion are separate writes"
  - Files: `sigil/relay/v1/postgres-repository.mjs` (all mutating methods, not just this plan's two)
  - Verify: new test asserting rollback on simulated audit-insert failure
- [ ] **T3 (P3, human: ~30min / CC: ~15min)** — data — Add optimistic concurrency (CAS) to `upsertPeer`
  - Surfaced by: Codex outside-voice — "TOFU is read/fetch/write with no lock or compare-and-swap"
  - Files: `sigil/cli/memory-repository.mjs`, `sigil/relay/v1/postgres-repository.mjs`
  - Verify: new test asserting a stale write is rejected/retried under concurrent `resolvePeer` calls

- [ ] **T4 (P3, human: ~1-2h / CC: ~20min)** — observability — `sigil doctor` health-ping for pinned peer relays
  - Surfaced by: `/plan-ceo-review` Section-0D cherry-pick ceremony (SELECTIVE EXPANSION, deferred candidate)
  - Files: `sigil/cli/sigil.mjs` (extend `sigil doctor`), `sigil/relay/v1/peer-discovery.mjs` or new helper
  - Verify: new test asserting per-domain reachable/unreachable reporting against `listPeers()`

_No P1/P2 tasks — every P1-severity finding (TOFU rotation-grace flaw, wss:// validation bug, unvalidated domain input, unvalidated `peer add`, spec/plan contradiction, endpoint-change auto-accept, delimiter-collision) was fixed directly in this review, not deferred. Task 5's own review pass (`/plan-ceo-review`, Sections 2/5/6 + outside-voice) found 8 issues (2A/2B, 5A, 6A/6B, OV1/OV2/OV4/OV5/OV6 — OV3 verified false, OV6 accepted as-is with no change); 7 were fixed directly in the plan text, 1 (OV5) resolved as a documentation-only acknowledgment, 0 deferred._

## Scope Expansion Decisions

SELECTIVE EXPANSION cherry-pick ceremony (`/plan-ceo-review`, full record in `~/.gstack/projects/sorensencc-dotcom-sigil/ceo-plans/2026-08-25-inter-relay-trust-discovery.md`):
- **Accepted:** `sigil peer validate-document`, `sigil peer resolve --all`, freshness display — all folded into Task 5 above.
- **Deferred:** `sigil doctor` health-ping for pinned peers — TODOS.md + Implementation Tasks T4.
- **Skipped:** none.

## Post-plan: update the roadmap

After all four tasks land, update `docs/meta/sigil-cli-roadmap.md`'s federation bullet (currently: "sub-projects #2 (inter-relay trust/discovery), #3 (routing), #4 (cross-federation directory), and #5 (operational tooling) remain unbuilt and unspec'd") to mark #2 done, mirroring how #1 was marked done there, and linking this plan's spec.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | issues_found | 8 findings across Sections 1-11 (Task 5 only — Tasks 1-4 held as prior-reviewed baseline); all fixed in-place |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 (prior session) | issues_found | 9 findings (Tasks 1-4, already fixed) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 (prior + this session) | CLEAR | Prior: 13 findings (Tasks 1-4), all fixed, 3 deferred to TODOS.md as P3. This session (Task 5 only): 1 finding, fixed in-place |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (no UI in this plan — CLI-only) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

**CEO REVIEW (this session):** Mode: SELECTIVE EXPANSION. Held Tasks 1-4 as baseline (already eng-reviewed + Codex-reviewed); cherry-pick ceremony accepted 3 of 4 candidates (`peer validate-document`, `resolve --all`, freshness display — folded into new Task 5) and deferred 1 (`sigil doctor` health-ping — TODOS.md T4). 11-section deep review of Task 5 found: 2A (missing file-read error handling, fixed), 2B (pool-crash mid-`--all`, accepted as pre-existing behavior, no change), 5A (`cmdPeerResolve` over-branching, extracted `cmdPeerResolveAll`), 6A (`--all`'s actual success/failure behavior untested, added live-DB tests), 6B (`freshness()` untested, added unit test). Sections 3/4/7/8/9/10 (Security, Data Flow, Performance, Observability, Deployment, Long-term) and Section 11 (skipped, no UI) found no issues.

**CODEX:** Prior session's Outside Voice pass on Tasks 1-4 (9 findings, all fixed — see history). This session: Codex CLI timed out after 5 minutes on the Task-5-scoped prompt; fell back to a Claude subagent per the skill's non-blocking error handling.

**OUTSIDE VOICE (Claude subagent, this session — Task 5 only):** Found 6 issues: OV1 (`--all`'s success path was untested and the test's own name contradicted what it asserted — added a real mock-server-backed OK-path test), OV2 (`validate-document` skipped the plan's own "every subcommand validates domain input" rule — added `parseDomain` on `--domain`), OV3 (suspected `sigil.mjs` import side-effect risk for the `freshness` test — verified false, `isDirectRun` guard at line 464 already prevents it, no action), OV4 (freshness display wiring itself was untested, only the formatter — added a CLI-level assertion), OV5 (`--all`/freshness are speculative UX for a peer directory with no consumer yet — added an explicit acknowledgment to Task 5's intro, kept in scope), OV6 (`cmdPeerAdd` doesn't reuse `validatePeerDocument` — accepted as-is, different validation shapes, not a real DRY violation).

**CROSS-MODEL:** No cross-model tension this session — Codex didn't produce output (timeout), so there was only one outside voice to weigh against the interactive review, not two to compare against each other.

**VERDICT:** CEO REVIEW CLEARED (Task 5) — all 8 findings resolved (7 fixed in-place, 1 acknowledged in text, 1 verified false, 1 accepted as-is).

**ENG REVIEW (this session, Task 5 only):** Architecture and performance clean — `validatePeerDocument` extraction correctly shares validation logic between the network and offline (`validate-document`) paths, `cmdPeerResolveAll` extraction keeps branching in check, sequential per-domain resolve is the right tradeoff given the documented no-concurrency-control constraint. One code-quality finding: `cmdPeerResolveAll`'s per-domain failure line duplicated the error code in both the tab-separated field and the trailing parenthetical (`PEER_DISCOVERY_FAILED (PEER_DISCOVERY_FAILED)`) because the parenthetical fell back to `error.code` instead of `error.message`; fixed in Step 7's snippet. Test-coverage finding: no test exercised the `--all` PEER_KEY_MISMATCH output line (only OK and PEER_DISCOVERY_FAILED were covered, and the DISCOVERY_FAILED regex wasn't anchored so it wouldn't have caught the duplication) — added a mismatch-branch integration test and a regression-guard assertion on the discovery-failed test, both in Step 7b.

**VERDICT:** ENG REVIEW CLEARED (Task 5). Task 5 is ready to implement.

NO UNRESOLVED DECISIONS
