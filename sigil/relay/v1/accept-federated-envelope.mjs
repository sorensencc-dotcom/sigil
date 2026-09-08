import crypto from 'node:crypto';
import { parseFederatedId } from './federated-id.mjs';
import { verifyInboundRelayRequest } from './federation-relay-auth.mjs';
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

  // --- Checks 1-3: structural parse + peer resolution by signing kid + relay
  // signature. Delegated to the shared inbound relay-auth verifier: the acting
  // peer is resolved from WHICH pinned key signed the request (never a body
  // field), and the signature is checked over bytes re-canonicalized from the
  // same raw source the sender signed.
  let originDomain, peer, parsedBody, envelope, senderKey, senderOwnerId;
  try {
    ({ originDomain, peerRecord: peer, parsedBody } = await verifyInboundRelayRequest(
      options.rawBody ?? Buffer.from(JSON.stringify(body)),
      headers,
      { getPeerByKid: (kid) => repository.getPeerByKid(kid) },
    ));
    ({ envelope, sender_key: senderKey, sender_owner_id: senderOwnerId } = parsedBody);
  } catch (error) {
    const code = error.code ?? 'INVALID_FEDERATION_REQUEST';
    // Parity with #3: PEER_NOT_TRUSTED / RELAY_SIGNATURE_INVALID audit here;
    // a pre-signature parse failure (INVALID_FEDERATION_REQUEST) does not.
    if (code !== 'INVALID_FEDERATION_REQUEST') await auditInboundReject(code);
    return respond(error.httpStatus ?? 400, code, error.message, options);
  }

  // Self-federation guard (unchanged from #3, re-sequenced after the verifier):
  // a peer must never assert this relay's own domain as the body origin_domain.
  // Compare is case-insensitive (federated-id rule); port is significant.
  if (isNonEmptyString(options.relayDomain) && String(parsedBody.origin_domain).toLowerCase() === options.relayDomain.toLowerCase()) {
    return respond(400, 'INVALID_FEDERATION_REQUEST', 'origin_domain equals this relay\'s own domain (self-federation is not allowed)', options, { origin_domain: parsedBody.origin_domain });
  }

  // Body/origin consistency (new in #4): the body's declared origin_domain must
  // equal the domain the signing relay key is pinned under. A disagreement
  // means the caller is not the peer the body claims -> PEER_NOT_TRUSTED.
  if (!parsedBody.origin_domain || String(parsedBody.origin_domain).toLowerCase() !== originDomain.toLowerCase()) {
    await auditInboundReject('PEER_NOT_TRUSTED');
    return respond(403, 'PEER_NOT_TRUSTED', 'Body origin_domain does not match the pinned domain of the signing relay key', options, { origin_domain: parsedBody.origin_domain ?? null, signing_domain: originDomain });
  }

  // --- Structural checks on the parsed body (unchanged from #3, re-sequenced) ---
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return respond(400, 'INVALID_FEDERATION_REQUEST', 'envelope must be an object', options);
  if (!senderKey || !isNonEmptyString(senderKey.kid) || senderKey.alg !== 'Ed25519' || !isNonEmptyString(senderKey.publicKey)) {
    return respond(400, 'INVALID_FEDERATION_REQUEST', 'sender_key must be { kid, alg: "Ed25519", publicKey }', options);
  }
  try { parseFederatedId(senderOwnerId); } catch { return respond(400, 'INVALID_FEDERATION_REQUEST', 'sender_owner_id is not a well-formed federated id', options); }

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
    // 8: directory gate (design Section 1 — the same-owner exemption is
    // removed; a self-pair link authorises same-owner cross-federation
    // delivery). sender_owner_id stays informational and is NOT domain-pinned:
    // #3's --federation-owner deliberately lets one owner id live on two
    // relays under a domain that differs from the relay domain.
    const link = typeof repository.getActiveFederationDirectoryLink === 'function'
      ? await repository.getActiveFederationDirectoryLink(recipient.owner_id, senderOwnerId, originDomain, client)
      : null;
    if (!link) {
      throw reject('DIRECTORY_LINK_REQUIRED', 'No active cross-federation directory link authorises this delivery', {
        sender_owner_id: senderOwnerId,
        recipient_endpoint_id: recipientId,
        reason: 'no_active_federation_directory_link',
      });
    }
    // link.status === 'active' — deliver.
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
    // Only codes we recognise pass through as the response `code`. A raw
    // driver error (23503 / 23514 / 23502, etc.) is not a protocol enum
    // value and must never be echoed to the peer -- collapse anything
    // unrecognised to INVALID_FEDERATION_REQUEST / 400.
    const statusByCode = { REPLAY_DETECTED: 409, MESSAGE_EXPIRED: 422, RECIPIENT_NOT_FOUND: 400, DIRECTORY_LINK_REQUIRED: 403, SENDER_OWNER_ASSERTION_MISMATCH: 403, RATE_LIMITED: 429, QUOTA_EXCEEDED: 429, INVALID_ENVELOPE: 400, INVALID_SIGNATURE: 401, VERSION_UNSUPPORTED: 400, CAPABILITY_DENIED: 403 };
    const known = Object.prototype.hasOwnProperty.call(statusByCode, error.code);
    const code = known ? error.code : 'INVALID_FEDERATION_REQUEST';
    const status = known ? statusByCode[error.code] : 400;
    return auditReject(status, code, known ? error.message : 'Federated envelope could not be accepted', error.details ?? {});
  });
}
