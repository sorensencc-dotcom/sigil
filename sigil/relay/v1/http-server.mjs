import http from 'node:http';
import crypto from 'node:crypto';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { transitionDelivery } from './delivery-state.mjs';

export function createRelayServer({ registry, idempotency = new Map(), lookupIdempotency, persist, repository, authenticate, now, stream } = {}) {
  return http.createServer(async (request, response) => {
    const requestId = request.headers['x-sigil-request-id'] ?? crypto.randomUUID();
    const principal = authenticate ? await authenticate(request) : null;
    if (authenticate && !principal) {
      response.writeHead(401, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(JSON.stringify({ request_id: requestId, code: 'UNAUTHENTICATED', message: 'Authentication required', details: {} }));
    }
    if (request.method === 'POST' && request.url === '/v1/envelopes') {
      let raw = ''; for await (const chunk of request) raw += chunk;
      let envelope; try { envelope = JSON.parse(raw); } catch { response.writeHead(400, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'Invalid JSON', details: {} })); }
      const result = await acceptEnvelopeAsync(envelope, { registered: registry, idempotency, lookupIdempotency, request_id: requestId, persist: async (row) => { await persist?.(row); if (stream && envelope.recipient?.endpoint_id) stream.notify(envelope.recipient.endpoint_id, row.message_id); }, now });
      response.writeHead(result.status, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(result.body ? JSON.stringify(result.body) : '');
    }
    if (request.method === 'GET' && request.url.startsWith('/v1/inbox')) {
      if (!repository?.listInbox) return response.writeHead(503).end();
      const since = new URL(request.url, 'http://sigil.local').searchParams.get('since') ?? '';
      const items = await repository.listInbox(principal.endpoint_id, since);
      response.writeHead(200, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(JSON.stringify({ request_id: requestId, code: 'OK', items }));
    }
    const deliveryMatch = request.url.match(/^\/v1\/deliveries\/([^/]+)\/(ack|processing)$/);
    if (request.method === 'POST' && deliveryMatch) {
      const [, deliveryId, action] = deliveryMatch;
      let body = {}; let raw = ''; for await (const chunk of request) raw += chunk;
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
