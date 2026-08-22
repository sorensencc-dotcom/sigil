import http from 'node:http';
import crypto from 'node:crypto';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { transitionDelivery } from './delivery-state.mjs';
import { createBearerAuthenticator } from './transport-auth.mjs';
import { createApprovalChallenge, coseKeyToPublicKey, parseAttestationObject, verifyPackedAttestation, verifyWebAuthnApproval, verifyWebAuthnAssertion } from './approval-ceremony.mjs';
import { renderApprovalPage } from './approval-ui.mjs';
import { computeActionHash } from './action-hash.mjs';
import { normalizeIssuer } from './issuer-normalization.mjs';
import { assertAccountLinkCeremony, assertAllowedIssuer, boundedDirectoryExpiry, boundedTokenExpiry } from './auth-policy.mjs';
import { resolveDirectoryRateLimits } from './relay-config.mjs';

function normalizeIssuerOrRespond(rawIssuer, response, requestId) {
  try {
    return { issuer: normalizeIssuer(rawIssuer) };
  } catch (error) {
    response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
    response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'INVALID_ISSUER', message: error.message, details: {} }));
    return { error: true };
  }
}

async function readBody(request, maxBytes = 1024 * 1024) {
  let raw = ''; let size = 0;
  for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > maxBytes) throw Object.assign(new Error('Request body too large'), { code: 'REQUEST_TOO_LARGE' }); raw += chunk; }
  return raw;
}

export function createRelayServer({ registry, idempotency = new Map(), lookupIdempotency, persist, repository, authenticate, tokenHashes, now: configuredNow = () => new Date(), stream, relayOrigin, rpId, approvalChallenges = new Map(), maxPendingApprovals = 100, oidcIssuerAllowList = new Set(), lookupHumanCredential, verifyAssertion } = {}) {
  const authenticateRequest = authenticate ?? (tokenHashes ? createBearerAuthenticator(tokenHashes) : null);
  const resolveHumanCredential = lookupHumanCredential ?? repository?.lookupHumanCredential?.bind(repository);
  const assertionRateLimits = new Map();
  const MAX_STORED_LIMITS = 5000;
  const ATTEMPT_LIMIT = 10;
  const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

  function recordAttemptAndCheckLimit(challengeId, nowMs) {
    if (assertionRateLimits.size > MAX_STORED_LIMITS) {
      for (const [k, v] of assertionRateLimits.entries()) {
        if (v.expiresAt <= nowMs) assertionRateLimits.delete(k);
      }
    }
    const entry = assertionRateLimits.get(challengeId);
    if (entry && entry.expiresAt > nowMs) {
      entry.count += 1;
      if (entry.count > ATTEMPT_LIMIT) {
        return false;
      }
      return true;
    }
    assertionRateLimits.set(challengeId, { count: 1, expiresAt: nowMs + ATTEMPT_WINDOW_MS });
    return true;
  }

  async function reserveDirectoryQuota(scopeKind, scopeId, nowMsValue) {
    if (!repository?.reserveRateLimit) return { allowed: true };
    const limits = resolveDirectoryRateLimits();
    const windowStart = new Date(Math.floor(nowMsValue / 60_000) * 60_000).toISOString();
    return repository.reserveRateLimit(scopeKind, scopeId, windowStart, limits[scopeKind]);
  }

  return http.createServer(async (request, response) => {
    const now = typeof configuredNow === 'function' ? configuredNow() : configuredNow;
    const nowMs = now instanceof Date ? now.getTime() : typeof now === 'string' || typeof now === 'number' ? new Date(now).getTime() : Date.now();
    const requestId = request.headers['x-sigil-request-id'] ?? crypto.randomUUID();

    const parsedUrl = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    if (request.method === 'GET' && (parsedUrl.pathname === '/approve' || parsedUrl.pathname === '/v1/approvals/ceremony')) {
      const challengeId = parsedUrl.searchParams.get('challenge');
      const challenge = challengeId ? (repository?.getApprovalChallenge ? await repository.getApprovalChallenge(challengeId) : approvalChallenges.get(challengeId)) : null;
      const html = renderApprovalPage({ challenge });
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-sigil-request-id': requestId });
      return response.end(html);
    }

    const resolveRelayOrigin = () => {
      if (typeof relayOrigin === 'function') return relayOrigin(request);
      if (relayOrigin) return relayOrigin;
      return null;
    };

    const assertionMatch = request.url.match(/^\/v1\/approval-challenges\/([^/]+)\/assertion$/);
    if (request.method === 'POST' && assertionMatch) {
      const challengeId = assertionMatch[1];
      const challenge = repository?.getApprovalChallenge ? await repository.getApprovalChallenge(challengeId) : approvalChallenges.get(challengeId);
      if (!challenge) {
        response.writeHead(404, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'APPROVAL_EXPIRED', message: 'Approval challenge not found', details: {} }));
      }
      if (challenge.used || challenge.consuming || Date.parse(challenge.expiresAt) <= nowMs) {
        response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'APPROVAL_EXPIRED', message: 'Approval challenge expired or already used', details: {} }));
      }

      if (!recordAttemptAndCheckLimit(challengeId, nowMs)) {
        response.writeHead(429, { 'content-type': 'application/json', 'x-sigil-request-id': requestId, 'retry-after': '60' });
        return response.end(JSON.stringify({ request_id: requestId, code: 'RATE_LIMITED', message: 'Too many assertion attempts', details: {} }));
      }

      const effectiveRelayOrigin = resolveRelayOrigin();
      if (!effectiveRelayOrigin) {
        response.writeHead(500, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'RELAY_ORIGIN_UNCONFIGURED', message: 'relayOrigin must be configured on the server to process WebAuthn approvals', details: {} }));
      }

      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let assertion; try { assertion = JSON.parse(raw); } catch { assertion = null; }

      const effectiveRpId = rpId ?? new URL(effectiveRelayOrigin).hostname;

      try {
        const normalized = {
          ...assertion,
          credentialId: assertion?.credentialId ?? assertion?.credential_id,
          endpointId: assertion?.endpointId ?? assertion?.endpoint_id ?? challenge.endpointId
        };
        const credential = await resolveHumanCredential?.(normalized.credentialId, challenge.endpointId);
        if (!credential || credential.endpointId !== challenge.endpointId) {
          throw Object.assign(new Error('WebAuthn authorization failed'), { code: 'APPROVAL_REQUIRED' });
        }
        if (credential?.coseKey && !credential.publicKey) Object.assign(credential, coseKeyToPublicKey(credential.coseKey) ?? {});
        const result = await verifyWebAuthnApproval({
          challenge,
          assertion: normalized,
          relayOrigin: effectiveRelayOrigin,
          rpId: effectiveRpId,
          credential,
          verifyAssertion: verifyAssertion ?? (({ assertion: candidate, credential: registered }) => verifyWebAuthnAssertion({ ...candidate, challenge, relayOrigin: effectiveRelayOrigin, rpId: effectiveRpId, credential: registered })),
          now: nowMs
        });
        if (repository?.finalizeApprovalDecision) await repository.finalizeApprovalDecision({ challengeId: challenge.id, humanId: result.actorId, credentialId: result.credentialId, endpointId: challenge.endpointId, now });
        assertionRateLimits.delete(challengeId);
        response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', ...result }));
      } catch (error) {
        response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'APPROVAL_REQUIRED', message: error.message, details: {} }));
      }
    }

    const principal = authenticateRequest ? await authenticateRequest(request) : null;
    if (authenticateRequest && !principal) {
      response.writeHead(401, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(JSON.stringify({ request_id: requestId, code: 'UNAUTHENTICATED', message: 'Authentication required', details: {} }));
    }
      if (request.method === 'POST' && request.url === '/v1/approval-challenges') {
      if (repository && (!repository.createApprovalChallenge || !repository.getApprovalChallenge || !repository.finalizeApprovalDecision)) return response.writeHead(503).end();
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      let actionHash = body?.action_hash;
      if (body?.action) {
        try { actionHash = computeActionHash({ ...body.action, endpoint_id: principal?.endpoint_id }); }
        catch (error) { response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'INVALID_ACTION', message: error.message, details: {} })); }
        if (body.action_hash && body.action_hash !== actionHash) {
          response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
          return response.end(JSON.stringify({ request_id: requestId, code: 'APPROVAL_REQUIRED', message: 'Action hash does not match canonical action', details: {} }));
        }
      }
      const effectiveRelayOrigin = resolveRelayOrigin();
      if (!actionHash || !body?.callback_url || !effectiveRelayOrigin || !principal?.endpoint_id) {
        response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'APPROVAL_REQUIRED', message: 'Approval challenge fields are required', details: {} }));
      }
      if (approvalChallenges.size >= maxPendingApprovals) {
        response.writeHead(429, { 'content-type': 'application/json', 'x-sigil-request-id': requestId, 'retry-after': '60' });
        return response.end(JSON.stringify({ request_id: requestId, code: 'RATE_LIMITED', message: 'Approval queue capacity reached', details: {} }));
      }
      try {
        const challenge = createApprovalChallenge({ relayOrigin: effectiveRelayOrigin, actionHash, endpointId: principal.endpoint_id, callbackUrl: body.callback_url });
        if (repository?.createApprovalChallenge) await repository.createApprovalChallenge(challenge);
        else approvalChallenges.set(challenge.id, challenge);
        response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', challenge_id: challenge.id, webauthn_challenge: challenge.webauthnChallenge, approval_url: challenge.approvalUrl, expires_at: challenge.expiresAt }));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'APPROVAL_REQUIRED', message: error.message, details: {} }));
      }
    }
    if (request.method === 'POST' && request.url === '/v1/webauthn/credentials') {
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      const parsed = body?.attestation_object ? parseAttestationObject(body.attestation_object) : null;
      if (!parsed || !principal?.human_id || typeof repository?.registerHumanCredential !== 'function') {
        response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ATTESTATION', message: 'Valid attestation and credential repository are required', details: {} }));
      }
      try {
        const credentialId = parsed.credentialId.toString('base64url');
        if (body.credential_id && body.credential_id !== credentialId) throw Object.assign(new Error('Credential ID does not match attestation'), { code: 'INVALID_ATTESTATION' });
        if (parsed.format === 'packed' && !verifyPackedAttestation({ parsed, clientDataJSON: body.client_data_json })) throw Object.assign(new Error('Packed attestation signature verification failed'), { code: 'INVALID_ATTESTATION' });
        await repository.registerHumanCredential({ humanId: principal.human_id, endpointId: principal.endpoint_id, credentialId, type: 'webauthn', algorithm: parsed.algorithm, publicKey: parsed.publicKey, coseKey: parsed.coseKey });
        response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', credential_id: credentialId }));
      } catch (error) {
        response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'APPROVAL_REQUIRED', message: error.message, details: {} }));
      }
    }
    if (request.method === 'POST' && request.url === '/v1/envelopes') {
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let envelope; try { envelope = JSON.parse(raw); } catch { response.writeHead(400, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'Invalid JSON', details: {} })); }
      const result = await acceptEnvelopeAsync(envelope, {
        registered: registry, request_id: requestId, now, repository,
        onPersisted: async ({ envelope: accepted, persisted }) => {
          if (!stream || persisted?.duplicate) return;
          if (accepted.recipient?.endpoint_id) stream.notify(accepted.recipient.endpoint_id, persisted.message_id);
          if (accepted.sender?.endpoint_id && typeof stream.notifyReceipt === 'function') {
            stream.notifyReceipt(accepted.sender.endpoint_id, {
              message_id: persisted.message_id,
              delivery_id: persisted.delivery_id ?? `del_${persisted.message_id}`,
              state: 'delivered',
              at: accepted.created_at
            });
          }
        }
      });
      response.writeHead(result.status, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(result.body ? JSON.stringify(result.body) : '');
    }
    if (request.method === 'GET' && request.url.startsWith('/v1/inbox')) {
      if (!repository?.listInbox) return response.writeHead(503).end();
      const since = new URL(request.url, 'http://sigil.local').searchParams.get('since') ?? '';
      const items = await repository.listInbox(principal.endpoint_id, since, principal.owner_id ?? null);
      const nextSince = items.at(-1)?.queued_at ?? since;
      response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(JSON.stringify({ request_id: requestId, code: 'OK', items, next_since: nextSince }));
    }
    if (request.method === 'POST' && request.url === '/v1/endpoint-acknowledgements') {
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413); return response.end(); }
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body?.acknowledged_endpoint_id) { response.writeHead(400, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'acknowledged_endpoint_id is required', details: {} })); }
      if (!repository?.acknowledgeEndpoint) return response.writeHead(503).end();
      const acknowledgement = await repository.acknowledgeEndpoint({ viewerOwnerId: principal.owner_id, acknowledgedEndpointId: body.acknowledged_endpoint_id, now });
      response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(JSON.stringify({ request_id: requestId, code: 'OK', acknowledgement }));
    }
    const deliveryMatch = request.url.match(/^\/v1\/deliveries\/([^/]+)\/(ack|processing)$/);
    if (request.method === 'POST' && deliveryMatch) {
      const [, deliveryId, action] = deliveryMatch;
      let body = {}; let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      if (raw) { try { body = JSON.parse(raw); } catch { body = {}; } }
      const target = action === 'ack' ? 'acknowledged' : body.state;
      if (action === 'processing' && !['processing', 'processed', 'processing_failed', 'delivery_rejected'].includes(target)) {
        response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'Invalid processing state', details: {} }));
      }
      if (action === 'ack' && repository?.acknowledgeDelivery) {
        try {
          const acked = await repository.acknowledgeDelivery({ deliveryId, endpointId: principal.endpoint_id, now });
          if (stream && repository.lookupMessageSender) {
            const messageId = acked.delivery?.message_id ?? acked.message_id;
            const sender = await repository.lookupMessageSender(messageId);
            if (sender) stream.notifyReceipt(sender.endpoint_id, { message_id: messageId, delivery_id: deliveryId, state: 'acknowledged', at: now.toISOString() });
          }
          response.writeHead(204, { 'x-sigil-request-id': requestId });
          return response.end();
        } catch (error) {
          response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
          return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'DELIVERY_UNAVAILABLE', message: error.message, details: {} }));
        }
      }
      if (!repository?.transitionDelivery || !repository?.getDelivery) return response.writeHead(503).end();
      try {
        const current = await repository.getDelivery(deliveryId, principal.endpoint_id);
        const next = transitionDelivery(current, target, { now, reason: body.reason ?? null });
        await repository.transitionDelivery(deliveryId, principal.endpoint_id, target, { next });
        if (stream && repository.lookupMessageSender) {
          const sender = await repository.lookupMessageSender(current.message_id);
          if (sender) stream.notifyReceipt(sender.endpoint_id, { message_id: current.message_id, delivery_id: deliveryId, state: next.state, at: next.updated_at });
        }
        response.writeHead(204, { 'x-sigil-request-id': requestId });
        return response.end();
      } catch (error) {
        response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'DELIVERY_UNAVAILABLE', message: error.message, details: {} }));
      }
    }
    if (request.method === 'POST' && request.url === '/v1/identities') {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body?.issuer || !body?.subject) { response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'issuer and subject are required', details: {} })); }
      const normalizedCreate = normalizeIssuerOrRespond(body.issuer, response, requestId);
      if (normalizedCreate.error) return;
      try { assertAllowedIssuer(normalizedCreate.issuer, oidcIssuerAllowList); } catch (error) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      if (!repository?.createOidcIdentity) return response.writeHead(503).end();
      try {
        const identity = await repository.createOidcIdentity({ issuer: normalizedCreate.issuer, subject: body.subject, humanId: principal.human_id, now });
        await repository.recordAuditEvent?.({ eventType: 'oidc_identity.created', subjectId: `${normalizedCreate.issuer}|${body.subject}`, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'oidc_identity', objectId: body.subject, outcome: 'success', now });
        response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', identity }));
      } catch (error) {
        response.writeHead(error.code === '23505' ? 409 : 400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code === '23505' ? 'IDENTITY_CONFLICT' : (error.code ?? 'IDENTITY_UNAVAILABLE'), message: error.message, details: {} }));
      }
    }
    if (request.method === 'GET' && request.url.startsWith('/v1/identities') && !request.url.includes('/revoke')) {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      const params = new URL(request.url, 'http://sigil.local').searchParams;
      const rawLookupIssuer = params.get('issuer'); const subject = params.get('subject');
      if (!rawLookupIssuer || !subject) { response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'issuer and subject query parameters are required', details: {} })); }
      const normalizedLookup = normalizeIssuerOrRespond(rawLookupIssuer, response, requestId);
      if (normalizedLookup.error) return;
      try { assertAllowedIssuer(normalizedLookup.issuer, oidcIssuerAllowList); } catch (error) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      if (!repository?.lookupOidcIdentity) return response.writeHead(503).end();
      const identity = await repository.lookupOidcIdentity(normalizedLookup.issuer, subject);
      // Owner mismatch is reported the same as "not found" so a caller can't
      // use this route to enumerate other humans' linked identities.
      if (!identity || identity.human_id !== principal.human_id) {
        response.writeHead(404, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'IDENTITY_UNAVAILABLE', message: 'OIDC identity not found', details: {} }));
      }
      response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(JSON.stringify({ request_id: requestId, code: 'OK', identity }));
    }
    if (request.method === 'POST' && request.url === '/v1/identities/revoke') {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body?.issuer || !body?.subject) { response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'issuer and subject are required', details: {} })); }
      const normalizedRevoke = normalizeIssuerOrRespond(body.issuer, response, requestId);
      if (normalizedRevoke.error) return;
      try { assertAllowedIssuer(normalizedRevoke.issuer, oidcIssuerAllowList); } catch (error) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      if (!repository?.lookupOidcIdentity || (!repository?.revokeOidcIdentity && !repository?.revokeOidcIdentityWithAudit)) return response.writeHead(503).end();
      const owned = await repository.lookupOidcIdentity(normalizedRevoke.issuer, body.subject);
      if (!owned || owned.human_id !== principal.human_id) {
        response.writeHead(404, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'IDENTITY_UNAVAILABLE', message: 'OIDC identity not found', details: {} }));
      }
      try {
        // Prefer the audit-atomic method when the repository supports it, so
        // the revoke and its audit_events row commit or roll back together.
        const revoked = repository.revokeOidcIdentityWithAudit
          ? await repository.revokeOidcIdentityWithAudit(normalizedRevoke.issuer, body.subject, { now, actorHumanId: principal.human_id, endpointId: principal.endpoint_id })
          : await (async () => {
              const result = await repository.revokeOidcIdentity(normalizedRevoke.issuer, body.subject, { now });
              if (!result.duplicate) await repository.recordAuditEvent?.({ eventType: 'oidc_identity.revoked', subjectId: `${normalizedRevoke.issuer}|${body.subject}`, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'oidc_identity', objectId: body.subject, outcome: 'success', now });
              return result;
            })();
        response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', identity: revoked }));
      } catch (error) {
        response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'IDENTITY_UNAVAILABLE', message: error.message, details: {} }));
      }
    }
    if (request.method === 'POST' && request.url === '/v1/account-links') {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body?.issuer || !body?.subject) { response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'issuer and subject are required', details: {} })); }
      const normalizedLink = normalizeIssuerOrRespond(body.issuer, response, requestId);
      if (normalizedLink.error) return;
      try { assertAllowedIssuer(normalizedLink.issuer, oidcIssuerAllowList); } catch (error) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      try { assertAccountLinkCeremony({ nonceHash: body.nonce_hash, stateHash: body.state_hash, issuedAt: body.issued_at, expiresAt: body.expires_at, now }); } catch (error) { response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      if (!repository?.linkAccount) return response.writeHead(503).end();
      try {
        const linkId = `link_${crypto.randomUUID()}`;
        const link = await repository.linkAccount({ linkId, humanId: principal.human_id, issuer: normalizedLink.issuer, subject: body.subject, nonceHash: body.nonce_hash, stateHash: body.state_hash, issuedAt: body.issued_at, expiresAt: body.expires_at, now });
        await repository.recordAuditEvent?.({ eventType: 'account_link.created', subjectId: linkId, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'account_link', objectId: linkId, outcome: 'success', now });
        response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', link }));
      } catch (error) {
        response.writeHead(error.code === '23503' ? 404 : 409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code === '23503' ? 'IDENTITY_UNAVAILABLE' : (error.code ?? 'LINK_UNAVAILABLE'), message: error.message, details: {} }));
      }
    }
    const unlinkMatch = request.url.match(/^\/v1\/account-links\/([^/]+)\/unlink$/);
    if (request.method === 'POST' && unlinkMatch) {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      const [, linkId] = unlinkMatch;
      if ((!repository?.unlinkAccount && !repository?.unlinkAccountWithAudit) || !repository?.query) return response.writeHead(503).end();
      const owner = await repository.query('SELECT human_id FROM account_links WHERE link_id = $1', [linkId]);
      if (!owner.rows[0] || owner.rows[0].human_id !== principal.human_id) {
        response.writeHead(404, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'LINK_UNAVAILABLE', message: 'Account link not found', details: {} }));
      }
      try {
        const unlinked = repository.unlinkAccountWithAudit
          ? await repository.unlinkAccountWithAudit(linkId, { now, actorHumanId: principal.human_id, endpointId: principal.endpoint_id })
          : await (async () => {
              const result = await repository.unlinkAccount(linkId, { now });
              if (!result.duplicate) await repository.recordAuditEvent?.({ eventType: 'account_link.unlinked', subjectId: linkId, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'account_link', objectId: linkId, outcome: 'success', now });
              return result;
            })();
        response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', link: unlinked }));
      } catch (error) {
        response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'LINK_UNAVAILABLE', message: error.message, details: {} }));
      }
    }
    const sessionRevokeMatch = request.url.match(/^\/v1\/sessions\/([^/]+)\/revoke$/);
    if (request.method === 'POST' && sessionRevokeMatch) {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      const [, sessionId] = sessionRevokeMatch;
      if ((!repository?.revokeHumanSession && !repository?.revokeHumanSessionWithAudit) || !repository?.query) return response.writeHead(503).end();
      const owner = await repository.query('SELECT human_id FROM human_sessions WHERE session_id = $1', [sessionId]);
      if (!owner.rows[0] || owner.rows[0].human_id !== principal.human_id) {
        response.writeHead(404, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'SESSION_UNAVAILABLE', message: 'Session not found', details: {} }));
      }
      try {
        const revoked = repository.revokeHumanSessionWithAudit
          ? await repository.revokeHumanSessionWithAudit(sessionId, { now, actorHumanId: principal.human_id, endpointId: principal.endpoint_id })
          : await (async () => {
              const result = await repository.revokeHumanSession(sessionId, { now });
              if (!result.duplicate) await repository.recordAuditEvent?.({ eventType: 'human_session.revoked', subjectId: sessionId, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'human_session', objectId: sessionId, outcome: 'success', now });
              return result;
            })();
        response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', session: revoked }));
      } catch (error) {
        response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'SESSION_UNAVAILABLE', message: error.message, details: {} }));
      }
    }
    if (request.method === 'POST' && request.url === '/v1/endpoint-tokens') {
      if (!repository?.issueEndpointToken) return response.writeHead(503).end();
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body = {}; if (raw) { try { body = JSON.parse(raw); } catch { body = {}; } }
      try {
        const tokenId = `tok_${crypto.randomUUID()}`;
        const issued = await repository.issueEndpointToken({ tokenId, endpointId: principal.endpoint_id, expiresAt: boundedTokenExpiry({ now, expiresAt: body.expires_at }), now });
        // Audit payload deliberately excludes `token` -- only the response
        // body carries the plaintext secret, and only for this one call.
        await repository.recordAuditEvent?.({ eventType: 'endpoint_token.issued', subjectId: tokenId, endpointId: principal.endpoint_id, objectType: 'endpoint_token', objectId: tokenId, outcome: 'success', now });
        response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', token_id: issued.token_id, token: issued.token, expires_at: issued.expires_at }));
      } catch (error) {
        response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'TOKEN_UNAVAILABLE', message: error.message, details: {} }));
      }
    }
    const tokenRotateMatch = request.url.match(/^\/v1\/endpoint-tokens\/([^/]+)\/rotate$/);
    if (request.method === 'POST' && tokenRotateMatch) {
      const [, oldTokenId] = tokenRotateMatch;
      if (!repository?.rotateEndpointToken) return response.writeHead(503).end();
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body = {}; if (raw) { try { body = JSON.parse(raw); } catch { body = {}; } }
      try {
        const newTokenId = `tok_${crypto.randomUUID()}`;
        // rotateEndpointToken already writes its own audit_events row
        // (endpoint_token.rotated), so this route does not emit a second one.
        const rotated = await repository.rotateEndpointToken({ oldTokenId, newTokenId, endpointId: principal.endpoint_id, expiresAt: boundedTokenExpiry({ now, expiresAt: body.expires_at }), now });
        response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', token_id: rotated.token_id, token: rotated.token, expires_at: rotated.expires_at }));
      } catch (error) {
        response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'TOKEN_UNAVAILABLE', message: error.message, details: {} }));
      }
    }
    const tokenRevokeMatch = request.url.match(/^\/v1\/endpoint-tokens\/([^/]+)\/revoke$/);
    if (request.method === 'POST' && tokenRevokeMatch) {
      const [, tokenId] = tokenRevokeMatch;
      if (!repository?.revokeEndpointToken) return response.writeHead(503).end();
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body = {}; if (raw) { try { body = JSON.parse(raw); } catch { body = {}; } }
      try {
        // revokeEndpointToken already writes its own audit_events row
        // (endpoint_token.revoked), so this route does not emit a second one.
        const revoked = await repository.revokeEndpointToken(tokenId, { endpointId: principal.endpoint_id, reason: body.reason ?? null, now });
        response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', token_id: revoked.token_id, status: revoked.status }));
      } catch (error) {
        response.writeHead(404, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'TOKEN_UNAVAILABLE', message: error.message, details: {} }));
      }
    }
    if (request.method === 'POST' && request.url === '/v1/capability-grants') {
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body?.capability || !body?.scope || !body?.expires_at) { response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'capability, scope, and expires_at are required', details: {} })); }
      if (!repository?.createCapabilityGrant && !repository?.createCapabilityGrantWithAudit) return response.writeHead(503).end();
      try {
        const grantId = `grant_${crypto.randomUUID()}`;
        const grantFields = { grantId, capability: body.capability, scope: body.scope, purpose: body.purpose ?? null, provenance: body.provenance ?? null, issuer: body.issuer ?? null, grantedTo: principal.endpoint_id, grantedBy: principal.human_id ?? principal.endpoint_id, expiresAt: body.expires_at, now };
        const grant = repository.createCapabilityGrantWithAudit
          ? await repository.createCapabilityGrantWithAudit({ ...grantFields, actorHumanId: principal.human_id ?? null, endpointId: principal.endpoint_id })
          : await (async () => {
              const result = await repository.createCapabilityGrant(grantFields);
              await repository.recordAuditEvent?.({ eventType: 'capability_grant.created', subjectId: grantId, actorHumanId: principal.human_id ?? null, endpointId: principal.endpoint_id, objectType: 'capability_grant', objectId: grantId, outcome: 'success', now });
              return result;
            })();
        response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', grant }));
      } catch (error) {
        response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'GRANT_UNAVAILABLE', message: error.message, details: {} }));
      }
    }
    const grantRevokeMatch = request.url.match(/^\/v1\/capability-grants\/([^/]+)\/revoke$/);
    if (request.method === 'POST' && grantRevokeMatch) {
      const [, grantId] = grantRevokeMatch;
      if ((!repository?.revokeCapabilityGrant && !repository?.revokeCapabilityGrantWithAudit) || !repository?.query) return response.writeHead(503).end();
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body = {}; if (raw) { try { body = JSON.parse(raw); } catch { body = {}; } }
      const owner = await repository.query('SELECT granted_to, granted_by FROM capability_grants WHERE grant_id = $1', [grantId]);
      const grantRow = owner.rows[0];
      if (!grantRow || (grantRow.granted_to !== principal.endpoint_id && (!principal.human_id || grantRow.granted_by !== principal.human_id))) {
        response.writeHead(404, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'GRANT_UNAVAILABLE', message: 'Capability grant not found', details: {} }));
      }
      try {
        const revoked = repository.revokeCapabilityGrantWithAudit
          ? await repository.revokeCapabilityGrantWithAudit(grantId, { revokedBy: principal.human_id ?? principal.endpoint_id, reason: body.reason ?? null, now, actorHumanId: principal.human_id ?? null, endpointId: principal.endpoint_id })
          : await (async () => {
              const result = await repository.revokeCapabilityGrant(grantId, { revokedBy: principal.human_id ?? principal.endpoint_id, reason: body.reason ?? null, now });
              if (!result.duplicate) await repository.recordAuditEvent?.({ eventType: 'capability_grant.revoked', subjectId: grantId, actorHumanId: principal.human_id ?? null, endpointId: principal.endpoint_id, objectType: 'capability_grant', objectId: grantId, outcome: 'success', reason: body.reason ?? null, now });
              return result;
            })();
        response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', grant: revoked }));
      } catch (error) {
        response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'GRANT_UNAVAILABLE', message: error.message, details: {} }));
      }
    }
    if (request.method === 'GET' && request.url.startsWith('/v1/audit')) {
      const conversationId = new URL(request.url, 'http://sigil.local').searchParams.get('conversation_id');
      if (!conversationId) { response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'conversation_id query parameter is required', details: {} })); }
      if (!repository?.isConversationMember || !repository?.listAuditEventsForConversation) return response.writeHead(503).end();
      const isMember = await repository.isConversationMember(principal.endpoint_id, conversationId);
      if (!isMember) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'ROUTE_NOT_AUTHORIZED', message: 'Not a member of this conversation', details: {} })); }
      const events = await repository.listAuditEventsForConversation(conversationId);
      response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(JSON.stringify({ request_id: requestId, code: 'OK', events }));
    }
    if (request.method === 'POST' && request.url === '/v1/directory/invites') {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      if (!repository?.createDirectoryInvite) return response.writeHead(503).end();
      const inviteQuota = await reserveDirectoryQuota('directory_invite_create', principal.human_id, nowMs);
      if (!inviteQuota.allowed) { response.writeHead(429, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'RATE_LIMITED', message: 'directory_invite_create rate limit exceeded', details: {} })); }
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body = {}; if (raw) { try { body = JSON.parse(raw); } catch { body = {}; } }
      try {
        const expiresAt = boundedDirectoryExpiry({ now, expiresAt: body.expires_at });
        const invite = await repository.createDirectoryInvite({ issuerEndpointId: principal.endpoint_id, issuerHumanId: principal.human_id, expiresAt, homeRelay: resolveRelayOrigin() ?? 'local', now });
        await repository.recordAuditEvent?.({ eventType: 'directory_invite.created', subjectId: invite.invite_id, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'directory_invite', objectId: invite.invite_id, outcome: 'success', now });
        response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', invite }));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'DIRECTORY_EXPIRY_INVALID', message: error.message, details: {} }));
      }
    }
    if (request.method === 'POST' && request.url === '/v1/directory/invites/redeem') {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      if (!repository?.redeemDirectoryInvite) return response.writeHead(503).end();
      const redeemQuota = await reserveDirectoryQuota('directory_invite_redeem', principal.human_id, nowMs);
      if (!redeemQuota.allowed) { response.writeHead(429, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'RATE_LIMITED', message: 'directory_invite_redeem rate limit exceeded', details: {} })); }
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body?.code) { response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'code is required', details: {} })); }
      try {
        const link = await repository.redeemDirectoryInvite({ code: body.code, redeemerEndpointId: principal.endpoint_id, redeemerHumanId: principal.human_id, homeRelay: resolveRelayOrigin() ?? 'local', now });
        await repository.recordAuditEvent?.({ eventType: 'directory_link.created', subjectId: link.link_id, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'directory_link', objectId: link.link_id, outcome: 'success', now });
        response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', link }));
      } catch (error) {
        // spec §3.1.4: one generic error for wrong/expired/revoked/unknown --
        // 404 with the same INVITE_UNAVAILABLE code regardless of which.
        response.writeHead(error.code === 'DIRECTORY_LINK_CONFLICT' ? 409 : 404, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'INVITE_UNAVAILABLE', message: error.code === 'DIRECTORY_LINK_CONFLICT' ? error.message : 'Invite code is invalid or expired', details: {} }));
      }
    }
    if (request.method === 'POST' && request.url === '/v1/directory/matches') {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      if (!repository?.createDirectoryMatchRequest) return response.writeHead(503).end();
      const matchQuota = await reserveDirectoryQuota('directory_match_create', principal.human_id, nowMs);
      if (!matchQuota.allowed) { response.writeHead(429, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'RATE_LIMITED', message: 'directory_match_create rate limit exceeded', details: {} })); }
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body?.issuer || !body?.match_target) { response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'issuer and match_target are required', details: {} })); }
      const normalizedMatch = normalizeIssuerOrRespond(body.issuer, response, requestId);
      if (normalizedMatch.error) return;
      try { assertAllowedIssuer(normalizedMatch.issuer, oidcIssuerAllowList); } catch (error) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      try {
        const expiresAt = boundedDirectoryExpiry({ now, expiresAt: body.expires_at });
        const match = await repository.createDirectoryMatchRequest({ issuerEndpointId: principal.endpoint_id, issuerHumanId: principal.human_id, issuer: normalizedMatch.issuer, matchTarget: body.match_target, expiresAt, homeRelay: resolveRelayOrigin() ?? 'local', now });
        await repository.recordAuditEvent?.({ eventType: 'directory_match_request.created', subjectId: match.request_id, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'directory_match_request', objectId: match.request_id, outcome: 'success', now });
        response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', match }));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'DIRECTORY_EXPIRY_INVALID', message: error.message, details: {} }));
      }
    }
    const nominateMatch = request.url.match(/^\/v1\/directory\/matches\/([^/]+)\/nominate$/);
    if (request.method === 'POST' && nominateMatch) {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      const [, requestIdParam] = nominateMatch;
      if (!repository?.nominateDirectoryLinkEndpoint) return response.writeHead(503).end();
      const nominateQuota = await reserveDirectoryQuota('directory_match_attempt', `${requestIdParam}:${principal.human_id}`, nowMs);
      if (!nominateQuota.allowed) { response.writeHead(429, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'RATE_LIMITED', message: 'directory_match_attempt rate limit exceeded', details: {} })); }
      try {
        const link = await repository.nominateDirectoryLinkEndpoint({ requestId: requestIdParam, nominatedEndpointId: principal.endpoint_id, nominatedHumanId: principal.human_id, homeRelay: resolveRelayOrigin() ?? 'local', now });
        await repository.recordAuditEvent?.({ eventType: 'directory_link.created', subjectId: link.link_id, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'directory_link', objectId: link.link_id, outcome: 'success', now });
        response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', link }));
      } catch (error) {
        response.writeHead(error.code === 'DIRECTORY_LINK_CONFLICT' ? 409 : 404, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'MATCH_UNAVAILABLE', message: error.message, details: {} }));
      }
    }
    const confirmMatch = request.url.match(/^\/v1\/directory\/links\/([^/]+)\/confirm$/);
    if (request.method === 'POST' && confirmMatch) {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      const [, linkId] = confirmMatch;
      if (!repository?.confirmDirectoryLink) return response.writeHead(503).end();
      try {
        const link = await repository.confirmDirectoryLink({ linkId, confirmingHumanId: principal.human_id, now });
        if (link.status === 'active') await repository.recordAuditEvent?.({ eventType: 'directory_link.activated', subjectId: linkId, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'directory_link', objectId: linkId, outcome: 'success', now });
        else await repository.recordAuditEvent?.({ eventType: 'directory_link.confirmed', subjectId: linkId, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'directory_link', objectId: linkId, outcome: 'success', now });
        response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', link }));
      } catch (error) {
        response.writeHead(error.code === 'LINK_UNAVAILABLE' ? 404 : 403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'LINK_UNAVAILABLE', message: error.message, details: {} }));
      }
    }
    const revokeMatch = request.url.match(/^\/v1\/directory\/links\/([^/]+)\/revoke$/);
    if (request.method === 'POST' && revokeMatch) {
      if (!principal?.human_id) { response.writeHead(403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: 'HUMAN_CONTEXT_REQUIRED', message: 'An authenticated human context is required', details: {} })); }
      const [, linkId] = revokeMatch;
      if (!repository?.revokeDirectoryLink) return response.writeHead(503).end();
      try {
        const link = await repository.revokeDirectoryLink({ linkId, revokingHumanId: principal.human_id, now });
        if (!link.duplicate) await repository.recordAuditEvent?.({ eventType: 'directory_link.revoked', subjectId: linkId, actorHumanId: principal.human_id, endpointId: principal.endpoint_id, objectType: 'directory_link', objectId: linkId, outcome: 'success', now });
        response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', link }));
      } catch (error) {
        response.writeHead(error.code === 'LINK_UNAVAILABLE' ? 404 : 403, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'LINK_UNAVAILABLE', message: error.message, details: {} }));
      }
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ request_id: requestId, code: 'CONTEXT_NOT_FOUND', message: 'Route not found', details: {} }));
  });
}
