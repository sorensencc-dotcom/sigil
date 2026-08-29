# Sigil Local Revocation Interval Cache & Key Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the authenticated local endpoint key registry, epoch-aware local revocation interval cache, Ed25519-signed sync manifest processor, and fail-closed offline envelope validator with two-tier rejection audit persistence in Sigil connectors.

**Architecture:** Extend SQLite database with `endpoint_keys_cache` and `endpoint_revocation_intervals` tables. Create `revocation-sync.mjs` to verify signed relay manifests and execute atomic batch syncs. Implement `connector-validator.mjs` to enforce clock skew, active key registry lookups, epoch revocation comparisons, RFC 8785 JCS canonical verification, and fallback logging upon database locks.

**Tech Stack:** Node.js (ESM), `better-sqlite3`, Node.js native `node:crypto` (Ed25519), `node:test`, RFC 8785 JSON Canonicalization Scheme (JCS).

## Global Constraints

- Version floor: Node.js >= 20.x, Sigil protocol version `sigil/1`.
- All timestamps must match strict ISO 8601 UTC regex (`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/`).
- Clock-skew tolerance limit is strictly 5 minutes (300,000 ms). Maximum envelope lifetime is 24 hours (86,400,000 ms).
- Canonical payload serialization must use RFC 8785 JSON Canonicalization Scheme (`jcs.mjs`).
- Key identifiers and revocation records must be strictly scoped to `(profile_id, endpoint_id, key_id)`.
- All security rejection errors must be fail-closed; fallback audit logs must be anchored to `path.join(dataDir, 'logs', 'security-failures.log')`.

---

### Task 1: SQLite Schema & Database Adapter Extensions

**Files:**
- Modify: `sigil/connectors/v1/connector-schema.sql`
- Modify: `sigil/connectors/v1/connector-db-adapter.mjs`
- Test: `sigil/connectors/v1/connector-db-adapter.test.mjs`

**Interfaces:**
- Consumes: `connector_profiles` table and `ConnectorDatabase` class.
- Produces:
  - `db.upsertKeyCache({ profile_id, endpoint_id, key_id, algorithm, public_key_base64url, valid_from, valid_until, status, synced_sequence })`
  - `db.getKeyCache(profileId, endpointId, keyId)`
  - `db.batchUpsertRevocationIntervals(profileId, revocations, syncedSequence)`
  - `db.getRevocationInterval(profileId, endpointId, keyId)`
  - `db.listRevocationIntervalsForEndpoint(profileId, endpointId)`

- [x] **Step 1: Write the failing test for key cache and revocation interval operations**

Add tests to `sigil/connectors/v1/connector-db-adapter.test.mjs`:

```javascript
test('endpoint keys cache operations store, retrieve, and isolate by profile', () => withDatabase((db) => {
  db.upsertKeyCache({
    profile_id: 'prof_test',
    endpoint_id: 'ep_test@relay.example',
    key_id: 'key_1',
    algorithm: 'Ed25519',
    public_key_base64url: 'MCowBQYDK2VwAyEA1111111111111111111111111111111111111111111=',
    valid_from: '2026-08-01T00:00:00.000Z',
    valid_until: '2026-09-01T00:00:00.000Z',
    status: 'active',
    synced_sequence: 1
  });

  const key = db.getKeyCache('prof_test', 'ep_test@relay.example', 'key_1');
  assert.equal(key.key_id, 'key_1');
  assert.equal(key.status, 'active');
  assert.equal(db.getKeyCache('prof_other', 'ep_test@relay.example', 'key_1'), null);
}));

test('batch revocation interval upsert atomically commits intervals within a transaction', () => withDatabase((db) => {
  db.batchUpsertRevocationIntervals('prof_test', [
    {
      revocation_event_id: 'rev_1',
      endpoint_id: 'ep_test@relay.example',
      key_id: 'key_1',
      revoked_at: '2026-08-28T12:00:00.000Z',
      reason: 'compromised',
      valid_from: '2026-08-01T00:00:00.000Z',
      valid_until: '2026-09-01T00:00:00.000Z'
    }
  ], 10);

  const record = db.getRevocationInterval('prof_test', 'ep_test@relay.example', 'key_1');
  assert.equal(record.revoked_at, '2026-08-28T12:00:00.000Z');
  assert.equal(record.reason, 'compromised');

  const list = db.listRevocationIntervalsForEndpoint('prof_test', 'ep_test@relay.example');
  assert.equal(list.length, 1);
}));
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test sigil/connectors/v1/connector-db-adapter.test.mjs`
Expected: FAIL with `db.upsertKeyCache is not a function`.

- [x] **Step 3: Update schema and implement database adapter methods**

Update `sigil/connectors/v1/connector-schema.sql`:
```sql
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

CREATE INDEX IF NOT EXISTS idx_revocation_lookup 
ON endpoint_revocation_intervals(profile_id, endpoint_id, key_id, revoked_at);

CREATE INDEX IF NOT EXISTS idx_keys_cache_lookup 
ON endpoint_keys_cache(profile_id, endpoint_id, key_id);
```

Add prepared statements and helper methods in `sigil/connectors/v1/connector-db-adapter.mjs`:
```javascript
// In _prepareStatements():
upsertKeyCache: this.db.prepare(`
  INSERT INTO endpoint_keys_cache (profile_id, endpoint_id, key_id, algorithm, public_key_base64url, valid_from, valid_until, status, synced_sequence)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(profile_id, endpoint_id, key_id) DO UPDATE SET
    algorithm = EXCLUDED.algorithm,
    public_key_base64url = EXCLUDED.public_key_base64url,
    valid_from = EXCLUDED.valid_from,
    valid_until = EXCLUDED.valid_until,
    status = EXCLUDED.status,
    synced_sequence = EXCLUDED.synced_sequence,
    synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
`),
getKeyCache: this.db.prepare(`
  SELECT * FROM endpoint_keys_cache WHERE profile_id = ? AND endpoint_id = ? AND key_id = ?
`),
upsertRevocationInterval: this.db.prepare(`
  INSERT INTO endpoint_revocation_intervals (revocation_event_id, profile_id, endpoint_id, key_id, revoked_at, reason, valid_from, valid_until, synced_sequence)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(profile_id, endpoint_id, key_id) DO UPDATE SET
    revocation_event_id = EXCLUDED.revocation_event_id,
    revoked_at = EXCLUDED.revoked_at,
    reason = EXCLUDED.reason,
    valid_from = EXCLUDED.valid_from,
    valid_until = EXCLUDED.valid_until,
    synced_sequence = EXCLUDED.synced_sequence,
    synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
`),
getRevocationInterval: this.db.prepare(`
  SELECT * FROM endpoint_revocation_intervals WHERE profile_id = ? AND endpoint_id = ? AND key_id = ?
`),
listRevocationIntervalsForEndpoint: this.db.prepare(`
  SELECT * FROM endpoint_revocation_intervals WHERE profile_id = ? AND endpoint_id = ? ORDER BY revoked_at DESC
`)
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test sigil/connectors/v1/connector-db-adapter.test.mjs`
Expected: PASS all tests.

- [x] **Step 5: Commit**

```bash
git add sigil/connectors/v1/connector-schema.sql sigil/connectors/v1/connector-db-adapter.mjs sigil/connectors/v1/connector-db-adapter.test.mjs
git commit -m "feat(connector): add key registry and revocation intervals SQLite cache"
```

---

### Task 2: Signed Revocation Sync Manifest Verification & Ingestion

**Files:**
- Create: `sigil/connectors/v1/revocation-sync.mjs`
- Test: `sigil/connectors/v1/revocation-sync.test.mjs`

**Interfaces:**
- Consumes: `canonicalJsonBytes` from `sigil/relay/v1/jcs.mjs`, `ConnectorDatabase`.
- Produces: `applySignedRevocationSync({ db, profileId, manifest, relayPublicKey, lastSequence })`

- [x] **Step 1: Write the failing test for signed revocation sync manifest**

Create `sigil/connectors/v1/revocation-sync.test.mjs`:
```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorDatabase } from './connector-db-adapter.mjs';
import { canonicalJsonBytes } from '../../relay/v1/jcs.mjs';
import { applySignedRevocationSync } from './revocation-sync.mjs';

function generateRelayKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey, privateKey };
}

function signManifest(manifestBody, privateKey, keyId = 'relay-key-1') {
  const bytes = canonicalJsonBytes(manifestBody);
  const signatureValue = crypto.sign(null, bytes, privateKey).toString('base64url');
  return {
    ...manifestBody,
    signature: {
      algorithm: 'Ed25519',
      key_id: keyId,
      value: signatureValue
    }
  };
}

test('applySignedRevocationSync validates manifest signature and atomically commits intervals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sigil-sync-'));
  const db = new ConnectorDatabase(join(dir, 'connector.db'), new URL('./connector-schema.sql', import.meta.url));
  db.upsertProfile({ profile_id: 'prof_1', owner_id: 'u1', endpoint_id: 'ep_1', display_name: 'Ep 1', relay_url: 'ws://relay', secure_key_reference: 'k', secure_token_reference: 't' });

  const { publicKey, privateKey } = generateRelayKey();
  const manifest = signManifest({
    protocol: 'sigil/1',
    manifest_type: 'revocation_sync',
    relay_id: 'relay.example.com',
    sequence: 10,
    issued_at: '2026-08-28T12:00:00.000Z',
    revocations: [
      {
        revocation_event_id: 'rev_100',
        endpoint_id: 'ep_target@relay.example.com',
        key_id: 'key_target_1',
        revoked_at: '2026-08-28T11:00:00.000Z',
        reason: 'compromised',
        valid_from: '2026-08-01T00:00:00.000Z',
        valid_until: '2026-09-01T00:00:00.000Z'
      }
    ]
  }, privateKey);

  const res = applySignedRevocationSync({ db, profileId: 'prof_1', manifest, relayPublicKey: publicKey, lastSequence: 5 });
  assert.equal(res.appliedCount, 1);
  assert.equal(res.sequence, 10);

  const item = db.getRevocationInterval('prof_1', 'ep_target@relay.example.com', 'key_target_1');
  assert.equal(item.revocation_event_id, 'rev_100');

  // Out of order sequence must throw INVALID_SYNC_MANIFEST
  assert.throws(() => applySignedRevocationSync({ db, profileId: 'prof_1', manifest, relayPublicKey: publicKey, lastSequence: 10 }), { code: 'INVALID_SYNC_MANIFEST' });

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test sigil/connectors/v1/revocation-sync.test.mjs`
Expected: FAIL with `Cannot find module './revocation-sync.mjs'`.

- [x] **Step 3: Implement signed revocation sync processor**

Create `sigil/connectors/v1/revocation-sync.mjs`:
```javascript
import crypto from 'node:crypto';
import { canonicalJsonBytes } from '../../relay/v1/jcs.mjs';

export function reject(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

export function applySignedRevocationSync({ db, profileId, manifest, relayPublicKey, lastSequence = 0 }) {
  if (!manifest || typeof manifest !== 'object' || manifest.manifest_type !== 'revocation_sync') {
    throw reject('INVALID_SYNC_MANIFEST', 'Manifest must be an object with manifest_type "revocation_sync"');
  }
  if (manifest.protocol !== 'sigil/1') throw reject('VERSION_UNSUPPORTED', 'Unsupported protocol version');
  if (typeof manifest.sequence !== 'number' || manifest.sequence <= lastSequence) {
    throw reject('INVALID_SYNC_MANIFEST', `Manifest sequence ${manifest.sequence} is not greater than current sequence ${lastSequence}`);
  }
  if (!manifest.signature?.value || manifest.signature.algorithm !== 'Ed25519') {
    throw reject('INVALID_SYNC_MANIFEST', 'Valid Ed25519 manifest signature is required');
  }

  const unsigned = { ...manifest };
  delete unsigned.signature;
  const canonicalBytes = canonicalJsonBytes(unsigned);
  const sigBuffer = Buffer.from(manifest.signature.value, 'base64url');

  const valid = crypto.verify(null, canonicalBytes, relayPublicKey, sigBuffer);
  if (!valid) throw reject('INVALID_SYNC_MANIFEST', 'Manifest signature verification failed');

  const revocations = Array.isArray(manifest.revocations) ? manifest.revocations : [];
  db.batchUpsertRevocationIntervals(profileId, revocations, manifest.sequence);

  return { appliedCount: revocations.length, sequence: manifest.sequence };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test sigil/connectors/v1/revocation-sync.test.mjs`
Expected: PASS all tests.

- [x] **Step 5: Commit**

```bash
git add sigil/connectors/v1/revocation-sync.mjs sigil/connectors/v1/revocation-sync.test.mjs
git commit -m "feat(connector): add signed relay revocation sync manifest processor"
```

---

### Task 3: Offline Connector Envelope Verification Engine with Two-Tier Audit Logging

**Files:**
- Create: `sigil/connectors/v1/connector-validator.mjs`
- Test: `sigil/connectors/v1/connector-validator.test.mjs`

**Interfaces:**
- Consumes: `ConnectorDatabase`, `canonicalJsonBytes` from `sigil/relay/v1/jcs.mjs`, `node:crypto`.
- Produces: `verifyInboundEnvelopeOffline({ envelope, profileId, db, dataDir, now })`

- [x] **Step 1: Write the failing test suite covering TEST-REV-01 through TEST-REV-12**

Create `sigil/connectors/v1/connector-validator.test.mjs` implementing all 12 test cases in the Conformance Matrix:
- TEST-REV-01: Standard Active Key verification
- TEST-REV-02: Pre-Revocation Validity ($T_{msg} < T_{rev}$ with mock clock within skew window)
- TEST-REV-03: Post-Revocation Rejection ($T_{msg} \ge T_{rev}$ throws `KEY_REVOKED` and records Tier 1 audit event)
- TEST-REV-04: JCS Key Reordering stability
- TEST-REV-05: Clock Skew Exceeded ($|T_{local} - T_{created}| > 5\text{ min}$)
- TEST-REV-06: Two-Tier Audit Fallback (writes to `security-failures.log` when SQLite fails)
- TEST-REV-07: Strict UTC format check (missing 'Z' rejected with `INVALID_ENVELOPE`)
- TEST-REV-08: Current-time expired ($T_{local} \ge T_{expires}$)
- TEST-REV-09: Lifetime exceeded ($T_{expires} > T_{created} + 24\text{h}$)
- TEST-REV-10: Unknown key (key not in local registry rejected with `UNKNOWN_KEY`)
- TEST-REV-11: Malformed base64url signature rejected with `INVALID_SIGNATURE`)
- TEST-REV-12: Signed sync manifest verification

- [x] **Step 2: Run test to verify it fails**

Run: `node --test sigil/connectors/v1/connector-validator.test.mjs`
Expected: FAIL with `Cannot find module './connector-validator.mjs'`.

- [x] **Step 3: Implement connector validator and two-tier audit fallback**

Create `sigil/connectors/v1/connector-validator.mjs`:
```javascript
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJsonBytes } from '../../relay/v1/jcs.mjs';

const STRICT_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function reject(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

export function signedBytes(envelope) {
  const unsigned = { ...envelope };
  delete unsigned.signature;
  return canonicalJsonBytes(unsigned);
}

function recordAuditRejection({ db, dataDir, profileId, envelope, errorCode }) {
  const eventId = crypto.randomUUID();
  const nowStr = new Date().toISOString();
  const canonicalHash = envelope ? crypto.createHash('sha256').update(signedBytes(envelope)).digest('hex') : '';
  const senderId = envelope?.sender?.endpoint_id || 'unknown';
  const keyId = envelope?.signature?.key_id || 'unknown';

  const auditRecord = {
    event_id: eventId,
    event_type: 'security.verification_rejection',
    subject_id: senderId,
    actor_id: senderId,
    payload: {
      error_code: errorCode,
      key_id: keyId,
      message_id: envelope?.message_id || null,
      created_at: envelope?.created_at || null,
      action_hash: canonicalHash ? `sha256:${canonicalHash}` : null
    },
    created_at: nowStr
  };

  try {
    if (db && typeof db.db?.prepare === 'function') {
      db.db.prepare(`
        INSERT INTO audit_events (event_id, event_type, subject_id, actor_id, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(eventId, auditRecord.event_type, senderId, senderId, JSON.stringify(auditRecord.payload), nowStr);
      return;
    }
  } catch {
    // Database write failed; proceed to Tier 2 file fallback
  }

  try {
    if (dataDir) {
      const logDir = path.join(dataDir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, 'security-failures.log');
      const sanitizedLine = JSON.stringify(auditRecord) + '\n';
      fs.appendFileSync(logPath, sanitizedLine, 'utf8');
    }
  } catch {
    // Suppress filesystem logging error to ensure original security exception is thrown
  }
}

export function verifyInboundEnvelopeOffline({ envelope, profileId, db, dataDir, now = new Date() }) {
  if (!envelope || typeof envelope !== 'object') {
    throw reject('INVALID_ENVELOPE', 'Envelope must be an object');
  }

  const required = ['protocol', 'message_id', 'conversation_id', 'message_type', 'sender', 'body', 'context_refs', 'capabilities', 'idempotency_key', 'created_at', 'expires_at', 'signature'];
  for (const field of required) {
    if (!(field in envelope)) {
      const err = reject('INVALID_ENVELOPE', `Missing required field: ${field}`, { field });
      recordAuditRejection({ db, dataDir, profileId, envelope, errorCode: 'INVALID_ENVELOPE' });
      throw err;
    }
  }

  if (envelope.protocol !== 'sigil/1') {
    const err = reject('VERSION_UNSUPPORTED', 'Unsupported protocol version');
    recordAuditRejection({ db, dataDir, profileId, envelope, errorCode: 'VERSION_UNSUPPORTED' });
    throw err;
  }

  if (!STRICT_UTC_REGEX.test(envelope.created_at) || !STRICT_UTC_REGEX.test(envelope.expires_at)) {
    const err = reject('INVALID_ENVELOPE', 'Timestamps must be strict ISO 8601 UTC strings');
    recordAuditRejection({ db, dataDir, profileId, envelope, errorCode: 'INVALID_ENVELOPE' });
    throw err;
  }

  const tLocal = now instanceof Date ? now.getTime() : Date.parse(now);
  const tCreated = Date.parse(envelope.created_at);
  const tExpires = Date.parse(envelope.expires_at);

  if (tLocal >= tExpires) {
    const err = reject('MESSAGE_EXPIRED', 'Current time has reached or exceeded message expiration');
    recordAuditRejection({ db, dataDir, profileId, envelope, errorCode: 'MESSAGE_EXPIRED' });
    throw err;
  }

  if (Math.abs(tLocal - tCreated) > MAX_CLOCK_SKEW_MS) {
    const err = reject('CLOCK_SKEW_EXCEEDED', 'Envelope created_at exceeds maximum 5-minute clock skew tolerance');
    recordAuditRejection({ db, dataDir, profileId, envelope, errorCode: 'CLOCK_SKEW_EXCEEDED' });
    throw err;
  }

  if (tExpires <= tCreated || tExpires > tCreated + MAX_LIFETIME_MS) {
    const err = reject('INVALID_ENVELOPE', 'Invalid message lifetime: expires_at must be within 24 hours of created_at');
    recordAuditRejection({ db, dataDir, profileId, envelope, errorCode: 'INVALID_ENVELOPE' });
    throw err;
  }

  // 1. Authenticated Key Registry Lookup
  const senderEndpointId = envelope.sender.endpoint_id;
  const keyId = envelope.signature.key_id;
  const keyRecord = db.getKeyCache(profileId, senderEndpointId, keyId);

  if (!keyRecord || keyRecord.status !== 'active') {
    const err = reject('UNKNOWN_KEY', `Key ${keyId} for endpoint ${senderEndpointId} is not in active local registry`);
    recordAuditRejection({ db, dataDir, profileId, envelope, errorCode: 'UNKNOWN_KEY' });
    throw err;
  }

  // 2. Local Revocation Interval Cache Check
  const revocationRecord = db.getRevocationInterval(profileId, senderEndpointId, keyId);
  if (revocationRecord) {
    const tRevoked = Date.parse(revocationRecord.revoked_at);
    if (tCreated >= tRevoked) {
      const err = reject('KEY_REVOKED', `Key was revoked at ${revocationRecord.revoked_at}, prior to envelope created_at ${envelope.created_at}`);
      recordAuditRejection({ db, dataDir, profileId, envelope, errorCode: 'KEY_REVOKED' });
      throw err;
    }
    const tValidFrom = Date.parse(revocationRecord.valid_from);
    const tValidUntil = Date.parse(revocationRecord.valid_until);
    if (tCreated < tValidFrom || tCreated >= tValidUntil) {
      const err = reject('INVALID_SIGNATURE', 'Envelope timestamp is outside key validity window');
      recordAuditRejection({ db, dataDir, profileId, envelope, errorCode: 'INVALID_SIGNATURE' });
      throw err;
    }
  } else {
    const tValidFrom = Date.parse(keyRecord.valid_from);
    const tValidUntil = keyRecord.valid_until ? Date.parse(keyRecord.valid_until) : Infinity;
    if (tCreated < tValidFrom || tCreated >= tValidUntil) {
      const err = reject('INVALID_SIGNATURE', 'Envelope timestamp is outside registered key validity window');
      recordAuditRejection({ db, dataDir, profileId, envelope, errorCode: 'INVALID_SIGNATURE' });
      throw err;
    }
  }

  // 3. RFC 8785 JCS Canonicalization & Ed25519 Verification
  let signatureBuffer;
  try {
    signatureBuffer = Buffer.from(envelope.signature.value, 'base64url');
  } catch {
    const err = reject('INVALID_SIGNATURE', 'Signature value is not valid base64url');
    recordAuditRejection({ db, dataDir, profileId, envelope, errorCode: 'INVALID_SIGNATURE' });
    throw err;
  }

  let publicKey;
  try {
    publicKey = crypto.createPublicKey(Buffer.from(keyRecord.public_key_base64url, 'base64url'));
  } catch {
    publicKey = crypto.createPublicKey(keyRecord.public_key_base64url);
  }

  const canonicalBytes = signedBytes(envelope);
  const isValid = crypto.verify(null, canonicalBytes, publicKey, signatureBuffer);
  if (!isValid) {
    const err = reject('INVALID_SIGNATURE', 'Ed25519 signature verification failed');
    recordAuditRejection({ db, dataDir, profileId, envelope, errorCode: 'INVALID_SIGNATURE' });
    throw err;
  }

  const canonicalHash = crypto.createHash('sha256').update(canonicalBytes).digest('hex');
  return { accepted: true, canonical_hash: canonicalHash, message_id: envelope.message_id };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test sigil/connectors/v1/connector-validator.test.mjs`
Expected: PASS all 12 test cases.

- [x] **Step 5: Commit**

```bash
git add sigil/connectors/v1/connector-validator.mjs sigil/connectors/v1/connector-validator.test.mjs
git commit -m "feat(connector): implement fail-closed offline envelope validator with two-tier audit logging"
```

---

### Task 4: Full Test Suite Verification & Integration Preflight

**Files:**
- Test: All connector test suites

- [x] **Step 1: Run complete connector test suite**

Run: `node --test sigil/connectors/v1/*.test.mjs`
Expected: PASS across all connector test suites with zero failures.

- [x] **Step 2: Run JCS Conformance preflight audit**

Run: `pwsh -NoProfile -File C:\dev\scripts\verify-repo-context.ps1 -Path C:\dev\sigil-repo`
Expected: PREFLIGHT_PASS.

- [x] **Step 3: Commit and update STATUS.md**

```bash
git status
git commit -m "chore: complete local revocation cache and key registry offline validation"
```

