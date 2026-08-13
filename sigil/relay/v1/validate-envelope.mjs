import crypto from 'node:crypto';

const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

export function signedBytes(envelope) {
  const unsigned = { ...envelope };
  delete unsigned.signature;
  return Buffer.from(canonicalize(unsigned), 'utf8');
}

export function reject(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

export function validateEnvelope(envelope, { now = new Date(), registered = new Map(), idempotency = new Map() } = {}) {
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
  if (envelope.signature.key_id !== endpoint.key_id) throw reject('INVALID_SIGNATURE', 'Signature key is not the endpoint active key');
  let signature;
  try { signature = Buffer.from(envelope.signature.value, 'base64url'); } catch { throw reject('INVALID_SIGNATURE', 'Signature value is not base64url'); }
  if (!signature.length || !endpoint.public_key) throw reject('INVALID_SIGNATURE', 'Registered public key is required');
  if (!crypto.verify(null, signedBytes(envelope), endpoint.public_key, signature)) throw reject('INVALID_SIGNATURE', 'Envelope signature verification failed');
  const created = Date.parse(envelope.created_at);
  const expires = Date.parse(envelope.expires_at);
  const timestamp = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(created) || !Number.isFinite(expires)) throw reject('INVALID_ENVELOPE', 'Timestamps must be valid ISO dates');
  if (created > timestamp + 5 * 60 * 1000 || created < timestamp - 5 * 60 * 1000) throw reject('INVALID_ENVELOPE', 'Created time exceeds clock-skew tolerance');
  if (expires <= created || expires > created + MAX_LIFETIME_MS) throw reject('MESSAGE_EXPIRED', 'Invalid message lifetime');
  const hasRecipient = Boolean(envelope.recipient);
  const hasBroadcast = Boolean(envelope.broadcast_scope);
  if (hasRecipient === hasBroadcast) throw reject('INVALID_ENVELOPE', 'Exactly one recipient or broadcast scope is required');
  if (!Array.isArray(envelope.context_refs) || !Array.isArray(envelope.capabilities)) throw reject('INVALID_ENVELOPE', 'context_refs and capabilities must be arrays');
  const prior = idempotency.get(`${envelope.sender.endpoint_id}:${envelope.idempotency_key}`);
  const canonicalHash = crypto.createHash('sha256').update(signedBytes(envelope)).digest('hex');
  if (prior && prior.canonical_hash !== canonicalHash) throw reject('DUPLICATE_MESSAGE', 'Idempotency key conflicts with an existing body');
  return { accepted: true, canonical_hash: canonicalHash, endpoint_id: envelope.sender.endpoint_id, message_id: envelope.message_id };
}
