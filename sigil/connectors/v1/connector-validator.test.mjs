import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConnectorDatabase } from './connector-db-adapter.mjs';
import { canonicalJsonBytes } from '../../relay/v1/jcs.mjs';
import { verifyInboundEnvelopeOffline, signedBytes } from './connector-validator.mjs';
import { applySignedRevocationSync } from './revocation-sync.mjs';

function createTestHarness() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'sigil-validator-test-'));
  const db = new ConnectorDatabase(path.join(dir, 'connector.db'), new URL('./connector-schema.sql', import.meta.url));
  const profileId = 'prof_alice';

  db.upsertProfile({
    profile_id: profileId,
    owner_id: 'usr_alice',
    endpoint_id: 'ep_alice@relay.example',
    display_name: 'Alice',
    relay_url: 'ws://relay.example/v1/stream',
    secure_key_reference: 'k_ref',
    secure_token_reference: 't_ref'
  });

  const { publicKey: senderPub, privateKey: senderPriv } = crypto.generateKeyPairSync('ed25519');
  const senderPublicKeyBase64url = senderPub.export({ type: 'spki', format: 'der' }).toString('base64url');

  db.upsertKeyCache({
    profile_id: profileId,
    endpoint_id: 'ep_bob@relay.example',
    key_id: 'key_bob_1',
    algorithm: 'Ed25519',
    public_key_base64url: senderPublicKeyBase64url,
    valid_from: '2026-08-01T00:00:00.000Z',
    valid_until: '2026-09-01T00:00:00.000Z',
    status: 'active',
    synced_sequence: 1
  });

  return {
    dir,
    db,
    profileId,
    senderPub,
    senderPriv,
    senderPublicKeyBase64url,
    cleanup() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function buildAndSignEnvelope({
  privateKey,
  keyId = 'key_bob_1',
  senderEndpointId = 'ep_bob@relay.example',
  senderOwnerId = 'usr_bob',
  createdAt = '2026-08-28T12:00:00.000Z',
  expiresAt = '2026-08-28T16:00:00.000Z',
  body = { message: 'hello from bob' }
}) {
  const envelope = {
    protocol: 'sigil/1',
    message_id: `msg_${crypto.randomUUID()}`,
    conversation_id: 'conv_123',
    message_type: 'sigil.chat/message',
    sender: {
      endpoint_id: senderEndpointId,
      owner_id: senderOwnerId
    },
    body,
    context_refs: [],
    capabilities: [],
    idempotency_key: `idem_${crypto.randomUUID()}`,
    created_at: createdAt,
    expires_at: expiresAt
  };

  const unsigned = signedBytes(envelope);
  const sig = crypto.sign(null, unsigned, privateKey).toString('base64url');
  envelope.signature = {
    algorithm: 'Ed25519',
    key_id: keyId,
    value: sig
  };

  return envelope;
}

test('TEST-REV-01: Standard Active Key verification succeeds', () => {
  const h = createTestHarness();
  try {
    const envelope = buildAndSignEnvelope({
      privateKey: h.senderPriv,
      createdAt: '2026-08-28T12:00:00.000Z',
      expiresAt: '2026-08-28T14:00:00.000Z'
    });

    const res = verifyInboundEnvelopeOffline({
      envelope,
      profileId: h.profileId,
      db: h.db,
      dataDir: h.dir,
      now: new Date('2026-08-28T12:02:00.000Z')
    });

    assert.equal(res.accepted, true);
    assert.equal(res.message_id, envelope.message_id);
    assert.match(res.canonical_hash, /^[0-9a-f]{64}$/);
  } finally {
    h.cleanup();
  }
});

test('TEST-REV-02: Pre-Revocation Validity (T_msg < T_rev within skew window)', () => {
  const h = createTestHarness();
  try {
    // Record a revocation event at 12:30:00.000Z
    h.db.batchUpsertRevocationIntervals(h.profileId, [
      {
        revocation_event_id: 'rev_1',
        endpoint_id: 'ep_bob@relay.example',
        key_id: 'key_bob_1',
        revoked_at: '2026-08-28T12:30:00.000Z',
        reason: 'rotation',
        valid_from: '2026-08-01T00:00:00.000Z',
        valid_until: '2026-09-01T00:00:00.000Z'
      }
    ], 2);

    // Message created at 12:28:00 (before revocation) and verified at 12:29:00
    const envelope = buildAndSignEnvelope({
      privateKey: h.senderPriv,
      createdAt: '2026-08-28T12:28:00.000Z',
      expiresAt: '2026-08-28T16:00:00.000Z'
    });

    const res = verifyInboundEnvelopeOffline({
      envelope,
      profileId: h.profileId,
      db: h.db,
      dataDir: h.dir,
      now: new Date('2026-08-28T12:29:00.000Z')
    });

    assert.equal(res.accepted, true);
  } finally {
    h.cleanup();
  }
});

test('TEST-REV-03: Post-Revocation Rejection (T_msg >= T_rev throws KEY_REVOKED and records Tier 1 audit)', () => {
  const h = createTestHarness();
  try {
    h.db.batchUpsertRevocationIntervals(h.profileId, [
      {
        revocation_event_id: 'rev_1',
        endpoint_id: 'ep_bob@relay.example',
        key_id: 'key_bob_1',
        revoked_at: '2026-08-28T12:30:00.000Z',
        reason: 'compromised',
        valid_from: '2026-08-01T00:00:00.000Z',
        valid_until: '2026-09-01T00:00:00.000Z'
      }
    ], 2);

    // Message created at 12:31:00 (after revocation)
    const envelope = buildAndSignEnvelope({
      privateKey: h.senderPriv,
      createdAt: '2026-08-28T12:31:00.000Z',
      expiresAt: '2026-08-28T16:00:00.000Z'
    });

    assert.throws(
      () => verifyInboundEnvelopeOffline({
        envelope,
        profileId: h.profileId,
        db: h.db,
        dataDir: h.dir,
        now: new Date('2026-08-28T12:32:00.000Z')
      }),
      (err) => err.code === 'KEY_REVOKED'
    );

    // Verify Tier 1 audit event in SQLite
    const auditRow = h.db.db.prepare('SELECT * FROM audit_events WHERE event_type = ?').get('security.verification_rejection');
    assert.ok(auditRow, 'Tier 1 audit event should exist in SQLite');
    assert.equal(auditRow.subject_id, 'ep_bob@relay.example');
    const payload = JSON.parse(auditRow.payload);
    assert.equal(payload.error_code, 'KEY_REVOKED');
    assert.equal(payload.key_id, 'key_bob_1');
  } finally {
    h.cleanup();
  }
});

test('TEST-REV-04: JCS Key Reordering stability', () => {
  const h = createTestHarness();
  try {
    // Create an envelope with arbitrarily unordered keys in body
    const body = {
      zebra: 'stripes',
      alpha: 1,
      nested: { zoo: true, ant: false }
    };

    const envelope = buildAndSignEnvelope({
      privateKey: h.senderPriv,
      createdAt: '2026-08-28T12:00:00.000Z',
      expiresAt: '2026-08-28T14:00:00.000Z',
      body
    });

    const res = verifyInboundEnvelopeOffline({
      envelope,
      profileId: h.profileId,
      db: h.db,
      dataDir: h.dir,
      now: new Date('2026-08-28T12:01:00.000Z')
    });

    assert.equal(res.accepted, true);
  } finally {
    h.cleanup();
  }
});

test('TEST-REV-05: Clock Skew Exceeded (|T_local - T_created| > 5 min)', () => {
  const h = createTestHarness();
  try {
    const envelope = buildAndSignEnvelope({
      privateKey: h.senderPriv,
      createdAt: '2026-08-28T12:00:00.000Z',
      expiresAt: '2026-08-28T16:00:00.000Z'
    });

    // Local time is 10 minutes ahead of created_at
    assert.throws(
      () => verifyInboundEnvelopeOffline({
        envelope,
        profileId: h.profileId,
        db: h.db,
        dataDir: h.dir,
        now: new Date('2026-08-28T12:10:00.000Z')
      }),
      (err) => err.code === 'CLOCK_SKEW_EXCEEDED'
    );
  } finally {
    h.cleanup();
  }
});

test('TEST-REV-06: Two-Tier Audit Fallback (writes to security-failures.log when SQLite fails)', () => {
  const h = createTestHarness();
  try {
    // Mock db with a failing statement runner
    const brokenDb = {
      getKeyCache: (...args) => h.db.getKeyCache(...args),
      getRevocationInterval: (...args) => h.db.getRevocationInterval(...args),
      db: {
        prepare: () => {
          throw new Error('SQLITE_BUSY: database is locked');
        }
      }
    };

    const envelope = buildAndSignEnvelope({
      privateKey: h.senderPriv,
      createdAt: '2026-08-28T12:00:00.000Z',
      expiresAt: '2026-08-28T16:00:00.000Z'
    });

    // Trigger clock skew rejection which calls audit logger
    assert.throws(
      () => verifyInboundEnvelopeOffline({
        envelope,
        profileId: h.profileId,
        db: brokenDb,
        dataDir: h.dir,
        now: new Date('2026-08-28T12:10:00.000Z')
      }),
      (err) => err.code === 'CLOCK_SKEW_EXCEEDED'
    );

    // Verify Tier 2 fallback log file
    const logPath = path.join(h.dir, 'logs', 'security-failures.log');
    assert.ok(fs.existsSync(logPath), 'security-failures.log must exist');
    const logContent = fs.readFileSync(logPath, 'utf8');
    const parsed = JSON.parse(logContent.trim().split('\n')[0]);
    assert.equal(parsed.event_type, 'security.verification_rejection');
    assert.equal(parsed.payload.error_code, 'CLOCK_SKEW_EXCEEDED');
  } finally {
    h.cleanup();
  }
});

test('TEST-REV-07: Strict UTC format check (missing Z rejected with INVALID_ENVELOPE)', () => {
  const h = createTestHarness();
  try {
    const envelope = buildAndSignEnvelope({
      privateKey: h.senderPriv,
      createdAt: '2026-08-28T12:00:00', // Missing 'Z'
      expiresAt: '2026-08-28T16:00:00.000Z'
    });

    assert.throws(
      () => verifyInboundEnvelopeOffline({
        envelope,
        profileId: h.profileId,
        db: h.db,
        dataDir: h.dir,
        now: new Date('2026-08-28T12:00:00.000Z')
      }),
      (err) => err.code === 'INVALID_ENVELOPE'
    );
  } finally {
    h.cleanup();
  }
});

test('TEST-REV-08: Current-time expired (T_local >= T_expires)', () => {
  const h = createTestHarness();
  try {
    const envelope = buildAndSignEnvelope({
      privateKey: h.senderPriv,
      createdAt: '2026-08-28T12:00:00.000Z',
      expiresAt: '2026-08-28T12:01:00.000Z'
    });

    // Verification time is 12:02:00 (after expires_at)
    assert.throws(
      () => verifyInboundEnvelopeOffline({
        envelope,
        profileId: h.profileId,
        db: h.db,
        dataDir: h.dir,
        now: new Date('2026-08-28T12:02:00.000Z')
      }),
      (err) => err.code === 'MESSAGE_EXPIRED'
    );
  } finally {
    h.cleanup();
  }
});

test('TEST-REV-09: Lifetime exceeded (T_expires > T_created + 24h)', () => {
  const h = createTestHarness();
  try {
    const envelope = buildAndSignEnvelope({
      privateKey: h.senderPriv,
      createdAt: '2026-08-28T12:00:00.000Z',
      expiresAt: '2026-08-29T13:00:00.000Z' // 25 hours later
    });

    assert.throws(
      () => verifyInboundEnvelopeOffline({
        envelope,
        profileId: h.profileId,
        db: h.db,
        dataDir: h.dir,
        now: new Date('2026-08-28T12:00:00.000Z')
      }),
      (err) => err.code === 'INVALID_ENVELOPE'
    );
  } finally {
    h.cleanup();
  }
});

test('TEST-REV-10: Unknown key (key not in local registry rejected with UNKNOWN_KEY)', () => {
  const h = createTestHarness();
  try {
    const envelope = buildAndSignEnvelope({
      privateKey: h.senderPriv,
      keyId: 'key_unknown_999',
      createdAt: '2026-08-28T12:00:00.000Z',
      expiresAt: '2026-08-28T16:00:00.000Z'
    });

    assert.throws(
      () => verifyInboundEnvelopeOffline({
        envelope,
        profileId: h.profileId,
        db: h.db,
        dataDir: h.dir,
        now: new Date('2026-08-28T12:01:00.000Z')
      }),
      (err) => err.code === 'UNKNOWN_KEY'
    );
  } finally {
    h.cleanup();
  }
});

test('TEST-REV-11: Malformed base64url signature rejected with INVALID_SIGNATURE', () => {
  const h = createTestHarness();
  try {
    const envelope = buildAndSignEnvelope({
      privateKey: h.senderPriv,
      createdAt: '2026-08-28T12:00:00.000Z',
      expiresAt: '2026-08-28T16:00:00.000Z'
    });

    envelope.signature.value = 'invalid_sig_value_not_matching';

    assert.throws(
      () => verifyInboundEnvelopeOffline({
        envelope,
        profileId: h.profileId,
        db: h.db,
        dataDir: h.dir,
        now: new Date('2026-08-28T12:01:00.000Z')
      }),
      (err) => err.code === 'INVALID_SIGNATURE'
    );
  } finally {
    h.cleanup();
  }
});

test('TEST-REV-12: Signed sync manifest verification', () => {
  const h = createTestHarness();
  try {
    const { publicKey: relayPub, privateKey: relayPriv } = crypto.generateKeyPairSync('ed25519');

    const manifestBody = {
      protocol: 'sigil/1',
      manifest_type: 'revocation_sync',
      relay_id: 'relay.example',
      sequence: 10,
      issued_at: '2026-08-28T12:00:00.000Z',
      revocations: [
        {
          revocation_event_id: 'rev_sync_1',
          endpoint_id: 'ep_bob@relay.example',
          key_id: 'key_bob_1',
          revoked_at: '2026-08-28T12:05:00.000Z',
          reason: 'administrative_invalidation',
          valid_from: '2026-08-01T00:00:00.000Z',
          valid_until: '2026-09-01T00:00:00.000Z'
        }
      ]
    };
    const unsignedBytes = canonicalJsonBytes(manifestBody);
    const sigValue = crypto.sign(null, unsignedBytes, relayPriv).toString('base64url');
    const manifest = {
      ...manifestBody,
      signature: {
        algorithm: 'Ed25519',
        key_id: 'relay_k1',
        value: sigValue
      }
    };

    const res = applySignedRevocationSync({
      db: h.db,
      profileId: h.profileId,
      manifest,
      relayPublicKey: relayPub,
      lastSequence: 1
    });

    assert.equal(res.appliedCount, 1);
    assert.equal(res.sequence, 10);

    // Now verify that a message created at 12:06:00 is rejected with KEY_REVOKED
    const envelope = buildAndSignEnvelope({
      privateKey: h.senderPriv,
      createdAt: '2026-08-28T12:06:00.000Z',
      expiresAt: '2026-08-28T16:00:00.000Z'
    });

    assert.throws(
      () => verifyInboundEnvelopeOffline({
        envelope,
        profileId: h.profileId,
        db: h.db,
        dataDir: h.dir,
        now: new Date('2026-08-28T12:07:00.000Z')
      }),
      (err) => err.code === 'KEY_REVOKED'
    );
  } finally {
    h.cleanup();
  }
});
