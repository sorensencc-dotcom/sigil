# Sigil local revocation interval cache — design

## Problem

Under the Sigil Trust Engine, key revocation is epoch-bound: a signature generated before its key's revocation timestamp remains cryptographically valid, while signatures generated at or after the revocation timestamp must be rejected.

When a local connector operates disconnected from the central PostgreSQL relay, it cannot query the relay's live database of registered and revoked keys. An attacker holding a compromised key could backdate message envelopes (setting `created_at < T_revocation`) and submit them to an offline connector. Without a local revocation interval cache, the offline connector accepts the forged envelope.

This specification closes this temporal forgery vulnerability by:
1. Adding an authenticated local endpoint key registry and epoch-aware revocation interval cache to the connector's SQLite database.
2. Enforcing sequence-checked, Ed25519-signed relay revocation sync manifests (`manifest_type: revocation_sync`).
3. Introducing a strict, fail-closed offline verification pipeline with two-tier rejection audit logging.

## Architectural boundaries and invariants

1. **Zero relay payload access**: The relay stores only context pointers and metadata; it never receives raw filesystem contents or private keys. The connector stores private keys strictly in host credential stores (DPAPI on Windows, Keychain on macOS).
2. **JCS canonicalization**: Every signature verification executes over the RFC 8785 JSON Canonicalization Scheme (JCS) canonical UTF-8 bytes of the envelope or sync manifest excluding the `signature` field.
3. **Fail-closed authority**: Unknown keys (not in local authenticated registry), clock skew > 5 minutes, expired messages, or indeterminate revocation status result in immediate fail-closed rejection.
4. **Signed sync manifests**: Relay revocation pushes must carry an Ed25519 relay signature and monotonically increasing sequence numbers.
5. **Compound identity isolation**: All key and revocation records are bound to `(profile_id, endpoint_id, key_id)` to prevent cross-profile collisions.
6. **Data-directory audit persistence**: Security rejections write first to SQLite `audit_events`; on `SQLITE_BUSY` or database lock, they append sanitized JSON to `path.join(dataDir, "logs", "security-failures.log")`.

## Schema design

### SQLite schema extension (`sigil/connectors/v1/connector-schema.sql`)

```sql
PRAGMA foreign_keys = ON;

-- Authenticated Local Endpoint Key Registry Cache
CREATE TABLE IF NOT EXISTS endpoint_keys_cache (
    profile_id TEXT NOT NULL REFERENCES connector_profiles(profile_id),
    endpoint_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    algorithm TEXT NOT NULL CHECK(algorithm = 'Ed25519'),
    public_key_base64url TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_until TEXT,
    status TEXT NOT NULL CHECK(status IN ('active', 'revoked', 'retired')) DEFAULT 'active',
    synced_sequence INTEGER NOT NULL DEFAULT 0,
    synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (profile_id, endpoint_id, key_id)
);

-- Local Revocation Interval Cache Table
CREATE TABLE IF NOT EXISTS endpoint_revocation_intervals (
    revocation_event_id TEXT NOT NULL,
    profile_id TEXT NOT NULL REFERENCES connector_profiles(profile_id),
    endpoint_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    revoked_at TEXT NOT NULL,
    reason TEXT NOT NULL CHECK(reason IN (
        'compromised', 'rotation', 'decommissioned', 'administrative_invalidation'
    )),
    valid_from TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    synced_sequence INTEGER NOT NULL DEFAULT 0,
    synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (profile_id, endpoint_id, key_id)
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_revocation_lookup 
ON endpoint_revocation_intervals(profile_id, endpoint_id, key_id, revoked_at);

CREATE INDEX IF NOT EXISTS idx_keys_cache_lookup 
ON endpoint_keys_cache(profile_id, endpoint_id, key_id);
```

## Signed relay revocation sync manifest contract

Relay pushes to the connector MUST conform to the signed manifest schema:

```json
{
  "protocol": "sigil/1",
  "manifest_type": "revocation_sync",
  "relay_id": "relay.example.com",
  "sequence": 1042,
  "issued_at": "2026-08-28T12:00:00.000Z",
  "revocations": [
    {
      "revocation_event_id": "018e5f24-0000-7000-8000-000000000000",
      "endpoint_id": "ep_codex@relay.example.com",
      "key_id": "key_ed25519_abc123",
      "revoked_at": "2026-08-28T12:00:00.000Z",
      "reason": "compromised",
      "valid_from": "2026-08-01T00:00:00.000Z",
      "valid_until": "2026-09-01T00:00:00.000Z"
    }
  ],
  "signature": {
    "algorithm": "Ed25519",
    "key_id": "relay-signing-key-1",
    "value": "base64url..."
  }
}
```

## Database adapter methods (`sigil/connectors/v1/connector-db-adapter.mjs`)

The `ConnectorDatabase` class provides prepared statements and accessors:

- `upsertKeyCache(record)`: Stores or updates key definitions in `endpoint_keys_cache`.
- `getKeyCache(profileId, endpointId, keyId)`: Retrieves active key metadata.
- `batchApplyRevocationSync(profileId, manifest, relayPublicKey)`: Verifies manifest signature, validates monotonic `sequence > last_synced_sequence`, and executes atomic batch upsert inside `this.db.transaction(...)`.
- `getRevocationInterval(profileId, endpointId, keyId)`: Retrieves the revocation interval record.
- `listRevocationIntervalsForEndpoint(profileId, endpointId)`: Lists all revocation events for an endpoint.

## Verification algorithm and decision pipeline

The connector executes offline envelope validation through `sigil/connectors/v1/connector-validator.mjs`:

```
                       [ Inbound Envelope Received ]
                                     │
                                     ▼
                      [ 1. Syntax & Strict UTC Parsing ]
                         - Validate ISO 8601 UTC regex
                         - Reject if T_local >= T_expires
                         - Reject if |T_local - T_created| > 5m
                         - Reject if T_expires <= T_created or > 24h
                                     │
                                     ▼
                      [ 2. Authenticated Key Registry Lookup ]
                         - Query endpoint_keys_cache(profile, endpoint, key)
                         - Reject UNKNOWN_KEY if absent or not active
                                     │
                                     ▼
                      [ 3. Local Revocation Cache Lookup ]
                         - Query endpoint_revocation_intervals
                                     │
            ┌────────────────────────┴────────────────────────┐
            ▼                                                 ▼
   [ Revocation Record Found ]                       [ Not in Revocation Cache ]
            │                                                 │
   ┌────────┴────────┐                                        │
   ▼                 ▼                                        │
[ T_msg >= T_rev ] [ T_msg < T_rev ]                          │
   │                 │                                        │
   ▼                 ▼                                        │
[ REJECT:       [ Verify Key Validity Window:                 │
 KEY_REVOKED ]   T_valid_from <= T_msg < T_valid_until ]      │
                     │                                        │
                     └────────────────┬───────────────────────┘
                                      │
                                      ▼
                      [ 4. RFC 8785 JCS Canonicalization ]
                         CanonicalBytes = JCS(Envelope \ {signature})
                                      │
                                      ▼
                      [ 5. Ed25519 Signature Verification ]
                         crypto.verify(null, CanonicalBytes, PubKey, Sig)
                                      │
                                      ▼
                      [ 6. Capability Intersection Check ]
```

### Verification steps

1. **Strict timestamp and lifetime parsing**:
   - Assert `envelope.created_at` and `envelope.expires_at` match `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/`. If not, throw `INVALID_ENVELOPE`.
   - If $T_{local} \ge T_{expires}$, throw `MESSAGE_EXPIRED`.
   - If $|T_{local} - T_{created}| > 300{,}000\text{ ms}$ (5 minutes), throw `CLOCK_SKEW_EXCEEDED`.
   - If $T_{expires} \le T_{created}$ or $T_{expires} > T_{created} + 86{,}400{,}000\text{ ms}$, throw `INVALID_ENVELOPE`.

2. **Authenticated key registry lookup**:
   - Query `endpoint_keys_cache` for `(profile_id, envelope.sender.endpoint_id, envelope.signature.key_id)`.
   - If missing or `status !== 'active'`, throw `UNKNOWN_KEY`.

3. **Revocation evaluation**:
   - Query `endpoint_revocation_intervals` for `(profile_id, envelope.sender.endpoint_id, envelope.signature.key_id)`.
   - **Case A (Key in revocation cache)**:
     - If $T_{msg} \ge \text{Date.parse}(record.revoked\_at)$, throw `KEY_REVOKED`.
     - If $T_{msg} < \text{Date.parse}(record.revoked\_at)$, assert $T_{msg} \ge \text{Date.parse}(record.valid\_from)$ and $T_{msg} < \text{Date.parse}(record.valid\_until)$. If outside range, throw `INVALID_SIGNATURE`.
   - **Case B (Key absent from revocation cache)**:
     - Assert $T_{msg} \ge \text{Date.parse}(key.valid\_from)$ and $T_{msg} < \text{Date.parse}(key.valid\_until)$.

4. **JCS canonicalization**:
   - Strip top-level `envelope.signature` and serialize to canonical UTF-8 bytes using RFC 8785 JCS.

5. **Ed25519 signature check**:
   - Verify the signature value decoded from `base64url` against the public key from `endpoint_keys_cache`. If invalid, throw `INVALID_SIGNATURE`.

6. **Capability intersection**:
   - Intersect requested capabilities with local grants. High-risk capabilities offline require local approval.

## Two-tier rejection-audit trail

All security validation rejections execute two-tier audit logging:

1. **Tier 1 (Database Transaction)**: Insert structured audit entry into `audit_events`.
2. **Tier 2 (Fallback File Logging)**: If SQLite write throws `SQLITE_BUSY` or connection lock:
   - Catch error immediately.
   - Append sanitized single-line JSON to `path.join(dataDir, "logs", "security-failures.log")`.
   - Increment metric `security_audit_fallback_total`.
   - Re-throw original security error to maintain fail-closed execution.

## Conformance and test matrix

| Test ID | Scenario | Input State & Clock Mock | Expected Outcome |
|---|---|---|---|
| **TEST-REV-01** | Standard Active Key | Active key in registry; valid timestamp within skew window. | Verification succeeds (`accepted: true`). |
| **TEST-REV-02** | Pre-Revocation Validity | Key revoked at `12:00:00Z`; envelope created at `11:55:00Z`; mock clock `now = 11:57:00Z`. | Signature validates; verification succeeds. |
| **TEST-REV-03** | Post-Revocation Rejection | Key revoked at `12:00:00Z`; envelope created at `12:01:00Z`; mock clock `now = 12:02:00Z`. | Rejects with `KEY_REVOKED`; logs audit event. |
| **TEST-REV-04** | JCS Key Reordering | Envelope keys rearranged; valid signature over canonical form. | Canonicalization normalizes payload; signature validates. |
| **TEST-REV-05** | Clock Skew Exceeded | Envelope `created_at` deviates > 5 minutes from local clock. | Rejects with `CLOCK_SKEW_EXCEEDED`. |
| **TEST-REV-06** | Two-Tier Fallback | Force database error during rejection logging. | Logs to `security-failures.log`; preserves fail-closed error. |
| **TEST-REV-07** | Strict UTC Format | Non-UTC timestamp (missing 'Z' or invalid format). | Rejects with `INVALID_ENVELOPE`. |
| **TEST-REV-08** | Current-Time Expired | Current clock `now >= expires_at`. | Rejects with `MESSAGE_EXPIRED`. |
| **TEST-REV-09** | Lifetime Exceeded | Message lifetime `expires_at > created_at + 24h`. | Rejects with `INVALID_ENVELOPE`. |
| **TEST-REV-10** | Unknown Key | Key ID not present in authenticated local `endpoint_keys_cache`. | Rejects with `UNKNOWN_KEY`. |
| **TEST-REV-11** | Malformed Signature | Invalid base64url or signature bit corruption. | Rejects with `INVALID_SIGNATURE`. |
| **TEST-REV-12** | Signed Sync Manifest | Sync manifest with invalid relay signature or out-of-order sequence. | Rejects sync batch with `INVALID_SYNC_MANIFEST`. |
