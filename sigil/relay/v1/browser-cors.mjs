// Exact match on scheme, host, and port. Never reflects an arbitrary Origin.
export function isAllowedOrigin(origin, allowedOrigins) {
  return typeof origin === 'string' && allowedOrigins.includes(origin);
}

const BROWSER_ROUTES = [
  /^\/v1\/rooms(\/.*)?$/,
];
export const isBrowserRoute = (pathname) => BROWSER_ROUTES.some((pattern) => pattern.test(pathname));

// Call before authentication: a browser preflight carries no credentials.
// Returns 'preflight' when the response is already finished.
export function applyBrowserCors(request, response, allowedOrigins) {
  const origin = request.headers?.origin;
  if (origin === undefined) return 'continue';
  const allowed = isAllowedOrigin(origin, allowedOrigins);
  if (request.method === 'OPTIONS' && request.headers['access-control-request-method']) {
    if (!allowed) { response.writeHead(403, { vary: 'Origin' }); response.end(); return 'preflight'; }
    response.writeHead(204, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '600',
      vary: 'Origin',
    });
    response.end();
    return 'preflight';
  }
  if (allowed) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
  }
  return 'continue';
}
