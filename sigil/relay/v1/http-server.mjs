import http from 'node:http';
import crypto from 'node:crypto';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { transitionDelivery } from './delivery-state.mjs';
import { createBearerAuthenticator } from './transport-auth.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { createApprovalChallenge, coseKeyToPublicKey, parseAttestationObject, verifyWebAuthnApproval, verifyWebAuthnAssertion } from './approval-ceremony.mjs';

async function readBody(request, maxBytes = 1024 * 1024) {
  let raw = ''; let size = 0;
  for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > maxBytes) throw Object.assign(new Error('Request body too large'), { code: 'REQUEST_TOO_LARGE' }); raw += chunk; }
  return raw;
}

export function createRelayServer({ registry, idempotency = new Map(), lookupIdempotency, persist, repository, authenticate, tokenHashes, now, stream, relayOrigin, rpId, approvalChallenges = new Map(), lookupHumanCredential, verifyAssertion } = {}) {
  const authenticateRequest = authenticate ?? (tokenHashes ? createBearerAuthenticator(tokenHashes) : null);
  const resolveHumanCredential = lookupHumanCredential ?? repository?.lookupHumanCredential?.bind(repository);
  const resolveIdempotency = lookupIdempotency ?? repository?.lookupIdempotency?.bind(repository);
  const persistAccepted = persist ?? (repository?.persistAcceptedEnvelope
    ? async (row) => repository.persistAcceptedEnvelope({ ...row, canonical_bytes: signedBytes(row.envelope), action_hash: row.canonical_hash })
    : undefined);
  return http.createServer(async (request, response) => {
    const requestId = request.headers['x-sigil-request-id'] ?? crypto.randomUUID();
    const principal = authenticateRequest ? await authenticateRequest(request) : null;
    if (authenticateRequest && !principal) {
      response.writeHead(401, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(JSON.stringify({ request_id: requestId, code: 'UNAUTHENTICATED', message: 'Authentication required', details: {} }));
    }
    if (request.method === 'POST' && request.url === '/v1/approval-challenges') {
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let body; try { body = JSON.parse(raw); } catch { body = null; }
      if (!body?.action_hash || !body.callback_url || !relayOrigin || !principal?.endpoint_id) {
        response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'APPROVAL_REQUIRED', message: 'Approval challenge fields are required', details: {} }));
      }
      try {
        const challenge = createApprovalChallenge({ relayOrigin, actionHash: body.action_hash, endpointId: principal.endpoint_id, callbackUrl: body.callback_url });
        approvalChallenges.set(challenge.id, challenge);
        response.writeHead(201, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', challenge_id: challenge.id, webauthn_challenge: challenge.webauthnChallenge, approval_url: challenge.approvalUrl, expires_at: challenge.expiresAt }));
      } catch (error) {
        response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'APPROVAL_REQUIRED', message: error.message, details: {} }));
      }
    }
    const assertionMatch = request.url.match(/^\/v1\/approval-challenges\/([^/]+)\/assertion$/);
    if (request.method === 'POST' && assertionMatch) {
      let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      let assertion; try { assertion = JSON.parse(raw); } catch { assertion = null; }
      const challenge = approvalChallenges.get(assertionMatch[1]);
      try {
        const credential = await resolveHumanCredential?.(assertion?.credential_id, principal?.endpoint_id);
        if (credential?.coseKey && !credential.publicKey) Object.assign(credential, coseKeyToPublicKey(credential.coseKey) ?? {});
        const normalized = { ...assertion, credentialId: assertion?.credentialId ?? assertion?.credential_id };
        const result = await verifyWebAuthnApproval({ challenge, assertion: normalized, relayOrigin, rpId, credential, verifyAssertion: verifyAssertion ?? (({ assertion: candidate, credential: registered }) => verifyWebAuthnAssertion({ ...candidate, challenge, relayOrigin, rpId, credential: registered })), now: now instanceof Date ? now.getTime() : Date.now() });
        response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'OK', ...result }));
      } catch (error) {
        response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
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
        await repository.registerHumanCredential({ humanId: principal.human_id, credentialId, type: 'webauthn', algorithm: parsed.algorithm, publicKey: parsed.publicKey, coseKey: parsed.coseKey });
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
      const result = await acceptEnvelopeAsync(envelope, { registered: registry, idempotency, lookupIdempotency: resolveIdempotency, request_id: requestId, persist: async (row) => { await persistAccepted?.(row); if (stream && envelope.recipient?.endpoint_id) stream.notify(envelope.recipient.endpoint_id, row.message_id); }, now });
      response.writeHead(result.status, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(result.body ? JSON.stringify(result.body) : '');
    }
    if (request.method === 'GET' && request.url.startsWith('/v1/inbox')) {
      if (!repository?.listInbox) return response.writeHead(503).end();
      const since = new URL(request.url, 'http://sigil.local').searchParams.get('since') ?? '';
      const items = await repository.listInbox(principal.endpoint_id, since);
      const nextSince = items.at(-1)?.queued_at ?? since;
      response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(JSON.stringify({ request_id: requestId, code: 'OK', items, next_since: nextSince }));
    }
    const deliveryMatch = request.url.match(/^\/v1\/deliveries\/([^/]+)\/(ack|processing)$/);
    if (request.method === 'POST' && deliveryMatch) {
      const [, deliveryId, action] = deliveryMatch;
      let body = {}; let raw; try { raw = await readBody(request); } catch (error) { response.writeHead(413, { 'content-type': 'application/json', 'x-sigil-request-id': requestId }); return response.end(JSON.stringify({ request_id: requestId, code: error.code, message: error.message, details: {} })); }
      if (raw) { try { body = JSON.parse(raw); } catch { body = {}; } }
      const target = action === 'ack' ? 'acknowledged' : body.state;
      if (action === 'processing' && !['processing', 'processing_failed'].includes(target)) {
        response.writeHead(400, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'Invalid processing state', details: {} }));
      }
      if (!repository?.transitionDelivery || !repository?.getDelivery) return response.writeHead(503).end();
      try {
        const current = await repository.getDelivery(deliveryId, principal.endpoint_id);
        const next = transitionDelivery(current, target, { now, reason: body.reason ?? null });
        await repository.transitionDelivery(deliveryId, principal.endpoint_id, target, { next });
        response.writeHead(204, { 'x-sigil-request-id': requestId });
        return response.end();
      } catch (error) {
        response.writeHead(409, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
        return response.end(JSON.stringify({ request_id: requestId, code: error.code ?? 'DELIVERY_UNAVAILABLE', message: error.message, details: {} }));
      }
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ request_id: requestId, code: 'CONTEXT_NOT_FOUND', message: 'Route not found', details: {} }));
  });
}
