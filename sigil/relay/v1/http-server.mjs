import http from 'node:http';
import crypto from 'node:crypto';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';

export function createRelayServer({ registry, idempotency = new Map(), lookupIdempotency, persist, now, stream } = {}) {
  return http.createServer(async (request, response) => {
    const requestId = request.headers['x-sigil-request-id'] ?? crypto.randomUUID();
    if (request.method === 'POST' && request.url === '/v1/envelopes') {
      let raw = ''; for await (const chunk of request) raw += chunk;
      let envelope; try { envelope = JSON.parse(raw); } catch { response.writeHead(400, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ request_id: requestId, code: 'INVALID_ENVELOPE', message: 'Invalid JSON', details: {} })); }
      const result = await acceptEnvelopeAsync(envelope, { registered: registry, idempotency, lookupIdempotency, request_id: requestId, persist: async (row) => { await persist?.(row); if (stream && envelope.recipient?.endpoint_id) stream.notify(envelope.recipient.endpoint_id, row.message_id); }, now });
      response.writeHead(result.status, { 'content-type': 'application/json', 'x-sigil-request-id': requestId });
      return response.end(result.body ? JSON.stringify(result.body) : '');
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ request_id: requestId, code: 'CONTEXT_NOT_FOUND', message: 'Route not found', details: {} }));
  });
}
