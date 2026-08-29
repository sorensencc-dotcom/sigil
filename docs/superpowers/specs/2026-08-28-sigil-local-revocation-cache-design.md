# Sigil local revocation interval cache — design

## Problem

Under the Sigil Trust Engine, key revocation is epoch-bound: a signature generated before its key's revocation timestamp remains cryptographically valid, while signatures generated at or after the revocation timestamp must be rejected.

When a local connector operates disconnected from the central PostgreSQL relay, it cannot query the relay's live database of registered and revoked keys. An attacker holding a compromised key could backdate message envelopes (setting `created_at < T_revocation`) and submit them to an offline connector. Without a local revocation interval cache, the offline connector accepts the forged envelope.

This specification closes this temporal forgery vulnerability by adding an epoch-aware revocation interval cache directly to the connector's local SQLite database and introducing a fail-closed offline verification pipeline.

## Architectural boundaries and invariants

1. **Zero relay payload access**: The relay stores only context pointers and metadata; it never receives raw filesystem contents or private keys. The connector stores private keys strictly in host credential stores (DPAPI on Windows, Keychain on macOS).
2. **JCS canonicalization**: Every signature verification executes over the RFC 8785 JSON Canonicalization Scheme (JCS) canonical UTF-8 bytes of the envelope excluding the `signature` field.
3. **Fail-closed verification**: If the local clock skew exceeds the tolerance window (±5 minutes) or any revocation status is indeterminate, verification halts and rejects the envelope.
4. **Two-tier audit persistence**: Security rejections write first to the local SQLite audit tables; on database lock or error, they append to a local fallback log file.

## Schema design

### SQLite schema extension (`sigil/connectors/v1/connector-schema.sql`)

```sql
PRAGMA foreign_keys = ON;

-- Local Revocation Interval Cache Table
CREATE TABLE IF NOT EXISTS endpoint_revocation_intervals (
    revocation_event_id TEXT PRIMARY KEY,                               -- UUIDv7 event identifier
    profile_id TEXT NOT NULL REFERENCES connector_profiles(profile_id), -- Associated profile
    endpoint_id TEXT NOT NULL,                                          -- Target endpoint ID (e.g. ep_codex@relay.example.com)
    key_id TEXT NOT NULL,                                               -- Ed25519 key ID / fingerprint
    revoked_at TEXT NOT NULL,                                           -- ISO 8601 UTC timestamp of revocation epoch
    reason TEXT NOT NULL CHECK(reason IN (
        'compromised', 'rotation', 'decommissioned', 'administrative_invalidation'
    )),
    valid_from TEXT NOT NULL,                                           -- Original key activation timestamp
    valid_until TEXT NOT NULL,                                          -- Original scheduled key expiration timestamp
    synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(endpoint_id, key_id)
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_revocation_lookup 
ON endpoint_revocation_intervals(key_id, revoked_at);

CREATE INDEX IF NOT EXISTS idx_revocation_sync_status 
ON endpoint_revocation_intervals(synced_at);
```

## Database adapter methods (`sigil/connectors/v1/connector-db-adapter.mjs`)

The `ConnectorDatabase` class provides prepared statements and accessors for revocation lifecycle management:

- `upsertRevocationInterval(record)`: Inserts or updates an entry in `endpoint_revocation_intervals` on conflict of `(endpoint_id, key_id)`.
- `getRevocationInterval(keyId)`: Retrieves the revocation record for a given `key_id`.
- `listRevocationIntervalsForEndpoint(endpointId)`: Lists all recorded revocation events associated with an `endpoint_id`.

## Verification algorithm and decision pipeline

The connector executes offline envelope validation through `sigil/connectors/v1/connector-validator.mjs`:

```
                       [ Inbound Envelope Received ]
                                     │
                                     ▼
                      [ 1. Syntax & Timestamp Parsing ]
                                     │
                                     ▼
                   [ 2. Clock-Skew & Lifetime Evaluation ]
                   (Rejects if |T_local - T_msg| > 5 min
                    or expires_at > created_at + 24h)
                                     │
                                     ▼
                   [ 3. Local Revocation Cache Lookup ]
                    Query endpoint_revocation_intervals
                                     │
            ┌────────────────────────┴────────────────────────┐
            ▼                                                 ▼
   [ Key Record Found ]                              [ Key Not in Cache ]
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

1. **Clock-skew and timestamp check**:
   To prevent replay and unbounded delay, evaluate $T_{msg} = \text{Date.parse}(envelope.created\_at)$. If $|T_{local} - T_{msg}| > 300{,}000\text{ ms}$ (5 minutes), reject with `CLOCK_SKEW_EXCEEDED`. If $envelope.expires\_at \le T_{msg}$ or $envelope.expires\_at > T_{msg} + 86{,}400{,}000\text{ ms}$, reject with `INVALID_ENVELOPE` or `MESSAGE_EXPIRED`.

2. **Revocation evaluation**:
   Query `endpoint_revocation_intervals` using `envelope.signature.key_id`.
   - **Case A (Key present in revocation cache)**:
     - If $T_{msg} \ge \text{Date.parse}(record.revoked\_at)$, throw `KEY_REVOKED`.
     - If $T_{msg} < \text{Date.parse}(record.revoked\_at)$, verify $T_{msg} \ge \text{Date.parse}(record.valid\_from)$ and $T_{msg} < \text{Date.parse}(record.valid\_until)$. If outside range, throw `INVALID_SIGNATURE`.
   - **Case B (Key absent from revocation cache)**:
     - Verify $T_{msg}$ is within the key's registered active operational window.

3. **Canonicalization**:
   Strip `envelope.signature` and serialize the remainder to canonical UTF-8 bytes using RFC 8785 JCS.

4. **Cryptographic signature check**:
   Verify the Ed25519 signature against the sender's public key. If verification fails, throw `INVALID_SIGNATURE`.

5. **Capability and approval check**:
   Intersect requested capabilities with local grants. For high-risk operations under offline conditions, require step-up local authorization via `local_approvals`.

## Two-tier rejection-audit trail

All security validation rejections execute two-tier audit logging:

1. **Tier 1 (Database Transaction)**:
   Write a structured audit entry to `audit_events`:
   ```json
   {
     "event_id": "018e5f24-0000-7000-8000-000000000000",
     "event_type": "security.verification_rejection",
     "subject_id": "ep_codex@relay.example.com",
     "actor_id": "ep_codex@relay.example.com",
     "payload": {
       "error_code": "KEY_REVOKED",
       "key_id": "key_ed25519_abc123",
       "message_id": "msg_018e...",
       "created_at": "2026-08-28T12:05:00.000Z",
       "revoked_at": "2026-08-28T12:00:00.000Z",
       "action_hash": "sha256:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069"
     },
     "created_at": "2026-08-28T12:06:00.000Z"
   }
   ```

2. **Tier 2 (Fallback File Logging)**:
   If SQLite write fails due to `SQLITE_BUSY`, database lock, or filesystem corruption:
   - Catch the error immediately.
   - Append the serialized JSON record to `logs/security-failures.log`.
   - Increment the local failure metric counter.
   - Re-throw the original security rejection error to maintain fail-closed execution.

## Conformance and test plan

| Test ID | Scenario | Input State | Expected Outcome |
|---|---|---|---|
| **TEST-REV-01** | Standard Active Key | Active key; valid timestamp within skew window. | Verification succeeds (`accepted: true`). |
| **TEST-REV-02** | Pre-Revocation Validity | Key revoked at `12:00:00Z`; envelope created at `11:55:00Z`. | Signature validates; verification succeeds. |
| **TEST-REV-03** | Post-Revocation Rejection | Key revoked at `12:00:00Z`; envelope created at `12:01:00Z`. | Rejects with `KEY_REVOKED`; logs audit event. |
| **TEST-REV-04** | JCS Key Reordering | Envelope keys rearranged; valid signature over JCS canonical form. | Canonicalization normalizes payload; signature validates. |
| **TEST-REV-05** | Clock Skew Exceeded | Envelope `created_at` deviates > 5 minutes from local clock. | Rejects with `CLOCK_SKEW_EXCEEDED`. |
| **TEST-REV-06** | Two-Tier Fallback | Database lock simulated during rejection logging. | Logs to `security-failures.log`; preserves fail-closed error. |
