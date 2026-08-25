# Sigil inter-relay trust/discovery — design

## Problem

Per `docs/meta/sigil-cli-roadmap.md`, federation decomposes into: (1)
addressing, (2) inter-relay trust/discovery, (3) inter-relay routing, (4)
cross-federation directory, (5) operational tooling. Sub-project #1
(addressing) landed 2026-08-25: `endpoint_id`/`owner_id` can be
domain-qualified, and a domain-configured relay rejects a foreign-domain
recipient with `RECIPIENT_NOT_LOCAL` instead of silently swallowing it.

That rejection is a dead end today — a relay has no way to learn *where* a
foreign domain's relay actually lives, or *which key* to trust once it gets
there. This spec (**#2**) closes that: given a domain, an operator can
resolve and durably pin a trusted peer relay record (endpoint URL +
signing keys). It does **not** forward envelopes to that peer — that's
sub-project #3. `RECIPIENT_NOT_LOCAL` behavior is unchanged by this spec.

## Decision

### Discovery mechanism: `.well-known/sigil`

Matrix/OIDC-style HTTPS discovery, mirroring the pattern `oidc-client.mjs`
already established for real-IdP discovery in this repo (see Non-goals for
what's deliberately *not* reused).

`GET https://<domain>/.well-known/sigil` returns:

```json
{
  "domain": "relay.example.com",
  "relay": {
    "endpoint": "https://relay.example.com:8443/v1",
    "ws_endpoint": "wss://relay.example.com:8443/v1/stream"
  },
  "keys": [
    { "kid": "key-2026-08", "alg": "Ed25519", "publicKey": "base64url:..." }
  ]
}
```

Only `alg: "Ed25519"` is accepted — this repo's identities are Ed25519
everywhere (`identity.mjs`); there is no RSA/EC key material anywhere
outside the OIDC-IdP side, and this is not that.

### `sigil/relay/v1/peer-discovery.mjs` (new)

**`discoverPeer(domain, { fetchImpl = fetch } = {})`** — pure network call,
no repository access:

- `GET https://${domain}/.well-known/sigil`, `redirect: 'error'`,
  `AbortSignal.timeout(5000)` — identical shape to `discoverIssuer`'s
  `outboundFetchOptions()`. No IP-range/loopback/private-range SSRF
  guardrails — matches this repo's existing precedent for outbound
  discovery fetches (see Non-goals).
- Non-2xx or fetch failure → `PEER_DISCOVERY_FAILED`.
- Malformed JSON → `PEER_MALFORMED_RESPONSE`.
- `data.domain !== domain` → `PEER_DOMAIN_MISMATCH` (self-match check,
  mirrors `discoverIssuer`'s RFC 8414 §3.3 issuer-match).
- `relay.endpoint` (and `relay.ws_endpoint` if present) must each be a
  well-formed absolute `https://` URL — `http://` is accepted only when
  `NODE_ENV !== 'production'` (test/dev fixtures use plain HTTP servers).
  Malformed or wrong-scheme → `PEER_INVALID_ENDPOINT`.
- `keys` must be a non-empty array (`keys.length === 0` →
  `PEER_NO_KEYS`); every entry needs non-empty string `kid`,
  `alg === 'Ed25519'`, and non-empty string `publicKey` — any violation →
  `PEER_INVALID_KEY`.
- Returns `{ domain, relayUrl, wsUrl, keys }` on success.

**`resolvePeer(domain, repository, { fetchImpl } = {})`** — the TOFU
decision, given a repository (memory or Postgres):

1. `repository.getPeerByDomain(domain)`.
2. No existing record → `discoverPeer`, then
   `repository.upsertPeer({ domain, relayUrl, wsUrl, keys, trustMode: 'tofu' })`,
   audit `peer.tofu_pinned`. Returns the new record.
3. Existing record with `trustMode: 'static'` → return it unchanged, no
   network call. Static pins are operator-authoritative and never
   auto-updated by discovery.
4. Existing record with `trustMode: 'tofu'` → `discoverPeer`, then check
   whether **any** key in the existing record matches **both** `kid` and
   `publicKey` (exact string equality on both — matching `kid` alone is
   not sufficient, since an attacker who controls the `.well-known`
   response could reuse a known `kid` with a freshly generated key to
   spoof past a `kid`-only check) against the newly fetched `keys` array:
   - Match found → upsert with the new full `keys` array (rotation
     grace — lets a peer add/retire keys as long as the previously
     pinned key is still present in the new set), audit `peer.rotated`.
   - No match → **do not** write the repository; throw
     `PEER_KEY_MISMATCH` with `{ domain, pinnedKeys, fetchedKeys }`;
     audit `peer.key_mismatch_rejected`. The stored record is left
     exactly as it was.

No background polling timer. Re-resolution only happens when an operator
re-invokes `sigil peer resolve <domain>` — matches this repo's existing
lazy-refresh-on-access pattern (`createJwksCache`/`createDiscoveryCache`
TTL semantics), not the `oidc_issuer_allowlist` interval-poll pattern,
since that pattern polls the relay's *own* database, not an outbound
network call to an operator-unvetted peer.

### Repository: `PeerRelayRepository` methods

New methods on both `createMemoryRepository` and `PostgresRepository`,
mirroring the `oidc_issuer_allowlist` add/list/remove shape:

```js
upsertPeer({ domain, relayUrl, wsUrl, keys, trustMode })
getPeerByDomain(domain)      // -> record | null
listPeers()                  // -> record[]
removePeer(domain)           // -> boolean
```

Postgres migration adds:

```sql
CREATE TABLE peer_relays (
  domain            TEXT PRIMARY KEY,
  relay_url         TEXT NOT NULL,
  ws_url            TEXT,
  keys              JSONB NOT NULL,      -- [{ kid, alg, publicKey }, ...]
  trust_mode        TEXT NOT NULL DEFAULT 'tofu',  -- 'tofu' | 'static'
  discovered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_resolved_at  TIMESTAMPTZ
);
```

`keys` is JSONB (an array), not a single-key column, from the start —
rotation-grace matching needs to compare against the whole set, and a
single-column schema would need a breaking migration the first time a
peer rotates.

### Audit events

Every mutating action calls `repository.recordAuditEvent(...)` directly
(the existing generic contract in `postgres-repository.mjs` /
`memory-repository.mjs` — `eventType`, `objectType: 'peer_relay'`,
`objectId: domain`, `outcome`, `payload`). This is a direct call, **not**
routed through `writeRejectionAudit`'s two-tier retry/fallback wrapper —
that wrapper exists specifically to survive the same-transaction-rollback
timing problem of an envelope rejection; `sigil peer` commands are
standalone CLI invocations with no enclosing transaction to roll back, so
a plain awaited `recordAuditEvent` call is sufficient and any repository
failure surfaces directly as a CLI error.

Event types: `peer.tofu_pinned`, `peer.rotated` (both grace-rotation and
`--confirm` force-rotation, distinguished by `payload.forced`),
`peer.static_pinned`, `peer.removed`, `peer.key_mismatch_rejected`.

### CLI — `sigil peer <subcommand>` (`sigil/cli/sigil.mjs`)

- `sigil peer resolve <domain>` — runs `resolvePeer`. Prints the
  resulting record as JSON. On `PEER_KEY_MISMATCH`, exits non-zero and
  prints a fingerprint diff (pinned vs. fetched `kid`/`publicKey` pairs)
  instead of the raw error.
- `sigil peer add <domain> --relay-url <url> [--ws-url <url>] --public-key
  <key> --kid <id>` — manual pin, `trustMode: 'static'`, no network call,
  audits `peer.static_pinned`.
- `sigil peer list` — prints all pinned peers.
- `sigil peer get <domain>` — prints one record, or a clear "not found"
  message (not a stack trace) if absent.
- `sigil peer remove <domain>` — `repository.removePeer`, audits
  `peer.removed`.
- `sigil peer rotate <domain> --confirm` — re-runs `discoverPeer`
  unconditionally and force-upserts regardless of key-set mismatch
  (`payload.forced: true` on the audit event). Without `--confirm`,
  errors with a usage message rather than silently no-op'ing.

## Non-goals

- **No auto-forwarding.** Discovery and trust pinning only. Sub-project
  #3 owns actually dialing a peer relay to hand off an envelope.
- **No discovery on the envelope-accept hot path.** `resolvePeer` is only
  ever invoked from `sigil peer resolve`/`rotate`, never from
  `POST /v1/envelopes`. `RECIPIENT_NOT_LOCAL` behavior from sub-project #1
  is completely unchanged.
- **No IP-range/loopback/private-range SSRF guardrails, no DNS-rebinding
  socket pinning.** Matches this repo's existing `oidc-client.mjs`
  precedent (https-only + timeout + no-redirect + self-match, nothing
  more) rather than introducing new networking infrastructure only #2
  would use. If sub-project #3 later needs a hardened shared outbound
  fetch wrapper (once routing makes peer relays a much larger, more
  exposed attack surface), that's introduced once, across both OIDC and
  peer discovery, not bespoke here.
- **No background polling/refresh timer** for pinned peers. Purely
  on-demand via `sigil peer resolve`.
- **No IDNA/punycode, no IPv6 literals, no port literals beyond what
  `parseDomain` already accepts** — peer domains are plain hostnames
  (with optional port) exactly as sub-project #1 defined them; this spec
  doesn't touch `federated-id.mjs`'s grammar.
- **No cross-federation directory or presence** (#4) and no operational
  tooling like health dashboards (#5) — out of scope here.

## Testing

- `peer-discovery.mjs` unit tests (mocked `fetchImpl`, no real network):
  successful discovery; non-2xx; unreachable/timeout; malformed JSON;
  domain self-match failure; missing/empty `keys`; invalid key entry
  (wrong `alg`, empty `kid`/`publicKey`); `http://` endpoint rejected
  when simulating production, accepted otherwise; `https://` required for
  the discovery request itself regardless of environment.
- `resolvePeer` unit tests (in-memory repository, mocked `fetchImpl`):
  first-ever resolve pins TOFU and audits `peer.tofu_pinned`; second
  resolve with an unchanged key set is a no-op re-confirmation; second
  resolve with a *rotated* key set where the old `kid`+`publicKey` pair
  is still present in the new set succeeds and audits `peer.rotated`;
  second resolve where the old `kid` is reused with a *different*
  `publicKey` is rejected as `PEER_KEY_MISMATCH` (the spoofing case) and
  leaves the stored record untouched; second resolve where the old key is
  entirely absent is rejected as `PEER_KEY_MISMATCH`; a `trustMode:
  'static'` record is never overwritten and never triggers a fetch.
- Repository parity tests: `upsertPeer`/`getPeerByDomain`/`listPeers`/
  `removePeer` behave identically against `createMemoryRepository` and
  `PostgresRepository` (same pattern as existing `oidc_issuer_allowlist`
  parity tests).
- `sigil peer` CLI tests: `add` writes a static record without any
  network call; `resolve` on a fresh domain performs discovery and pins;
  `resolve` on a mismatched domain exits non-zero with a fingerprint
  diff, not a raw stack trace; `rotate --confirm` force-overwrites after
  a prior mismatch; `rotate` without `--confirm` errors with a usage
  message and does not mutate anything; `list`/`get`/`remove` round-trip.
