import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJsonBytes } from '../../relay/v1/jcs.mjs';

const STRICT_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

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

function importEd25519PublicKey(rawOrSpki) {
  if (typeof rawOrSpki === 'object' && rawOrSpki !== null && 'type' in rawOrSpki) {
    return rawOrSpki;
  }
  let buf;
  if (typeof rawOrSpki === 'string') {
    if (rawOrSpki.startsWith('-----BEGIN')) {
      return crypto.createPublicKey(rawOrSpki);
    }
    buf = Buffer.from(rawOrSpki, 'base64url');
    if (buf.length === 0) {
      buf = Buffer.from(rawOrSpki, 'base64');
    }
  } else if (Buffer.isBuffer(rawOrSpki)) {
    buf = rawOrSpki;
  }

  if (buf && buf.length === 32) {
    const spkiBuf = Buffer.concat([ED25519_SPKI_PREFIX, buf]);
    return crypto.createPublicKey({ key: spkiBuf, format: 'der', type: 'spki' });
  } else if (buf && buf.length === 44) {
    return crypto.createPublicKey({ key: buf, format: 'der', type: 'spki' });
  } else {
    try {
      return crypto.createPublicKey({ key: buf, format: 'der', type: 'spki' });
    } catch {
      return crypto.createPublicKey(rawOrSpki);
    }
  }
}

function recordAuditRejection({ db, dataDir, profileId, envelope, errorCode }) {
  const eventId = crypto.randomUUID();
  const nowStr = new Date().toISOString();
  let canonicalHash = null;
  try {
    if (envelope) {
      canonicalHash = crypto.createHash('sha256').update(signedBytes(envelope)).digest('hex');
    }
  } catch {
    // Envelope might not be canonicalizable; hash remains null
  }
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
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    const err = reject('INVALID_ENVELOPE', 'Envelope must be an object');
    recordAuditRejection({ db, dataDir, profileId, envelope: null, errorCode: 'INVALID_ENVELOPE' });
    throw err;
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

  if (!envelope.sender?.endpoint_id || typeof envelope.sender.endpoint_id !== 'string') {
    const err = reject('INVALID_ENVELOPE', 'Sender endpoint identity is required');
    recordAuditRejection({ db, dataDir, profileId, envelope, errorCode: 'INVALID_ENVELOPE' });
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

  if (!envelope.signature?.key_id || envelope.signature.algorithm !== 'Ed25519' || !envelope.signature.value) {
    const err = reject('INVALID_SIGNATURE', 'Complete Ed25519 signature metadata is required');
    recordAuditRejection({ db, dataDir, profileId, envelope, errorCode: 'INVALID_SIGNATURE' });
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
    publicKey = importEd25519PublicKey(keyRecord.public_key_base64url);
  } catch (keyErr) {
    const err = reject('INVALID_SIGNATURE', 'Failed to import registered public key', { cause: keyErr.message });
    recordAuditRejection({ db, dataDir, profileId, envelope, errorCode: 'INVALID_SIGNATURE' });
    throw err;
  }

  const canonicalBytes = signedBytes(envelope);
  let isValid = false;
  try {
    isValid = crypto.verify(null, canonicalBytes, publicKey, signatureBuffer);
  } catch {
    isValid = false;
  }

  if (!isValid) {
    const err = reject('INVALID_SIGNATURE', 'Ed25519 signature verification failed');
    recordAuditRejection({ db, dataDir, profileId, envelope, errorCode: 'INVALID_SIGNATURE' });
    throw err;
  }

  const canonicalHash = crypto.createHash('sha256').update(canonicalBytes).digest('hex');
  return { accepted: true, canonical_hash: canonicalHash, message_id: envelope.message_id };
}
