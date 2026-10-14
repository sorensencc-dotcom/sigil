const SAFE = new Set(['GET', 'HEAD']);

export function checkCookieCsrf(request, publicOrigin) {
  if (SAFE.has(request.method)) return true;
  return request.headers.origin === publicOrigin && request.headers['x-sigil-csrf'] === '1';
}

export function checkStartOrigin(request, publicOrigin) {
  if (request.headers.origin !== publicOrigin) return false;
  const site = request.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin';
}
