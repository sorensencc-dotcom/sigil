import http from 'node:http';
import { DEFAULT_REPLY_INGRESS_LIMITS } from './relay-config.mjs';

const NOT_FOUND_BODY = JSON.stringify({ code: 'NOT_FOUND', message: 'Not found', details: {} });
const REPLY_PATH = /^\/v1\/rooms\/([^/]+)\/replies$/;

function notFound(response) {
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(NOT_FOUND_BODY);
}

export function createReplyIngress({ gate, match: tokenMatcher, limiter, perBotLimiter, repository, ratePerMinute = DEFAULT_REPLY_INGRESS_LIMITS.ingress, perBotRatePerMinute = DEFAULT_REPLY_INGRESS_LIMITS.perBot, metrics = null, logger = console, bodyMaxBytes = 96 * 1024, requestTimeoutMs = 10_000, now = () => new Date() } = {}) {
  const ingressBuckets = new Map();
  const authFailures = { window: -1, count: 0 };
  const reserveIngress = limiter ?? (async ({ now: current }) => {
    const minute = Math.floor(new Date(current).getTime() / 60_000);
    const bucket = ingressBuckets.get(minute) ?? 0;
    ingressBuckets.set(minute, bucket + 1);
    for (const key of ingressBuckets.keys()) if (key !== minute) ingressBuckets.delete(key);
    return { allowed: bucket + 1 <= ratePerMinute };
  });
  const reserveBot = perBotLimiter ?? (async ({ botId, now: current }) => {
    if (!botId) return { allowed: true };
    if (typeof repository?.reserveRateLimit !== 'function') throw new Error('Reply ingress rate limit repository unavailable');
    const currentDate = new Date(current);
    return repository.reserveRateLimit('floor_warden_reply', botId, new Date(Math.floor(currentDate.getTime() / 60_000) * 60_000).toISOString(), perBotRatePerMinute);
  });
  const server = http.createServer(async (request, response) => {
    const parsed = new URL(request.url, 'http://127.0.0.1');
    const routeMatch = request.method === 'POST' ? parsed.pathname.match(REPLY_PATH) : null;
    if (!routeMatch || /%2f|%2e/i.test(routeMatch[1])) return notFound(response);
    const current = typeof now === 'function' ? now() : now;
    let allowed;
    try { allowed = await reserveIngress({ request, now: current }); } catch (error) {
      metrics?.increment('sigil_ingress_requests_total', 1, { result: 'error' });
      logger?.error?.({ event: 'reply_ingress_limit_failed', code: error?.code ?? null });
      response.writeHead(503, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ code: 'DATABASE_UNAVAILABLE', message: 'Rooms temporarily unavailable', details: {} }));
    }
    if (allowed === false || allowed?.allowed === false) {
      metrics?.increment('sigil_ingress_rate_limited_total', 1, { scope: 'ingress' });
      metrics?.increment('sigil_ingress_requests_total', 1, { result: 'rate_limited' });
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
      return response.end(JSON.stringify({ code: 'RATE_LIMITED', message: 'Too many requests', details: {} }));
    }
    const bearerHeader = request.headers.authorization;
    const bearer = typeof bearerHeader === 'string' && bearerHeader.startsWith('Bearer ') ? bearerHeader.slice(7) : '';
    let tokenMatch = null;
    if (typeof tokenMatcher === 'function') {
      try { tokenMatch = await tokenMatcher(bearer); } catch (error) {
        logger?.error?.({ event: 'reply_ingress_auth_failed', code: error?.code ?? null });
        response.writeHead(503, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ code: 'DATABASE_UNAVAILABLE', message: 'Rooms temporarily unavailable', details: {} }));
      }
      if (!tokenMatch) {
        metrics?.increment('sigil_ingress_auth_failed_total');
        const window = Math.floor(new Date(current).getTime() / 10_000);
        if (authFailures.window !== window) { authFailures.window = window; authFailures.count = 0; }
        authFailures.count += 1;
        logger?.warn?.({ event: 'reply_ingress_auth_failed', count: authFailures.count });
        metrics?.increment('sigil_ingress_requests_total', 1, { result: 'auth_failed' });
        request.resume();
        response.writeHead(401, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ code: 'UNAUTHENTICATED', message: 'Authentication required', details: {} }));
      }
      if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        metrics?.increment('sigil_ingress_requests_total', 1, { result: 'invalid_content_type' });
        response.writeHead(415, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json', details: {} }));
      }
    }
    const readBody = (req, max = bodyMaxBytes) => new Promise((resolve, reject) => {
      let raw = ''; let size = 0;
      const timer = setTimeout(() => { req.destroy(); reject(Object.assign(new Error('Request timed out'), { code: 'REQUEST_TIMEOUT' })); }, requestTimeoutMs);
      req.setEncoding('utf8');
      req.on('data', (chunk) => { size += Buffer.byteLength(chunk); if (size > max) { clearTimeout(timer); reject(Object.assign(new Error('Request body too large'), { code: 'REQUEST_TOO_LARGE' })); req.destroy(); return; } raw += chunk; });
      req.on('end', () => { clearTimeout(timer); resolve(raw); });
      req.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
    try {
      const rawBody = await readBody(request);
      let botAllowed;
      try { botAllowed = await reserveBot({ request, bearer, match: tokenMatch, botId: tokenMatch?.botId, now: current, body: rawBody }); } catch (error) {
        logger?.error?.({ event: 'reply_ingress_bot_limit_failed', code: error?.code ?? null });
        response.writeHead(503, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ code: 'DATABASE_UNAVAILABLE', message: 'Rooms temporarily unavailable', details: {} }));
      }
      if (botAllowed === false || botAllowed?.allowed === false) {
        metrics?.increment('sigil_ingress_rate_limited_total', 1, { scope: 'bot' });
        metrics?.increment('sigil_ingress_requests_total', 1, { result: 'rate_limited' });
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
        return response.end(JSON.stringify({ code: 'RATE_LIMITED', message: 'Too many requests', details: {} }));
      }
      metrics?.increment('sigil_ingress_requests_total', 1, { result: 'accepted' });
      return await gate({ request, response, requestId: request.headers['x-sigil-request-id'] ?? 'ingress', roomId: routeMatch[1], now: current, readBody: async () => rawBody });
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
