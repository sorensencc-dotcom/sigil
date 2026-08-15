import { validateEnvelope } from './validate-envelope.mjs';

const statusByCode = Object.freeze({
  INVALID_ENVELOPE: 400,
  VERSION_UNSUPPORTED: 400,
  INVALID_SIGNATURE: 401,
  UNKNOWN_ENDPOINT: 401,
  ENDPOINT_REVOKED: 403,
  ROUTE_NOT_AUTHORIZED: 403,
  CAPABILITY_DENIED: 403,
  APPROVAL_REQUIRED: 403,
  MESSAGE_EXPIRED: 422,
  DUPLICATE_MESSAGE: 409,
  REPLAY_DETECTED: 409,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429
});

export function acceptEnvelope(envelope, options = {}) {
  try {
    const result = validateEnvelope(envelope, options);
    const existing = options.idempotency?.get(`${envelope.sender.endpoint_id}:${envelope.idempotency_key}`);
    if (existing) return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: existing.message_id, duplicate: true } };
    options.persist?.({ envelope, ...result });
    return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: result.message_id, duplicate: false } };
  } catch (error) {
    return {
      status: statusByCode[error.code] ?? 400,
      body: { request_id: options.request_id ?? null, code: error.code ?? 'INVALID_ENVELOPE', message: error.message, details: error.details ?? {} }
    };
  }
}

export async function acceptEnvelopeAsync(envelope, options = {}) {
  try {
    // Validate structure, expiry, route, signature, and canonical hash before
    // touching the idempotency store. Invalid input must not probe its keys.
    const result = validateEnvelope(envelope, { ...options, idempotency: new Map() });
    const prior = options.lookupIdempotency
      ? await options.lookupIdempotency(envelope.sender.endpoint_id, envelope.idempotency_key)
      : options.idempotency?.get(`${envelope.sender.endpoint_id}:${envelope.idempotency_key}`);
    if (prior && prior.canonical_hash !== result.canonical_hash) {
      const error = Object.assign(new Error('Idempotency key conflicts with an existing body'), { code: 'DUPLICATE_MESSAGE' });
      throw error;
    }
    if (prior) return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: prior.message_id, duplicate: true } };
    const persisted = await options.persist?.({ envelope, ...result });
    return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: persisted?.message_id ?? result.message_id, duplicate: persisted?.duplicate ?? false } };
  } catch (error) {
    return { status: statusByCode[error.code] ?? 400, body: { request_id: options.request_id ?? null, code: error.code ?? 'INVALID_ENVELOPE', message: error.message, details: error.details ?? {} } };
  }
}
