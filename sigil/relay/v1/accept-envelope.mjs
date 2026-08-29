import { validateEnvelope, reject, signedBytes, checkRecipientLocality } from './validate-envelope.mjs';
import { resolveRateLimits, DEFAULT_INBOX_DEPTH_LIMIT } from './relay-config.mjs';
import { writeRejectionAudit } from './rejection-audit.mjs';

// Rejection codes that represent a real, attributable security-relevant
// rejection worth auditing (design §9, round 3 blocker 5). A malformed-JSON
// INVALID_ENVELOPE before signature verification has no meaningful
// sender/conversation_id to audit against, so it's deliberately excluded.
const AUDITED_REJECTION_CODES = new Set(['CAPABILITY_DENIED', 'REPLAY_DETECTED', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'DIRECTORY_LINK_REQUIRED']);

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
  QUOTA_EXCEEDED: 429,
  DIRECTORY_LINK_REQUIRED: 403,
  MALFORMED_FEDERATED_ID: 400,
  RECIPIENT_NOT_LOCAL: 400,
  RECIPIENT_NOT_FOUND: 400
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
    // Recipient-locality check (design: federated addressing) runs here,
    // before the directory-link gate below -- a foreign-domain recipient
    // normally has no pre-existing directory_links row, so without this
    // early check DIRECTORY_LINK_REQUIRED would fire first and mask the
    // more specific RECIPIENT_NOT_LOCAL/MALFORMED_FEDERATED_ID diagnostic
    // that validateEnvelope would otherwise produce on the legacy path.
    // Pure string check -- needs only envelope + options.relayDomain, no
    // client/transaction/registry lookup.
    checkRecipientLocality(envelope, options.relayDomain);
    // Every direct recipient must exist in the relay's endpoint directory
    // before any delivery row can be written. Keep this lookup on the
    // acceptance transaction's client so a concurrent endpoint change cannot
    // turn an accepted envelope into a lost dead letter. Federated addresses
    // are checked only after locality validation; non-federated addresses use
    // their exact bare endpoint id.
    if (envelope.recipient?.endpoint_id && repository.lookupRecipientEndpoint) {
      const recipientId = envelope.recipient.endpoint_id;
      const registered = (await repository.lookupRecipientEndpoint(recipientId, client)) ?? options.registered?.get(recipientId);
      if (!registered || registered.status !== 'active') {
        throw reject('RECIPIENT_NOT_FOUND', 'The recipient endpoint does not exist in this relay\'s registry.', { recipient_id: recipientId });
      }
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
    // Rate-limit reservation (design §8, §18 #23): independent of envelope
    // content validity -- a flooding sender should be capped even if
    // individual envelopes are otherwise well-formed -- so this runs before
    // validateEnvelope. Runs inside the same transaction as everything else:
    // a RATE_LIMITED throw rolls the whole transaction back, including the
    // reserveRateLimit INSERT/UPDATE, so an over-limit request never
    // consumes its reservation.
    const limits = resolveRateLimits(options.rateLimits);
    const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
    for (const [scopeKind, scopeId] of [
      ['endpoint', envelope.sender.endpoint_id],
      ['owner', envelope.sender.owner_id],
      ['conversation', envelope.conversation_id],
    ]) {
      const reservation = await repository.reserveRateLimit(scopeKind, scopeId, windowStart, limits[scopeKind], client);
      if (!reservation.allowed) throw reject('RATE_LIMITED', `${scopeKind} rate limit exceeded`, { scope_kind: scopeKind, scope_id: scopeId, limit: limits[scopeKind] });
    }
    // Recipient inbox-depth limit (design §18 #23): a DEPTH limit on
    // currently-outstanding deliveries, not a rate limit -- independent of
    // and in addition to the sender-side reservations above. Derived live
    // from countOpenDeliveries rather than a separate counter, so it can
    // never drift from the actual queue. Only checked when there's a
    // concrete recipient; broadcast envelopes have no single inbox to bound.
    if (envelope.recipient?.endpoint_id) {
      const depthLimit = options.inboxDepthLimit ?? DEFAULT_INBOX_DEPTH_LIMIT;
      const openCount = await repository.countOpenDeliveries(envelope.recipient.endpoint_id, client);
      if (openCount >= depthLimit) throw reject('QUOTA_EXCEEDED', 'Recipient inbox depth limit reached', { recipient_endpoint_id: envelope.recipient.endpoint_id, limit: depthLimit });
    }
    // Directory-link gate (spec §8): a direct envelope (recipient.endpoint_id
    // set -- validateEnvelope's hasRecipient/hasBroadcast XOR guarantees a
    // broadcast envelope never reaches here) requires an active
    // directory_links row between sender and recipient. Broadcast delivery
    // is deliberately never checked here -- it's gated by conversation
    // membership instead (spec §8), which validateEnvelope's
    // broadcastAuthorizer already covers.
    //
    // Exception: two endpoints owned by the same human never need a
    // directory_links row -- the spec's own directory_links CHECK
    // (human_a <> human_b) makes one structurally impossible for a
    // same-owner pair, so gating on it here would permanently block a
    // human's own multi-endpoint traffic (e.g. their Codex and Claude
    // agents talking to each other), which is Sigil's primary use case.
    // Both the sender's and recipient's real owners are resolved from
    // options.registered (the trusted endpoint directory used for signature
    // verification), never from envelope.sender.owner_id or
    // envelope.recipient.owner_id, which are unverified client input.
    if (envelope.recipient?.endpoint_id && repository.lookupActiveDirectoryLink) {
      const recipientOwnerId = options.registered?.get(envelope.recipient.endpoint_id)?.owner_id;
      const senderOwnerId = options.registered?.get(envelope.sender.endpoint_id)?.owner_id;
      const sameOwner = recipientOwnerId && senderOwnerId && recipientOwnerId === senderOwnerId;
      if (!sameOwner) {
        const link = await repository.lookupActiveDirectoryLink(envelope.sender.endpoint_id, envelope.recipient.endpoint_id, client);
        if (!link) throw reject('DIRECTORY_LINK_REQUIRED', 'No active directory link between sender and recipient', { sender_endpoint_id: envelope.sender.endpoint_id, recipient_endpoint_id: envelope.recipient.endpoint_id });
      }
    }
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
  }).catch(async (error) => {
    const response = toResponse(options, error);
    if (AUDITED_REJECTION_CODES.has(error.code) && repository.recordAuditEvent) {
      await writeRejectionAudit({
        repository,
        event: { eventType: `envelope.rejected.${error.code.toLowerCase()}`, subjectId: envelope.message_id, endpointId: envelope.sender?.endpoint_id, outcome: 'rejected', reason: error.message, now },
        fallbackLog: options.rejectionAuditFallbackLog,
        degradedCounter: options.rejectionAuditDegradedCounter,
      });
    }
    return response;
  });
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
