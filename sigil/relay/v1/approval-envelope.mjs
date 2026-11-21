import crypto from 'node:crypto';
import { reject, signedBytes } from './validate-envelope.mjs';
import { keyVerifies } from './trusted-endpoint.mjs';

const stripPrefix = (hash) => String(hash ?? '').replace(/^sha256:/, '');

export function envelopeHash(envelope) {
  return crypto.createHash('sha256').update(signedBytes(envelope)).digest('hex');
}

// Binds an approval challenge to the exact signed envelope a human is about to approve.
// The relay recomputes the canonical hash and checks the sender's signature itself, so the
// details shown on the approval page cannot differ from the bytes the approval authorizes.
// Throws a coded error (INVALID_ACTION, ROUTE_NOT_AUTHORIZED, UNKNOWN_ENDPOINT,
// ENDPOINT_REVOKED, INVALID_SIGNATURE, MESSAGE_EXPIRED) on any mismatch.
export function bindChallengeEnvelope({ envelope, actionHash, principalEndpointId, entry, now = new Date() } = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw reject('INVALID_ACTION', 'envelope must be an object');
  if (!principalEndpointId || envelope.sender?.endpoint_id !== principalEndpointId) {
    throw reject('ROUTE_NOT_AUTHORIZED', 'Envelope sender must be the authenticated endpoint');
  }
  let computed;
  try { computed = envelopeHash(envelope); } catch { throw reject('INVALID_ACTION', 'envelope cannot be canonicalized'); }
  if (actionHash != null && stripPrefix(actionHash) !== computed) {
    throw reject('INVALID_ACTION', 'action_hash does not match the envelope canonical hash');
  }
  if (!entry) throw reject('UNKNOWN_ENDPOINT', 'Sender endpoint is not registered');
  if (entry.status !== 'active') throw reject('ENDPOINT_REVOKED', 'Sender endpoint is not active');
  const signature = envelope.signature;
  if (signature?.algorithm !== 'Ed25519' || !signature.key_id || !signature.value) throw reject('INVALID_SIGNATURE', 'Complete Ed25519 signature metadata is required');
  const key = entry.keys instanceof Map ? entry.keys.get(signature.key_id) : undefined;
  if (!key?.public_key) throw reject('INVALID_SIGNATURE', 'Signature key is not registered for the endpoint');
  if (!keyVerifies(key, now)) throw reject('INVALID_SIGNATURE', 'Signature key is outside its validity window');
  let value;
  try { value = Buffer.from(signature.value, 'base64url'); } catch { throw reject('INVALID_SIGNATURE', 'Signature value is not base64url'); }
  if (!value.length || !crypto.verify(null, signedBytes(envelope), key.public_key, value)) throw reject('INVALID_SIGNATURE', 'Envelope signature verification failed');
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!(Date.parse(envelope.expires_at) > nowMs)) throw reject('MESSAGE_EXPIRED', 'Envelope has already expired');
  return {
    actionHash: computed,
    conversationId: envelope.conversation_id ?? null,
    messageId: envelope.message_id ?? null,
    capabilities: Array.isArray(envelope.capabilities) ? envelope.capabilities : [],
    envelope,
  };
}
