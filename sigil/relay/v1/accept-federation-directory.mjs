import crypto from 'node:crypto';
import { parseDomain, parseFederatedId } from './federated-id.mjs';
import { resolveRateLimits } from './relay-config.mjs';

// Failure envelope shared with the /v1/federation/directory/redemptions route
// (Task 10). Success / idempotent-replay returns a FLAT body instead
// (`acceptedBody` below) so the route can serialize it verbatim.
export function respond(status, code, message, ctx, details = {}) {
  return { status, body: { request_id: ctx?.request_id ?? null, code, message, details } };
}

function acceptedBody(status, ctx, body) {
  return { status, body: { request_id: ctx?.request_id ?? null, ...body } };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

function constantTimeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// POST /v1/federation/directory/redemptions handler. Runs on the caller's
// client / transaction, mirrors acceptFederatedEnvelope's fail-fast shape:
// the first failing check returns immediately. Unknown / expired / revoked /
// redeemed-by-another / secret-hash-mismatch / peer-domain-mismatch all
// collapse to one generic INVALID_FEDERATION_INVITE so a caller cannot use
// the response as an oracle. 409 is reserved for a genuine owner-pair
// collision, and the invite is left `pending` in that branch.
export async function acceptDirectoryRedemption(parsedBody, ctx) {
  const { repository, client, originDomain, now, relayDomain } = ctx;
  const audit = (eventType, reason, extra = {}) => {
    const p = repository.recordAuditEvent?.({
      eventType,
      outcome: reason ? 'rejected' : 'accepted',
      reason: reason ?? null,
      payload: { peer_domain: originDomain, link_ref: parsedBody?.link_ref ?? null, ...extra },
      now,
    });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  };

  // 1. Structural parse of the redemption code and redeemer ids.
  const code = parsedBody?.code;
  if (typeof code !== 'string') return respond(400, 'INVALID_FEDERATION_REQUEST', 'code is required', ctx);
  const parts = code.split(':');
  if (parts.length !== 4 || parts[0] !== 'sigil-fed-invite') {
    return respond(400, 'INVALID_FEDERATION_REQUEST', 'code is not sigil-fed-invite:<domain>:<link-ref>:<segment>', ctx);
  }
  const [, issuerDomain, embeddedRef, segment] = parts;
  try { parseDomain(issuerDomain); } catch { return respond(400, 'INVALID_FEDERATION_REQUEST', 'issuer domain in code is malformed', ctx); }
  if (!relayDomain || issuerDomain.toLowerCase() !== String(relayDomain).toLowerCase()) {
    return respond(400, 'INVALID_FEDERATION_REQUEST', 'code issuer domain does not name this relay', ctx);
  }
  if (!UUID_RE.test(embeddedRef) || embeddedRef !== parsedBody.link_ref) {
    return respond(400, 'INVALID_FEDERATION_REQUEST', 'link_ref mismatch between code and body', ctx);
  }
  const redeemer = parsedBody.redeemer;
  if (!redeemer || typeof redeemer !== 'object') {
    return respond(400, 'INVALID_FEDERATION_REQUEST', 'redeemer is required', ctx);
  }
  try {
    if (parseFederatedId(redeemer.owner_id).domain.toLowerCase() !== String(originDomain).toLowerCase()) {
      throw new Error('owner domain');
    }
    if (parseFederatedId(redeemer.endpoint_id).domain.toLowerCase() !== String(originDomain).toLowerCase()) {
      throw new Error('endpoint domain');
    }
  } catch {
    return respond(400, 'INVALID_FEDERATION_REQUEST', 'redeemer ids are malformed or not on the posting domain', ctx);
  }
  try { parseDomain(parsedBody.redeemer_domain); } catch { return respond(400, 'INVALID_FEDERATION_REQUEST', 'redeemer_domain is malformed', ctx); }
  if (String(parsedBody.redeemer_domain).toLowerCase() !== String(originDomain).toLowerCase()) {
    return respond(400, 'INVALID_FEDERATION_REQUEST', 'redeemer_domain does not equal the verified posting relay', ctx);
  }

  // (rate) Load-bearing anti-guessing scope, keyed per posting peer domain.
  if (typeof repository.reserveRateLimit === 'function') {
    const ms = now instanceof Date ? now.getTime() : Date.parse(now);
    const windowStart = new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
    const limit = ctx.rateLimits?.federation_directory_redemption_inbound ?? resolveRateLimits().federation_directory_redemption_inbound;
    const r = await repository.reserveRateLimit('federation_directory_redemption_inbound', originDomain, windowStart, limit, client);
    if (r && r.allowed === false) {
      return respond(429, 'RATE_LIMITED', 'redemption rate limit for this peer domain exceeded', ctx, { scope_kind: 'federation_directory_redemption_inbound' });
    }
  }

  // 2. Invite lookup + constant-time secret-hash compare. Lazy pending -> expired
  //    transition happens inside getFederationDirectoryInviteByRef.
  const invite = await repository.getFederationDirectoryInviteByRef(parsedBody.link_ref, client, { forUpdate: true });
  const genericInvalid = () => {
    audit('federation_directory.redemption_rejected', 'INVALID_FEDERATION_INVITE');
    return respond(403, 'INVALID_FEDERATION_INVITE', 'Redemption code is not valid', ctx);
  };
  if (!invite) return genericInvalid();
  if (!constantTimeEqualHex(sha256Hex(segment), invite.code_hash)) return genericInvalid();

  // 3. Peer-domain match (invite was minted for exactly one peer domain).
  if (String(invite.peer_domain).toLowerCase() !== String(originDomain).toLowerCase()) return genericInvalid();

  // 4. Idempotent replay for an already-'redeemed' invite by the same redeemer.
  if (invite.status === 'redeemed') {
    if (invite.redeemed_by_owner_id === redeemer.owner_id && invite.redeemed_by_endpoint_id === redeemer.endpoint_id) {
      return acceptedBody(202, ctx, {
        link_ref: parsedBody.link_ref,
        issuer: { owner_id: invite.issuer_owner_id, endpoint_id: invite.issuer_endpoint_id },
      });
    }
    return genericInvalid();
  }
  if (invite.status !== 'pending') return genericInvalid(); // expired / revoked

  // 5. Owner-pair collision under a DIFFERENT link_ref. Detected BEFORE
  //    markRedeemed so the invite stays `pending` on a collision (spec step 5).
  const livePair = await repository.findLiveFederationDirectoryLinkForPair?.(
    invite.issuer_owner_id, redeemer.owner_id, originDomain, client,
  );
  if (livePair && livePair.link_ref !== parsedBody.link_ref) {
    audit('federation_directory.redemption_rejected', 'FEDERATION_LINK_EXISTS');
    return respond(409, 'FEDERATION_LINK_EXISTS', 'A federation directory link already exists for this owner pair', ctx, { existing_link_ref: livePair.link_ref });
  }

  // 6. Write: mark invite redeemed + create the issuer-side link, one transaction.
  await repository.markFederationDirectoryInviteRedeemed(invite.invite_id, redeemer, now, client);
  let link;
  try {
    link = await repository.createFederationDirectoryLink({
      linkRef: parsedBody.link_ref,
      localOwnerId: invite.issuer_owner_id,
      localEndpointId: invite.issuer_endpoint_id,
      remoteOwnerId: redeemer.owner_id,
      remoteEndpointId: redeemer.endpoint_id,
      remoteDomain: originDomain,
      role: 'issuer',
      initiatedVia: invite.issuer_owner_id === redeemer.owner_id ? 'self_pair' : 'invite',
      status: 'pending',
      localConfirmedAt: null,
      remoteConfirmedAt: now,
      sourceInviteId: invite.invite_id,
      peerDomain: originDomain,
    }, client);
  } catch (error) {
    // Defence-in-depth for a concurrent insert that races past step 5's probe.
    if (error && error.code === 'FEDERATION_LINK_EXISTS') {
      audit('federation_directory.redemption_rejected', 'FEDERATION_LINK_EXISTS');
      return respond(409, 'FEDERATION_LINK_EXISTS', 'A federation directory link already exists for this owner pair', ctx, { existing_link_ref: error.existingLinkRef ?? null });
    }
    throw error;
  }

  audit('federation_directory.redemption_accepted', null);
  audit('federation_directory.link_created', null, { role: 'issuer' });
  return acceptedBody(202, ctx, {
    link_ref: link?.link_ref ?? parsedBody.link_ref,
    issuer: { owner_id: invite.issuer_owner_id, endpoint_id: invite.issuer_endpoint_id },
  });
}

function isoString(v) { return typeof v === 'string' && !Number.isNaN(Date.parse(v)); }

function fdlAudit(repository, originDomain, linkRef, now) {
  return (eventType, extra = {}) => {
    const p = repository.recordAuditEvent?.({
      eventType,
      outcome: 'accepted',
      reason: null,
      payload: { peer_domain: originDomain, link_ref: linkRef ?? null, ...extra },
      now,
    });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  };
}

// POST /v1/federation/directory/confirmations handler. The peer relay tells us
// it has recorded its own side of the link; we set `remote_confirmed_at` and,
// if our side is already set, flip the row to `active`. Revocation always wins:
// a revoked / expired row is a 202 no-op that never reactivates. 202 bodies are
// FLAT (`acceptedBody`); only the 400 / 403 / 404 error returns use `respond`.
export async function acceptDirectoryConfirmation(parsedBody, ctx) {
  const { repository, client, originDomain, now } = ctx;
  const audit = fdlAudit(repository, originDomain, parsedBody?.link_ref, now);

  // 1. Structural.
  if (!UUID_RE.test(parsedBody?.link_ref ?? '') || !isoString(parsedBody?.signed_at)) {
    return respond(400, 'INVALID_FEDERATION_REQUEST', 'link_ref must be a uuid and signed_at an ISO timestamp', ctx);
  }
  // 2. Link lookup (FOR UPDATE) + peer_domain pin.
  const link = await repository.getFederationDirectoryLinkByRef(parsedBody.link_ref, client, { forUpdate: true });
  if (!link) return respond(404, 'FEDERATION_LINK_NOT_FOUND', 'No local link row for this link_ref', ctx);
  if (String(link.peer_domain).toLowerCase() !== String(originDomain).toLowerCase()) {
    return respond(403, 'PEER_NOT_TRUSTED', 'Posting relay is not the peer named by this link', ctx);
  }
  // 3. Terminal / idempotent (revocation wins).
  if (link.status === 'revoked' || link.status === 'expired') {
    return acceptedBody(202, ctx, { link_ref: parsedBody.link_ref, outcome: 'noop' });
  }
  if (link.remote_confirmed_at && (link.status === 'pending' || link.status === 'active')) {
    return acceptedBody(202, ctx, { link_ref: parsedBody.link_ref, outcome: 'noop' });
  }
  // 4. Write (compare-and-set). A zero update means a concurrent revocation
  //    flipped status; treat it as a step-3 no-op (no audit event).
  const { updated, activated } = await repository.setFederationDirectoryLinkConfirmation(parsedBody.link_ref, 'remote', now, client);
  if (updated) {
    audit('federation_directory.confirmation_accepted', { side: 'remote' });
    if (activated) audit('federation_directory.link_activated');
  }
  return acceptedBody(202, ctx, { link_ref: parsedBody.link_ref, outcome: updated ? 'confirmed' : 'noop' });
}

// POST /v1/federation/directory/revocations handler. An unknown link_ref is a
// 202 no-op (no existence leak); a `peer_domain` mismatch is 403; a repeat on an
// already-revoked row is an idempotent 202. Audit fires only on a real update.
export async function acceptDirectoryRevocation(parsedBody, ctx) {
  const { repository, client, originDomain, now } = ctx;

  if (!UUID_RE.test(parsedBody?.link_ref ?? '') || !isoString(parsedBody?.signed_at)) {
    return respond(400, 'INVALID_FEDERATION_REQUEST', 'link_ref must be a uuid and signed_at an ISO timestamp', ctx);
  }
  const link = await repository.getFederationDirectoryLinkByRef(parsedBody.link_ref, client, { forUpdate: true });
  if (!link) return acceptedBody(202, ctx, { link_ref: parsedBody.link_ref, outcome: 'noop' }); // no existence leak
  if (String(link.peer_domain).toLowerCase() !== String(originDomain).toLowerCase()) {
    return respond(403, 'PEER_NOT_TRUSTED', 'Posting relay is not the peer named by this link', ctx);
  }
  if (link.status === 'revoked') {
    return acceptedBody(202, ctx, { link_ref: parsedBody.link_ref, outcome: 'noop' });
  }
  const { updated } = await repository.revokeFederationDirectoryLink(parsedBody.link_ref, 'remote', now, client);
  if (updated) {
    fdlAudit(repository, originDomain, parsedBody.link_ref, now)('federation_directory.revocation_accepted', { revoked_by: 'remote' });
  }
  return acceptedBody(202, ctx, { link_ref: parsedBody.link_ref, outcome: updated ? 'revoked' : 'noop' });
}
