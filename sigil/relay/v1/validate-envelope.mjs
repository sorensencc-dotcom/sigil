import crypto from 'node:crypto';
import { canonicalJsonBytes } from './jcs.mjs';
import { validateTaskRequestBody } from '../../contracts/v1/task-request-schema.mjs';
import { validateTaskResultBody } from '../../contracts/v1/task-result-schema.mjs';

const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

export function signedBytes(envelope) {
  const unsigned = { ...envelope };
  delete unsigned.signature;
  return canonicalJsonBytes(unsigned);
}

export function reject(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

export function validateEnvelope(envelope, { now = new Date(), registered = new Map(), idempotency = new Map(), broadcastAuthorizer, requiresApproval, approvedActionHashes = new Set() } = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw reject('INVALID_ENVELOPE', 'Envelope must be an object');
  }
  const required = ['protocol', 'message_id', 'conversation_id', 'message_type', 'sender', 'body', 'context_refs', 'capabilities', 'idempotency_key', 'created_at', 'expires_at', 'signature'];
  for (const field of required) if (!(field in envelope)) throw reject('INVALID_ENVELOPE', `Missing field: ${field}`, { field });
  if (envelope.protocol !== 'sigil/1') throw reject('VERSION_UNSUPPORTED', 'Unsupported protocol version');
  if (!envelope.sender?.endpoint_id || !envelope.sender?.owner_id) throw reject('INVALID_ENVELOPE', 'Sender identity is required');
  const endpoint = registered.get(envelope.sender.endpoint_id);
  if (!endpoint) throw reject('UNKNOWN_ENDPOINT', 'Sender endpoint is not registered');
  if (endpoint.status !== 'active') throw reject('ENDPOINT_REVOKED', 'Sender endpoint is not active');
  if (endpoint.owner_id !== envelope.sender.owner_id) throw reject('ROUTE_NOT_AUTHORIZED', 'Sender owner mismatch');
  if (envelope.signature?.algorithm !== 'Ed25519' || !envelope.signature.key_id || !envelope.signature.value) throw reject('INVALID_SIGNATURE', 'Complete Ed25519 signature metadata is required');
  const timestamp = now instanceof Date ? now.getTime() : Date.parse(now);
  const keys = endpoint.keys instanceof Map ? [...endpoint.keys.values()] : Array.isArray(endpoint.keys) ? endpoint.keys : [];
  const key = envelope.signature.key_id === endpoint.key_id ? endpoint : keys.find((candidate) => candidate.key_id === envelope.signature.key_id);
  if (!key?.public_key) throw reject('INVALID_SIGNATURE', 'Signature key is not registered for the endpoint');
  const validFrom = key.valid_from ? Date.parse(key.valid_from) : -Infinity;
  const validUntil = key.valid_until ? Date.parse(key.valid_until) : Infinity;
  if (!Number.isFinite(timestamp) || timestamp < validFrom || timestamp >= validUntil || key.status === 'revoked') throw reject('INVALID_SIGNATURE', 'Signature key is outside its validity window');
  let signature;
  try { signature = Buffer.from(envelope.signature.value, 'base64url'); } catch { throw reject('INVALID_SIGNATURE', 'Signature value is not base64url'); }
  if (!signature.length) throw reject('INVALID_SIGNATURE', 'Registered public key is required');
  if (!crypto.verify(null, signedBytes(envelope), key.public_key, signature)) throw reject('INVALID_SIGNATURE', 'Envelope signature verification failed');
  const created = Date.parse(envelope.created_at);
  const expires = Date.parse(envelope.expires_at);
  if (!Number.isFinite(created) || !Number.isFinite(expires)) throw reject('INVALID_ENVELOPE', 'Timestamps must be valid ISO dates');
  if (created > timestamp + 5 * 60 * 1000 || created < timestamp - 5 * 60 * 1000) throw reject('INVALID_ENVELOPE', 'Created time exceeds clock-skew tolerance');
  if (expires <= created || expires > created + MAX_LIFETIME_MS) throw reject('MESSAGE_EXPIRED', 'Invalid message lifetime');
  const hasRecipient = Boolean(envelope.recipient);
  const hasBroadcast = Boolean(envelope.broadcast_scope);
  if (hasRecipient === hasBroadcast) throw reject('INVALID_ENVELOPE', 'Exactly one recipient or broadcast scope is required');
  if (hasBroadcast && (typeof broadcastAuthorizer !== 'function' || !broadcastAuthorizer(envelope.broadcast_scope, envelope))) throw reject('ROUTE_NOT_AUTHORIZED', 'Broadcast scope is not authorized for this conversation');
  if (!Array.isArray(envelope.context_refs) || !Array.isArray(envelope.capabilities)) throw reject('INVALID_ENVELOPE', 'context_refs and capabilities must be arrays');
  if (envelope.message_type === 'task.request') validateTaskRequestBody(envelope.body);
  if (envelope.message_type === 'task.result') validateTaskResultBody(envelope.body);
  const prior = idempotency.get(`${envelope.sender.endpoint_id}:${envelope.idempotency_key}`);
  const canonicalHash = crypto.createHash('sha256').update(signedBytes(envelope)).digest('hex');
  if (typeof requiresApproval === 'function' && requiresApproval(envelope) && !approvedActionHashes.has(canonicalHash) && !approvedActionHashes.has(`sha256:${canonicalHash}`)) throw reject('APPROVAL_REQUIRED', 'A valid decision record is required before delivery');
  if (prior && prior.canonical_hash !== canonicalHash) throw reject('DUPLICATE_MESSAGE', 'Idempotency key conflicts with an existing body');
  return { accepted: true, canonical_hash: canonicalHash, endpoint_id: envelope.sender.endpoint_id, message_id: envelope.message_id };
}
