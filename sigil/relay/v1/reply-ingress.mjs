import http from 'node:http';

const NOT_FOUND_BODY = JSON.stringify({ code: 'NOT_FOUND', message: 'Not found', details: {} });
const REPLY_PATH = /^\/v1\/rooms\/([^/]+)\/replies$/;

function notFound(response) {
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(NOT_FOUND_BODY);
}

export function createReplyIngress({ gate, limiter = async () => true, perBotLimiter = async () => true, metrics = null, logger = console, bodyMaxBytes = 96 * 1024, requestTimeoutMs = 10_000, now = () => new Date() } = {}) {
  const server = http.createServer(async (request, response) => {
    const parsed = new URL(request.url, 'http://127.0.0.1');
    const match = request.method === 'POST' ? parsed.pathname.match(REPLY_PATH) : null;
    if (!match || /%2f|%2e/i.test(match[1])) return notFound(response);
    const allowed = await limiter({ request, now: typeof now === 'function' ? now() : now });
    if (allowed === false || allowed?.allowed === false) {
      metrics?.increment('sigil_ingress_rate_limited_total', 1, { scope: 'ingress' });
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
      return response.end(JSON.stringify({ code: 'RATE_LIMITED', message: 'Too many requests', details: {} }));
    }
    metrics?.increment('sigil_ingress_requests_total', 1, { result: 'accepted' });
    const readBody = (req, max = bodyMaxBytes) => new Promise((resolve, reject) => {
      let raw = ''; let size = 0;
      const timer = setTimeout(() => { req.destroy(); reject(Object.assign(new Error('Request timed out'), { code: 'REQUEST_TIMEOUT' })); }, requestTimeoutMs);
      req.setEncoding('utf8');
      req.on('data', (chunk) => { size += Buffer.byteLength(chunk); if (size > max) { clearTimeout(timer); reject(Object.assign(new Error('Request body too large'), { code: 'REQUEST_TOO_LARGE' })); req.destroy(); return; } raw += chunk; });
      req.on('end', () => { clearTimeout(timer); resolve(raw); });
      req.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
    try {
      return await gate({ request, response, requestId: request.headers['x-sigil-request-id'] ?? 'ingress', roomId: match[1], now: typeof now === 'function' ? now() : now, readBody });
    } catch (error) {
      logger?.error?.({ event: 'reply_ingress_failed', code: error?.code ?? null });
      if (!response.headersSent) { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: 'DATABASE_UNAVAILABLE', message: 'Rooms temporarily unavailable', details: {} })); }
    }
  });
  server.keepAliveTimeout = requestTimeoutMs;
  server.requestTimeout = requestTimeoutMs;
  return {
    server,
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address()); });
      });
    },
  };
}
