import http from 'node:http';
import crypto from 'node:crypto';
import { checkCookieCsrf } from './csrf.mjs';

export const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
export const notFound = (response) => json(response, 404, { code: 'NOT_FOUND', message: 'Not found', details: {} });

// Returns the matched route name or null. Matches exact segments on the parsed path.
export function matchPublicRoute(method, rawUrl) {
  if (/%2f|%5c|\\/i.test(rawUrl.split('?')[0])) return null;
  let pathname;
  try { pathname = new URL(rawUrl, 'http://x').pathname; } catch { return null; }
  const segments = pathname.split('/').slice(1);
  if (segments.some((s, i) => s === '..' || s === '.' || (s === '' && i !== segments.length - 1))) return null;
  const [a, b, c, d, e] = segments;
  if (a !== 'v1') return null;
  if (b === 'auth' && c === 'oauth' && d && e === 'start' && segments.length === 5) return method === 'POST' ? 'oauth_public' : null;
  if (b === 'auth' && c === 'oauth' && d && e === 'callback' && segments.length === 5) return method === 'GET' ? 'oauth_public' : null;
  if (b === 'auth' && c === 'me' && segments.length === 3) return method === 'GET' ? 'oauth_session' : null;
  if (b === 'auth' && c === 'logout' && segments.length === 3) return method === 'POST' ? 'oauth_session' : null;
  if (b === 'me' && c === 'contacts' && segments.length === 3) return method === 'GET' || method === 'POST' ? 'contacts' : null;
  if (b === 'me' && c === 'contacts' && d && segments.length === 4) return method === 'PUT' || method === 'DELETE' ? 'contacts' : null;
  if (b === 'rooms') return method === 'GET' || method === 'POST' ? 'rooms' : null;
  if (b === 'mentions' && segments.length === 2) return method === 'GET' ? 'rooms' : null;
  return null;
}

export function createPublicListener({ publicOrigin, authenticateCookie, handleOAuthPublicRoute, handleOAuthSessionRoute, handleRoomRoute, handleContactsRoute, roomRouteContext = () => ({}), logger = null }) {
  return http.createServer(async (request, response) => {
    try {
      const route = matchPublicRoute(request.method, request.url);
      if (!route) return notFound(response);
      const parsedUrl = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
      if (route === 'oauth_public') {
        if (await handleOAuthPublicRoute({ request, response, parsedUrl })) return;
        return notFound(response);
      }
      const principal = await authenticateCookie(request);
      if (!principal) return json(response, 401, { code: 'UNAUTHENTICATED', message: 'Authentication required', details: {} });
      if (!checkCookieCsrf(request, publicOrigin)) return json(response, 403, { code: 'CSRF_REJECTED', message: 'Forbidden', details: {} });
      const handler = route === 'oauth_session' ? handleOAuthSessionRoute : route === 'contacts' ? handleContactsRoute : handleRoomRoute;
      if (await handler({ request, response, parsedUrl, principal, requestId: crypto.randomUUID(), ...roomRouteContext() })) return;
      return notFound(response);
    } catch (error) {
      logger?.error?.({ event: 'public_listener.failed', error: error?.message });
      if (!response.headersSent) json(response, 500, { code: 'INTERNAL', message: 'Internal error', details: {} });
      else response.end();
    }
  });
}
