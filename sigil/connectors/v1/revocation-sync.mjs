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
