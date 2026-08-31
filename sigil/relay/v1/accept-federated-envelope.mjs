import crypto from 'node:crypto';
import { parseDomain, parseFederatedId } from './federated-id.mjs';
import { verifyRelaySignature } from './federation-router.mjs';
import { validateEnvelope, signedBytes, reject } from './validate-envelope.mjs';
import { resolveRateLimits, DEFAULT_INBOX_DEPTH_LIMIT } from './relay-config.mjs';

function respond(status, code, message, options, details = {}) {
  return { status, body: { request_id: options.request_id ?? null, code, message, details } };
}

function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }

// POST /v1/federation/envelopes handler (design §"Receiving side"). Runs the
// checks in order; the first failure returns immediately.
export async function acceptFederatedEnvelope(body, headers, options) {
  const { repository } = options;

  // Checks 2-5 each return before the transactional body runs, so they emit
  // federation.inbound_rejected here rather than via the transaction's catch.
  // Check 1 has no reliable message_id (mirrors accept-envelope.mjs's
  // deliberate exclusion of pre-signature INVALID_ENVELOPE) and does not audit.
  const auditInboundReject = async (code) => {
    if (repository.recordAuditEvent) {
      await repository.recordAuditEvent({
        eventType: 'federation.inbound_rejected',
        subjectId: envelope?.message_id ?? null,
        endpointId: envelope?.sender?.endpoint_id ?? null,
        outcome: 'rejected',
        reason: code,
        payload: { origin_domain: originDomain },
        now: options.now ?? new Date(),
      }).catch(() => {});
    }
  };

  // --- Check 1: structural ---
  if (!body || typeof body !== 'object') return respond(400, 'INVALID_FEDERATION_REQUEST', 'Request body must be an object', options);
  const { origin_domain: originDomain, envelope, sender_key: senderKey, sender_owner_id: senderOwnerId } = body;
  try { parseDomain(originDomain); } catch { return respond(400, 'INVALID_FEDERATION_REQUEST', 'origin_domain is not a well-formed domain', options); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return respond(400, 'INVALID_FEDERATION_REQUEST', 'envelope must be an object', options);
  if (!senderKey || !isNonEmptyString(senderKey.kid) || senderKey.alg !== 'Ed25519' || !isNonEmptyString(senderKey.publicKey)) {
    return respond(400, 'INVALID_FEDERATION_REQUEST', 'sender_key must be { kid, alg: "Ed25519", publicKey }', options);
  }
  try { parseFederatedId(senderOwnerId); } catch { return respond(400, 'INVALID_FEDERATION_REQUEST', 'sender_owner_id is not a well-formed federated id', options); }

  // --- Check 2: origin pinned (receiver's own peer directory) ---
  const peer = await repository.getPeerByDomain(originDomain);
  if (!peer) { await auditInboundReject('PEER_NOT_TRUSTED'); return respond(403, 'PEER_NOT_TRUSTED', 'Origin domain is not pinned in this relay\'s peer directory', options, { origin_domain: originDomain }); }

  // --- Check 3: relay signature over the JCS body bytes ---
  const relaySignature = headers['sigil-relay-signature'];
  const relayKeyId = headers['sigil-relay-key-id'];
  if (!isNonEmptyString(relaySignature) || !isNonEmptyString(relayKeyId) || !verifyRelaySignature(body, { signature: relaySignature, keyId: relayKeyId, peer })) {
    await auditInboundReject('RELAY_SIGNATURE_INVALID');
    return respond(401, 'RELAY_SIGNATURE_INVALID', 'Sigil-Relay-Signature failed verification against the pinned peer key', options);
  }

  // --- Check 4: sender domain === origin_domain ---
  let senderDomain;
  try { senderDomain = parseFederatedId(envelope.sender?.endpoint_id).domain; }
  catch { await auditInboundReject('INVALID_FEDERATION_REQUEST'); return respond(400, 'INVALID_FEDERATION_REQUEST', 'envelope.sender.endpoint_id is not a well-formed federated id', options); }
  if (senderDomain.toLowerCase() !== originDomain.toLowerCase()) {
    await auditInboundReject('SENDER_DOMAIN_FOREIGN');
    return respond(403, 'SENDER_DOMAIN_FOREIGN', 'envelope.sender domain does not equal origin_domain', options, { sender_domain: senderDomain, origin_domain: originDomain });
  }

  // --- Check 5: envelope signature against the propagated sender key ---
  let ok = false;
  try {
    const senderPub = crypto.createPublicKey({ key: Buffer.from(senderKey.publicKey, 'base64url'), format: 'der', type: 'spki' });
    const sig = Buffer.from(envelope.signature?.value ?? '', 'base64url');
    ok = sig.length > 0 && crypto.verify(null, signedBytes(envelope), senderPub, sig);
  } catch { ok = false; }
  if (!ok) { await auditInboundReject('INVALID_SIGNATURE'); return respond(401, 'INVALID_SIGNATURE', 'Envelope signature verification failed against sender_key', options); }

  // --- Checks 6-10: validate, same-owner exemption, deliver ---
  const { registered, relayDomain, now = new Date() } = options;

  const auditReject = async (status, code, message, details = {}) => {
    if (repository.recordAuditEvent) {
      await repository.recordAuditEvent({ eventType: 'federation.inbound_rejected', subjectId: envelope.message_id, endpointId: envelope.sender?.endpoint_id, outcome: 'rejected', reason: code, payload: { origin_domain: originDomain }, now }).catch(() => {});
    }
    return respond(status, code, message, options, details);
  };

  return repository.withTransaction(async (client) => {
    // 10 (first): idempotent-duplicate lookup, before any re-verification.
    const priorIdem = await repository.lookupIdempotency(envelope.sender.endpoint_id, envelope.idempotency_key, client);
    if (priorIdem) {
      return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: priorIdem.message_id, duplicate: true } };
    }
    // 6 (replay): same message_id under a different idempotency_key.
    const priorMsg = await repository.lookupAcceptedMessageId(envelope.sender.endpoint_id, envelope.message_id, client);
    if (priorMsg && priorMsg.idempotency_key !== envelope.idempotency_key) {
      throw reject('REPLAY_DETECTED', 'message_id was already accepted under a different idempotency_key');
    }
    // 6 (trimmed validation): synthetic single-entry registry for the sender.
    const syntheticRegistered = new Map([[envelope.sender.endpoint_id, {
      endpoint_id: envelope.sender.endpoint_id, owner_id: envelope.sender.owner_id,
      key_id: envelope.signature.key_id, status: 'active',
      public_key: crypto.createPublicKey({ key: Buffer.from(senderKey.publicKey, 'base64url'), format: 'der', type: 'spki' }),
    }]]);
    const result = validateEnvelope(envelope, { now, registered: syntheticRegistered, idempotency: new Map(), relayDomain, skipSenderRegistration: true });
    // 6 (owner-assertion consistency): sender's own claim must agree.
    if (envelope.sender.owner_id !== senderOwnerId) {
      throw reject('SENDER_OWNER_ASSERTION_MISMATCH', 'envelope.sender.owner_id does not equal the relay-asserted sender_owner_id');
    }
    // 7: recipient exists and is active in the receiver's registry.
    const recipientId = envelope.recipient.endpoint_id;
    const recipient = (await repository.lookupRecipientEndpoint(recipientId, client)) ?? registered?.get(recipientId);
    // R11: both repos active-filter before returning a row, so a returned row
    // is already active; only the `registered` fallback carries a `status`
    // field that can be explicitly non-active. Reject on an explicit
    // non-active status only, never on an absent one.
    if (!recipient || (recipient.status !== undefined && recipient.status !== 'active')) {
      throw reject('RECIPIENT_NOT_FOUND', 'The recipient endpoint does not exist in this relay\'s registry.', { recipient_id: recipientId });
    }
    // 8: directory gate — same-owner exemption only.
    if (senderOwnerId !== recipient.owner_id) {
      throw reject('DIRECTORY_LINK_REQUIRED', 'No cross-owner directory link; federated first contact is out of scope', { sender_owner_id: senderOwnerId, recipient_endpoint_id: recipientId });
    }
    // 9: rate reservations (verified federated sender id) + federation_origin + inbox depth.
    const limits = resolveRateLimits(options.rateLimits);
    const windowStart = new Date(Math.floor((now instanceof Date ? now.getTime() : Date.parse(now)) / 60_000) * 60_000).toISOString();
    for (const [scopeKind, scopeId] of [
      ['endpoint', envelope.sender.endpoint_id],
      ['owner', senderOwnerId],
      ['conversation', envelope.conversation_id],
      ['federation_origin', originDomain],
    ]) {
      const reservation = await repository.reserveRateLimit(scopeKind, scopeId, windowStart, limits[scopeKind] ?? limits.endpoint, client);
      if (!reservation.allowed) throw reject('RATE_LIMITED', `${scopeKind} rate limit exceeded`, { scope_kind: scopeKind, scope_id: scopeId });
    }
    const depthLimit = options.inboxDepthLimit ?? DEFAULT_INBOX_DEPTH_LIMIT;
    if ((await repository.countOpenDeliveries(recipientId, client)) >= depthLimit) {
      throw reject('QUOTA_EXCEEDED', 'Recipient inbox depth limit reached', { recipient_endpoint_id: recipientId, limit: depthLimit });
    }
    // R10: shadow-register the foreign sender so the accepted envelope's FK
    // chain (conversations.created_by, conversation_members, envelopes.sender_*)
    // resolves on the Postgres path. Placed after every rejecting check so a
    // rejected envelope never shadow-registers its sender.
    await repository.registerFederatedSender({
      endpoint_id: envelope.sender.endpoint_id,
      owner_id: senderOwnerId,
      key_id: envelope.signature.key_id,
      public_key: Buffer.from(senderKey.publicKey, 'base64url'),
      origin_domain: originDomain,
    }, client);
    // 10: persist + deliver through the existing local path, federation_hop = true.
    const persisted = await repository.persistAcceptedEnvelope({ envelope, ...result, canonical_bytes: signedBytes(envelope), action_hash: result.canonical_hash, federation_hop: true }, client);
    if (repository.recordAuditEvent) {
      await repository.recordAuditEvent({ eventType: 'federation.inbound_accepted', subjectId: persisted?.message_id ?? result.message_id, endpointId: recipientId, outcome: 'accepted', reason: null, payload: { origin_domain: originDomain, recipient_domain: relayDomain }, now });
    }
    if (options.onPersisted) await options.onPersisted({ envelope, persisted });
    return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED', message_id: persisted?.message_id ?? result.message_id, duplicate: persisted?.duplicate ?? false } };
  }).catch(async (error) => {
    const status = { REPLAY_DETECTED: 409, MESSAGE_EXPIRED: 422, RECIPIENT_NOT_FOUND: 400, DIRECTORY_LINK_REQUIRED: 403, SENDER_OWNER_ASSERTION_MISMATCH: 403, RATE_LIMITED: 429, QUOTA_EXCEEDED: 429, INVALID_ENVELOPE: 400, INVALID_SIGNATURE: 401, VERSION_UNSUPPORTED: 400, CAPABILITY_DENIED: 403 }[error.code] ?? 400;
    return auditReject(status, error.code ?? 'INVALID_FEDERATION_REQUEST', error.message, error.details ?? {});
  });
}
