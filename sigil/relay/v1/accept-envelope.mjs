import { validateEnvelope, reject, signedBytes } from './validate-envelope.mjs';

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

function toResponse(options, error) {
  return { status: statusByCode[error.code] ?? 400, body: { request_id: options.request_id ?? null, code: error.code ?? 'INVALID_ENVELOPE', message: error.message, details: error.details ?? {} } };
}

export function acceptEnvelope(envelope, options = {}) {
  try {
    const result = validateEnvelope(envelope, options);
    const existing = options.idempotency?.get(`${envelope.sender.endpoint_id}:${envelope.idempotency_key}`);
    if (existing) return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: existing.message_id, duplicate: true } };
    options.persist?.({ envelope, ...result });
    return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: result.message_id, duplicate: false } };
  } catch (error) {
    return toResponse(options, error);
  }
}

// Repository-backed accept path (design §3): every repository-backed check
// (task cross-reference here; replay/capability/quota join in later
// workstreams) runs inside ONE transaction on ONE client, loaded before
// validateEnvelope runs and persisted in the same transaction that accepted
// it. validateEnvelope itself stays synchronous/pure -- it only ever sees
// already-resolved snapshots, never the client.
async function acceptWithRepository(envelope, options) {
  const { repository, now = new Date() } = options;
  return repository.withTransaction(async (client) => {
    // Replay check (design §6, §18 #13): the scoped (sender_endpoint_id,
    // message_id) lookup happens first, before validateEnvelope's own
    // expiry check can run. A prior accepted record under a *different*
    // idempotency_key is a replay -- classified and rejected immediately,
    // skipping expiry entirely. Same idempotency_key falls through to the
    // ordinary duplicate path below (handled by validateEnvelope + the
    // lookupIdempotency check that follows).
    const priorMessage = await repository.lookupAcceptedMessageId(envelope.sender.endpoint_id, envelope.message_id, client);
    if (priorMessage && priorMessage.idempotency_key !== envelope.idempotency_key) {
      throw reject('REPLAY_DETECTED', 'message_id was already accepted under a different idempotency_key');
    }
    // Capability registry fail-closed check (design §7): a capability not
    // found in the registry is rejected outright here, before target-scope
    // matching even runs -- it does NOT fall through to the
    // conversation-scope default inside validateEnvelope.
    for (const capability of envelope.capabilities ?? []) {
      const registered_ = await repository.lookupCapabilityRegistration(capability, client);
      if (!registered_) throw reject('CAPABILITY_DENIED', `Capability is not registered: ${capability}`, { capability });
    }
    const capabilityGrants = await repository.lookupActiveCapabilityGrants(envelope.sender.endpoint_id, now, client);
    const result = validateEnvelope(envelope, { ...options, idempotency: new Map(), capabilityGrants });
    const prior = await repository.lookupIdempotency(envelope.sender.endpoint_id, envelope.idempotency_key, client);
    if (prior && prior.canonical_hash !== result.canonical_hash) throw reject('DUPLICATE_MESSAGE', 'Idempotency key conflicts with an existing body');
    if (prior) return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: prior.message_id, duplicate: true } };
    if (envelope.message_type === 'task.result') {
      const visible = await repository.lookupTaskRequest(envelope.body.task_id, envelope.conversation_id, client);
      if (!visible) throw reject('INVALID_ENVELOPE', 'task.result references a task_id with no visible task.request', { field: 'task_id', reason: 'no visible task.request' });
    }
    // canonical_bytes/action_hash mirror what http-server.mjs's now-removed
    // persistAccepted wrapper used to attach before calling the repository
    // directly -- kept here so repository-backed callers (postgres, memory)
    // still see the same row shape regardless of transport.
    const persisted = await repository.persistAcceptedEnvelope({ envelope, ...result, canonical_bytes: signedBytes(envelope), action_hash: result.canonical_hash }, client);
    if (options.onPersisted) await options.onPersisted({ envelope, persisted });
    return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: persisted?.message_id ?? result.message_id, duplicate: persisted?.duplicate ?? false } };
  }).catch((error) => toResponse(options, error));
}

export async function acceptEnvelopeAsync(envelope, options = {}) {
  if (options.repository?.withTransaction) return acceptWithRepository(envelope, options);
  // Legacy / unit-test path: no repository, caller supplies plain
  // lookupIdempotency + persist callbacks (map-backed, no transaction).
  try {
    const result = validateEnvelope(envelope, { ...options, idempotency: new Map() });
    const prior = options.lookupIdempotency
      ? await options.lookupIdempotency(envelope.sender.endpoint_id, envelope.idempotency_key)
      : options.idempotency?.get(`${envelope.sender.endpoint_id}:${envelope.idempotency_key}`);
    if (prior && prior.canonical_hash !== result.canonical_hash) throw reject('DUPLICATE_MESSAGE', 'Idempotency key conflicts with an existing body');
    if (prior) return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: prior.message_id, duplicate: true } };
    const persisted = await options.persist?.({ envelope, ...result });
    return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: persisted?.message_id ?? result.message_id, duplicate: persisted?.duplicate ?? false } };
  } catch (error) {
    return toResponse(options, error);
  }
}
