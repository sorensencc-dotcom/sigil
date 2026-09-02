import { validateEnvelope, reject, signedBytes, checkRecipientLocality } from './validate-envelope.mjs';
import { resolveRateLimits, DEFAULT_INBOX_DEPTH_LIMIT } from './relay-config.mjs';
import { writeRejectionAudit } from './rejection-audit.mjs';
import { decideRoute, buildForwardRequest, signForwardRequest, postForward } from './federation-router.mjs';

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
  RECIPIENT_NOT_FOUND: 400,
  PEER_NOT_PINNED: 400,
  FEDERATION_HOP_EXCEEDED: 400,
  FORWARD_MISCONFIGURED: 500,
  FORWARD_REJECTED: 502,
  FORWARD_UNAVAILABLE: 504
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

  // ── Phase 1: route decision + sync-only forward ──────────────────────────
  // decideRoute is a read-only peers-table lookup; no transaction is needed.
  // The route is computed here so the sync forward path never opens a Postgres
  // connection -- a slow or hung peer would otherwise hold a connection for up
  // to the 5 s postForward timeout (I1).
  const route = await decideRoute(envelope, {
    relayDomain: options.relayDomain,
    federationMode: options.federationMode,
    getPeerByDomain: repository.getPeerByDomain ? (d) => repository.getPeerByDomain(d) : async () => null,
  });

  // Only the sync forward path exits before opening a transaction.
  // Queue forward falls through to Phase 2 so enqueueForward's INSERT + audit
  // remain atomic inside the transaction. The explicit 'sync' guard is
  // intentional: a future third mode must opt in here, not fall through
  // silently with a null client.
  if (route.action === 'reject' || (route.action === 'forward' && options.federationMode === 'sync')) {
    try {
      if (route.action === 'reject') throw reject(route.code, `${route.code}`, route.details ?? {});

      // Replay check on the sync forward path: preserves pre-refactor behavior
      // where a forwarded envelope from a local sender that reused a message_id
      // (previously accepted to a local recipient under a different
      // idempotency_key) is rejected with REPLAY_DETECTED.
      // lookupAcceptedMessageId(…, undefined) triggers the `client = this.pool`
      // default -- a regular pool checkout, not a transaction. Safe here:
      // nothing is written locally on the sync forward path, so there is no
      // atomicity requirement.
      const priorMessage = await repository.lookupAcceptedMessageId(
        envelope.sender.endpoint_id, envelope.message_id, undefined
      );
      if (priorMessage && priorMessage.idempotency_key !== envelope.idempotency_key) {
        throw reject('REPLAY_DETECTED', 'message_id was already accepted under a different idempotency_key');
      }

      // client = null: forwardEnvelope passes it only to lookupRecipientEndpoint
      // (L210) for the sender-key lookup, handled by the existing `?? null`
      // guard. buildForwardRequest / signForwardRequest / postForward never
      // touch client. Queue mode is not reached here (gated above), so
      // enqueueForward's client-dependent INSERT is never called with null.
      return await forwardEnvelope(envelope, route, options, null);
    } catch (error) {
      // Covers: reject codes from decideRoute (PEER_NOT_PINNED,
      // RECIPIENT_NOT_LOCAL, etc.), REPLAY_DETECTED from the replay check above,
      // and FORWARD_MISCONFIGURED from forwardEnvelope. FORWARD_TRANSPORT_FAILED
      // is caught inside forwardEnvelope and returned as {status:504} before
      // reaching here.
      //
      // REPLAY_DETECTED is in AUDITED_REJECTION_CODES, so this catch mirrors the
      // Phase 2 withTransaction .catch: an attributable replay rejection on the
      // sync forward path must still emit its envelope.rejected.replay_detected
      // audit event, exactly as the local and queue paths do.
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
    }
  }

  // ── Phase 2: queue-forward OR local accept ───────────────────────────────
  // Both paths need a transaction: queue-forward for atomicity of the outbox
  // INSERT + audit; local for replay/idempotency/persist serialisation.
  // route is already decided above -- withTransaction never calls decideRoute.
  return repository.withTransaction(async (client) => {
    // Replay check (design §6, §18 #13): must be serialised with
    // persistAcceptedEnvelope / enqueueFederationForward. A prior accepted
    // record under a *different* idempotency_key is a replay -- classified and
    // rejected immediately, skipping expiry entirely. Same idempotency_key
    // falls through to the ordinary duplicate path (lookupIdempotency below).
    const priorMessage = await repository.lookupAcceptedMessageId(envelope.sender.endpoint_id, envelope.message_id, client);
    if (priorMessage && priorMessage.idempotency_key !== envelope.idempotency_key) {
      throw reject('REPLAY_DETECTED', 'message_id was already accepted under a different idempotency_key');
    }

    // Queue-forward: enqueueForward's INSERT + audit are atomic inside this txn.
    if (route.action === 'forward') {
      return forwardEnvelope(envelope, route, options, client);
    }

    // route.action === 'local' -> fall through to recipient/capability/persist checks.
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

// Origin-side forward of a foreign-domain envelope to its pinned peer relay
// (design: inter-relay routing). `sync` mode only in this task: the forward
// happens inside the accept transaction but writes nothing to local
// envelopes/deliveries -- it returns before persistAcceptedEnvelope is
// reached, so the transaction commits with no rows. Queue mode is Task 14.
async function forwardEnvelope(envelope, route, options, client) {
  const { repository } = options;
  const registered = options.registered ?? new Map();
  // The repository fallback is gated on a real transaction client. On the
  // Phase 1 sync-forward path `client` is null, and
  // postgres-repository.lookupRecipientEndpoint hard-throws a bare Error
  // ("Recipient lookup requires a transaction client") when called without
  // one -- it deliberately has no `client = this.pool` default because it
  // takes a row lock. With the fallback skipped, an unresolvable sender
  // falls to the FORWARD_MISCONFIGURED reject below instead, matching the
  // queue/local paths' behaviour for the same condition.
  const senderEntry = registered.get(envelope.sender.endpoint_id)
    ?? (client && repository.lookupRecipientEndpoint
          ? await repository.lookupRecipientEndpoint(envelope.sender.endpoint_id, client)
          : null);
  const senderOwnerId = senderEntry?.owner_id;
  const senderPub = senderEntry?.public_key;
  if (!senderOwnerId || !senderPub) throw reject('FORWARD_MISCONFIGURED', 'Authenticated local sender has no registered owner or key');
  const senderKey = {
    kid: envelope.signature.key_id,
    alg: 'Ed25519',
    publicKey: (senderPub.export ? senderPub.export({ type: 'spki', format: 'der' }) : senderPub).toString('base64url'),
  };
  const { canonicalBytes } = buildForwardRequest(envelope, { originDomain: options.relayDomain, senderKey, senderOwnerId, now: options.now ?? new Date() });
  const signed = signForwardRequest(canonicalBytes, options.federationIdentity);

  if (options.federationMode === 'queue') {
    return enqueueForward(envelope, route, options, client, { senderKey, senderOwnerId }); // Task 14
  }

  // sync
  let outcome;
  try { outcome = await (options.postForwardImpl ?? postForward)(route.peer, canonicalBytes, signed, { fetchImpl: options.fetchImpl }); }
  catch (error) {
    if (error.code === 'FORWARD_TRANSPORT_FAILED') {
      await recordFederationAudit(repository, 'federation.forward_unavailable', 'rejected', envelope, { recipient_domain: route.recipientDomain }, options.now);
      return { status: 504, body: { request_id: options.request_id ?? null, code: 'FORWARD_UNAVAILABLE', message: 'Peer relay unreachable', details: { recipientDomain: route.recipientDomain } } };
    }
    throw error;
  }
  if (outcome.ok) {
    await recordFederationAudit(repository, 'federation.forwarded', 'forwarded', envelope, { recipient_domain: route.recipientDomain }, options.now);
    return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', forwarded: true, forwarded_to: route.recipientDomain } };
  }
  await recordFederationAudit(repository, 'federation.forward_rejected', 'rejected', envelope, { recipient_domain: route.recipientDomain, peer_code: outcome.peerCode ?? null }, options.now);
  return { status: 502, body: { request_id: options.request_id ?? null, code: 'FORWARD_REJECTED', message: 'Peer relay rejected the forward', details: { peerStatus: outcome.status, peerCode: outcome.peerCode ?? null } } };
}

// Queue-mode federation forward: enqueue to federation_outbox for asynchronous
// delivery by a reaper process instead of forwarding synchronously (Task 14).
async function enqueueForward(envelope, route, options, client, { senderKey, senderOwnerId }) {
  const { repository } = options;
  const { row, inserted } = await repository.enqueueFederationForward({
    messageId: envelope.message_id, idempotencyKey: envelope.idempotency_key,
    recipientDomain: route.recipientDomain, originDomain: options.relayDomain,
    envelope, senderKey, senderOwnerId, now: options.now ?? new Date(),
  }, client);
  await recordFederationAudit(repository, 'federation.queued', 'accepted', envelope, { recipient_domain: route.recipientDomain }, options.now);
  return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', queued: true, duplicate: !inserted } };
}

// `outcome` is passed explicitly by each call site (mirroring federation-reaper.mjs):
// the queue-enqueue path is a success ('accepted'); the forward path is
// 'forwarded' on 2xx and 'rejected' on a peer reject / transport failure. The
// old `eventType.endsWith('forwarded')` heuristic mislabelled `federation.queued`
// (a success) as 'rejected'.
function recordFederationAudit(repository, eventType, outcome, envelope, payload, now) {
  if (!repository.recordAuditEvent) return Promise.resolve();
  return repository.recordAuditEvent({ eventType, subjectId: envelope.message_id, endpointId: envelope.sender?.endpoint_id, outcome, reason: null, payload, now }).catch(() => {});
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
