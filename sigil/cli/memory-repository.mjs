// In-memory stand-in for the PostgreSQL repository the relay expects
// (see relay/v1/postgres-repository.mjs). Enough of the interface to run
// a real local relay for a demo or single-machine session. State lives
// only in this process -- restarting `sigil relay up` loses history.
import crypto from 'node:crypto';
import { transitionDelivery } from '../relay/v1/delivery-state.mjs';
import { boundedDirectoryExpiry } from '../relay/v1/auth-policy.mjs';

const SEEDED_CAPABILITIES = new Map([
  ['sigil.core/read_shared_context', { namespace: 'sigil.core', risk_tier: 'standard' }],
  ['sigil.core/broadcast_message', { namespace: 'sigil.core', risk_tier: 'standard' }],
  ['sigil.task/submit', { namespace: 'sigil.task', risk_tier: 'standard' }],
  ['sigil.task/read_inbox', { namespace: 'sigil.task', risk_tier: 'low' }],
  ['sigil.task/read_result', { namespace: 'sigil.task', risk_tier: 'low' }],
  ['sigil.task/process', { namespace: 'sigil.task', risk_tier: 'standard' }],
  ['sigil.task/submit_result', { namespace: 'sigil.task', risk_tier: 'standard' }],
  ['sigil.approval/request', { namespace: 'sigil.approval', risk_tier: 'high' }],
]);

export function createMemoryRepository() {
  const envelopes = new Map();
  const deliveries = new Map();
  const idempotency = new Map();
  const grants = [];
  const rateWindows = new Map();
  const acknowledgements = new Map();
  const directoryInvites = new Map(); // code -> invite row (memory repo has no separate hash step -- single process, nothing to hide from itself)
  const directoryLinks = new Map();
  const directoryMatchRequests = new Map();
  const humanSessions = new Map();
  const consumedLoginJtis = new Map();
  const oidcIssuerAllowlist = new Map();
  const auditEvents = [];
  return {
    // Single-process, no real client/connection -- the transaction wrapper
    // exists so acceptEnvelopeAsync's repository-aware path works unchanged
    // against this repository too (design §12 dual-repository equivalence).
    async withTransaction(fn) { return fn(null); },
    async reserveRateLimit(scopeKind, scopeId, windowStart, limit) {
      const key = `${scopeKind}:${scopeId}:${windowStart}`;
      const count = (rateWindows.get(key) ?? 0) + 1;
      rateWindows.set(key, count);
      return { count, allowed: count <= limit };
    },
    async countOpenDeliveries(recipientEndpointId) {
      const terminal = new Set(['acknowledged', 'processed', 'delivery_rejected', 'dead_letter']);
      return [...deliveries.values()].filter((d) => d.recipient_endpoint_id === recipientEndpointId && !terminal.has(d.state)).length;
    },
    async lookupIdempotency(endpointId, idempotencyKey) {
      return idempotency.get(`${endpointId}:${idempotencyKey}`) ?? null;
    },
    async lookupTaskRequest(taskId, conversationId) {
      for (const row of envelopes.values()) {
        if (row.envelope.conversation_id === conversationId && row.envelope.message_type === 'task.request' && row.envelope.body?.task_id === taskId) {
          return { message_id: row.envelope.message_id };
        }
      }
      return null;
    },
    async lookupAcceptedMessageId(senderEndpointId, messageId) {
      for (const row of envelopes.values()) {
        if (row.envelope.sender.endpoint_id === senderEndpointId && row.envelope.message_id === messageId) {
          return { message_id: row.envelope.message_id, idempotency_key: row.envelope.idempotency_key };
        }
      }
      return null;
    },
    async persistAcceptedEnvelope(row) {
      envelopes.set(row.message_id, row);
      idempotency.set(`${row.envelope.sender.endpoint_id}:${row.envelope.idempotency_key}`, { message_id: row.message_id, canonical_hash: row.canonical_hash });
      if (row.envelope.recipient?.endpoint_id) {
        const deliveryId = `del_${row.message_id}`;
        deliveries.set(deliveryId, {
          delivery_id: deliveryId,
          message_id: row.message_id,
          recipient_endpoint_id: row.envelope.recipient.endpoint_id,
          state: 'delivered',
          queued_at: new Date().toISOString(),
          attempts: 0
        });
      }
      return { message_id: row.message_id, duplicate: false };
    },
    async listInbox(endpointId, since = '', viewerOwnerId = null) {
      return [...deliveries.values()]
        .filter((d) => d.recipient_endpoint_id === endpointId && d.state === 'delivered' && d.queued_at > since)
        .map((d) => { const envelope = envelopes.get(d.message_id).envelope; return { delivery_id: d.delivery_id, message_id: d.message_id, envelope, queued_at: d.queued_at, sender_unverified: !viewerOwnerId || !acknowledgements.has(`${viewerOwnerId}:${envelope.sender.endpoint_id}`) }; });
    },
    async acknowledgeEndpoint({ viewerOwnerId, acknowledgedEndpointId, now = new Date() }) {
      const record = { viewer_owner_id: viewerOwnerId, acknowledged_endpoint_id: acknowledgedEndpointId, acknowledged_at: (now instanceof Date ? now : new Date(now)).toISOString() };
      acknowledgements.set(`${viewerOwnerId}:${acknowledgedEndpointId}`, record);
      return record;
    },
    async createDirectoryInvite({ issuerEndpointId, issuerHumanId, expiresAt, homeRelay, now = new Date() }) {
      const inviteId = `invite_${crypto.randomUUID()}`;
      const code = crypto.randomBytes(24).toString('base64url');
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const expiry = boundedDirectoryExpiry({ now, expiresAt });
      directoryInvites.set(code, { invite_id: inviteId, issuer_endpoint_id: issuerEndpointId, issuer_human_id: issuerHumanId, status: 'pending', expires_at: expiry.toISOString(), home_relay: homeRelay, created_at: timestamp });
      return { invite_id: inviteId, code, expires_at: expiry.toISOString() };
    },
    async redeemDirectoryInvite({ code, redeemerEndpointId, redeemerHumanId, homeRelay, now = new Date() }) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const invite = directoryInvites.get(code);
      if (!invite || invite.status !== 'pending' || invite.expires_at <= timestamp) {
        throw Object.assign(new Error('Invite code is invalid or expired'), { code: 'INVITE_UNAVAILABLE' });
      }
      // Mirrors postgres-repository.mjs's human_a <> human_b guard (backed
      // there by directory_links' CHECK constraint): a human can't link to
      // their own other endpoint via their own invite. Checked before the
      // invite is marked redeemed, same as the Postgres path.
      if (invite.issuer_human_id === redeemerHumanId) {
        throw Object.assign(new Error('Invite code is invalid or expired'), { code: 'INVITE_UNAVAILABLE' });
      }
      invite.status = 'redeemed'; invite.redeemed_by_human_id = redeemerHumanId; invite.redeemed_at = timestamp;
      const [endpointA, endpointB] = [invite.issuer_endpoint_id, redeemerEndpointId].sort();
      const existing = [...directoryLinks.values()].find((l) => l.endpoint_a === endpointA && l.endpoint_b === endpointB && (l.status === 'pending' || l.status === 'active'));
      if (existing) throw Object.assign(new Error('A directory link already exists or is pending between these endpoints'), { code: 'DIRECTORY_LINK_CONFLICT' });
      const linkId = `link_${crypto.randomUUID()}`;
      const [humanA, humanB] = endpointA === invite.issuer_endpoint_id ? [invite.issuer_human_id, redeemerHumanId] : [redeemerHumanId, invite.issuer_human_id];
      const link = {
        link_id: linkId, endpoint_a: endpointA, endpoint_b: endpointB, human_a: humanA, human_b: humanB, status: 'pending', initiated_via: 'invite',
        a_confirmed_at: endpointA === invite.issuer_endpoint_id ? null : timestamp,
        b_confirmed_at: endpointA === invite.issuer_endpoint_id ? timestamp : null,
        a_confirmed_by: endpointA === invite.issuer_endpoint_id ? null : redeemerHumanId,
        b_confirmed_by: endpointA === invite.issuer_endpoint_id ? redeemerHumanId : null,
        revoked_at: null, home_relay: homeRelay, created_at: timestamp
      };
      directoryLinks.set(linkId, link);
      return { link_id: linkId, status: 'pending' };
    },
    async createDirectoryMatchRequest({ issuerEndpointId, issuerHumanId, issuer, matchTarget, expiresAt, homeRelay, now = new Date() }) {
      const requestId = `dreq_${crypto.randomUUID()}`;
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      // Mirrors createDirectoryInvite's use of boundedDirectoryExpiry (same
      // [1h, 7d] bound and Date-coercion) instead of calling
      // expiresAt.toISOString() directly, which would throw on an
      // undefined/string expiresAt.
      const expiry = boundedDirectoryExpiry({ now, expiresAt });
      directoryMatchRequests.set(requestId, { request_id: requestId, issuer_endpoint_id: issuerEndpointId, issuer_human_id: issuerHumanId, issuer, match_target: matchTarget, status: 'pending', expires_at: expiry.toISOString(), home_relay: homeRelay, created_at: timestamp });
      return { request_id: requestId };
    },
    // Single-process, no real client/connection -- "concurrency" here
    // reduces to first-write-wins on a synchronous find + mutation, with no
    // `await` between the find and the status flip so nothing else in this
    // single-threaded event loop can interleave and see the same pending
    // row: equivalent in effect to Postgres's SELECT ... FOR UPDATE SKIP
    // LOCKED for a store with only one writer ever active at a time.
    async claimDirectoryMatch({ issuer, matchTarget, matchedHumanId, now = new Date() }) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const candidate = [...directoryMatchRequests.values()].find((r) => r.issuer === issuer && r.match_target === matchTarget && r.status === 'pending' && r.expires_at > timestamp);
      if (!candidate) return null;
      candidate.status = 'matched'; candidate.matched_human_id = matchedHumanId; candidate.matched_at = timestamp;
      return { request_id: candidate.request_id };
    },
    async nominateDirectoryLinkEndpoint({ requestId, nominatedEndpointId, nominatedHumanId, homeRelay, now = new Date() }) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const request = directoryMatchRequests.get(requestId);
      if (!request || request.status !== 'matched' || request.matched_human_id !== nominatedHumanId) {
        throw Object.assign(new Error('Match request is invalid or already consumed'), { code: 'MATCH_UNAVAILABLE' });
      }
      // Mirrors redeemDirectoryInvite's human_a <> human_b guard (backed on
      // the Postgres side by directory_links' CHECK constraint): a human
      // can't link to their own other endpoint via their own match. Checked
      // before the request is marked consumed, same as the Postgres path.
      if (request.issuer_human_id === nominatedHumanId) {
        throw Object.assign(new Error('Match request is invalid or already consumed'), { code: 'MATCH_UNAVAILABLE' });
      }
      request.status = 'consumed'; request.consumed_at = timestamp;
      const [endpointA, endpointB] = [request.issuer_endpoint_id, nominatedEndpointId].sort();
      const existing = [...directoryLinks.values()].find((l) => l.endpoint_a === endpointA && l.endpoint_b === endpointB && (l.status === 'pending' || l.status === 'active'));
      if (existing) throw Object.assign(new Error('A directory link already exists or is pending between these endpoints'), { code: 'DIRECTORY_LINK_CONFLICT' });
      const linkId = `link_${crypto.randomUUID()}`;
      const [humanA, humanB] = endpointA === request.issuer_endpoint_id ? [request.issuer_human_id, nominatedHumanId] : [nominatedHumanId, request.issuer_human_id];
      directoryLinks.set(linkId, {
        link_id: linkId, endpoint_a: endpointA, endpoint_b: endpointB, human_a: humanA, human_b: humanB, status: 'pending', initiated_via: 'oidc_match',
        a_confirmed_at: endpointA === request.issuer_endpoint_id ? null : timestamp,
        b_confirmed_at: endpointA === request.issuer_endpoint_id ? timestamp : null,
        a_confirmed_by: endpointA === request.issuer_endpoint_id ? null : nominatedHumanId,
        b_confirmed_by: endpointA === request.issuer_endpoint_id ? nominatedHumanId : null,
        revoked_at: null, home_relay: homeRelay, created_at: timestamp
      });
      return { link_id: linkId, status: 'pending' };
    },
    async confirmDirectoryLink({ linkId, confirmingHumanId, now = new Date() }) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const link = directoryLinks.get(linkId);
      if (!link) throw Object.assign(new Error('Directory link not found'), { code: 'LINK_UNAVAILABLE' });
      if (link.status !== 'pending') return { link_id: linkId, status: link.status };
      if (confirmingHumanId !== link.human_a && confirmingHumanId !== link.human_b) {
        throw Object.assign(new Error('Confirming human is not a party to this link'), { code: 'CONFIRMATION_ACTOR_MISMATCH' });
      }
      const isA = confirmingHumanId === link.human_a;
      if (isA && link.a_confirmed_at) return { link_id: linkId, status: link.status };
      if (!isA && link.b_confirmed_at) return { link_id: linkId, status: link.status };
      if (isA) { link.a_confirmed_at = timestamp; link.a_confirmed_by = confirmingHumanId; } else { link.b_confirmed_at = timestamp; link.b_confirmed_by = confirmingHumanId; }
      link.status = (link.a_confirmed_at && link.b_confirmed_at) ? 'active' : 'pending';
      return { link_id: linkId, status: link.status };
    },
    async revokeDirectoryLink({ linkId, revokingHumanId, now = new Date() }) {
      const link = directoryLinks.get(linkId);
      if (!link) throw Object.assign(new Error('Directory link not found'), { code: 'LINK_UNAVAILABLE' });
      if (link.status === 'revoked') return { link_id: linkId, status: 'revoked', duplicate: true };
      if (revokingHumanId !== link.human_a && revokingHumanId !== link.human_b) {
        throw Object.assign(new Error('Revoking human is not a party to this link'), { code: 'CONFIRMATION_ACTOR_MISMATCH' });
      }
      link.status = 'revoked'; link.revoked_at = (now instanceof Date ? now : new Date(now)).toISOString(); link.revoked_by = revokingHumanId;
      return { link_id: linkId, status: 'revoked', duplicate: false };
    },
    async lookupActiveDirectoryLink(endpointIdA, endpointIdB) {
      const found = [...directoryLinks.values()].find((l) => l.status === 'active' && ((l.endpoint_a === endpointIdA && l.endpoint_b === endpointIdB) || (l.endpoint_a === endpointIdB && l.endpoint_b === endpointIdA)));
      return found ? { link_id: found.link_id, status: found.status } : null;
    },
    // Test-only: exposes the raw stored record (including a_confirmed_by/
    // b_confirmed_by, which no production-facing method returns) so
    // regression tests can assert on confirmation attribution directly.
    _debugGetDirectoryLink(linkId) {
      return directoryLinks.get(linkId);
    },
    async acknowledgeDelivery({ deliveryId, endpointId, now }) {
      const current = deliveries.get(deliveryId);
      if (!current || current.recipient_endpoint_id !== endpointId) throw Object.assign(new Error('Delivery not found'), { code: 'DELIVERY_UNAVAILABLE' });
      if (current.state === 'acknowledged') return { ...current, duplicate: true };
      const next = transitionDelivery(current, 'acknowledged', { now });
      deliveries.set(deliveryId, next);
      return next;
    },
    async getDelivery(deliveryId, endpointId) {
      const current = deliveries.get(deliveryId);
      return current && current.recipient_endpoint_id === endpointId ? current : null;
    },
    async transitionDelivery(deliveryId, _endpointId, _target, { next }) {
      deliveries.set(deliveryId, next);
      return next;
    },
    async lookupCapabilityRegistration(capability) {
      const entry = SEEDED_CAPABILITIES.get(capability);
      return entry ? { capability, namespace: entry.namespace, risk_tier: entry.risk_tier } : null;
    },
    async lookupMessageSender(messageId) {
      const row = envelopes.get(messageId);
      return row ? { endpoint_id: row.envelope.sender.endpoint_id } : null;
    },
    // No real row locking possible/needed in a single-process in-memory
    // store -- withTransaction is already a no-op here (see above).
    async lookupActiveCapabilityGrants(endpointId, now) {
      const timestamp = (now instanceof Date ? now : new Date(now)).getTime();
      return grants.filter((g) => g.granted_to === endpointId && !g.revoked_at && new Date(g.expires_at).getTime() > timestamp).map((g) => ({ capability: g.capability, scope: g.scope }));
    },
    async createCapabilityGrant({ grantId, capability, scope, grantedTo, expiresAt, now = new Date() }) {
      const grant = { grant_id: grantId, capability, scope, granted_to: grantedTo, expires_at: expiresAt, revoked_at: null, granted_at: (now instanceof Date ? now : new Date(now)).toISOString() };
      grants.push(grant);
      return grant;
    },
    async revokeCapabilityGrant(grantId, { now = new Date() } = {}) {
      const grant = grants.find((g) => g.grant_id === grantId);
      if (!grant) throw Object.assign(new Error('Capability grant not found'), { code: 'GRANT_UNAVAILABLE' });
      if (grant.revoked_at) return { ...grant, duplicate: true };
      grant.revoked_at = (now instanceof Date ? now : new Date(now)).toISOString();
      return { ...grant, duplicate: false };
    },
    async createHumanSession({ sessionId, humanId, authenticationMethod, assurance, deviceContext = {}, issuedAt = new Date(), expiresAt, now = new Date() }) {
      const issued = (issuedAt instanceof Date ? issuedAt : new Date(issuedAt)).toISOString();
      const expires = (expiresAt instanceof Date ? expiresAt : new Date(expiresAt)).toISOString();
      const session = { session_id: sessionId, human_id: humanId, authentication_method: authenticationMethod, assurance, device_context: deviceContext, issued_at: issued, version: 1, expires_at: expires, revoked_at: null };
      humanSessions.set(sessionId, session);
      return session;
    },
    async consumeLoginJti(jti, { now = new Date(), expiresAt }) {
      if (consumedLoginJtis.has(jti)) {
        throw Object.assign(new Error('ID token has already been used'), { code: 'TOKEN_REPLAYED' });
      }
      consumedLoginJtis.set(jti, (expiresAt instanceof Date ? expiresAt : new Date(expiresAt)).toISOString());
      return undefined;
    },
    async getOidcIssuerAllowlistEntry(issuer) {
      const entry = oidcIssuerAllowlist.get(issuer);
      return entry ? { issuer, clientId: entry.clientId ?? null, enabled: entry.enabled } : null;
    },
    // Test-only: memory-repository has no admin/migration path, so tests
    // that exercise the real-login route seed allow-list rows directly,
    // mirroring how Postgres tests INSERT into oidc_issuer_allowlist.
    _debugSeedOidcIssuer({ issuer, clientId = null, enabled = true }) {
      oidcIssuerAllowlist.set(issuer, { clientId, enabled });
    },
    // Mirrors postgres-repository.mjs's recordAuditEvent row shape (minus
    // the actual persistence -- single process, nothing to query it back
    // out of besides this array).
    async recordAuditEvent({ eventId = `audit_${crypto.randomUUID()}`, eventType, subjectId, actorId = null, actorHumanId = null, endpointId = null, objectType = null, objectId = null, actionHash = null, outcome = null, reason = null, payload = {}, metadataRedacted = null, now = new Date() } = {}) {
      const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
      const event = { event_id: eventId, event_type: eventType, subject_id: subjectId, actor_id: actorId, actor_human_id: actorHumanId, endpoint_id: endpointId, object_type: objectType, object_id: objectId, action_hash: actionHash, outcome, reason, payload, metadata_redacted: metadataRedacted, created_at: timestamp };
      auditEvents.push(event);
      return event;
    },
    // Test-only: exposes recorded audit events (mirrors _debugGetDirectoryLink
    // above) so regression tests can assert an event was recorded without a
    // real audit_events table to query.
    _debugGetAuditEvents() {
      return auditEvents;
    }
  };
}
