import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

export function defaultStreamUrl(relayUrl) {
  const url = new URL(relayUrl);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80)) + 1;
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${url.hostname}:${port}`;
}

export function createWebServer({ distDir, relayUrl, streamUrl, authMode = 'token', publicOrigin }) {
  if (authMode !== 'token' && authMode !== 'cookie') {
    throw new Error(`--auth-mode must be "cookie" or "token", got "${authMode}"`);
  }
  let connectSrc = `'self' ${relayUrl} ${streamUrl}`;
  if (authMode === 'cookie') {
    let origin;
    try {
      origin = new URL(publicOrigin);
    } catch {
      throw new Error('--public-origin is required with --auth-mode cookie and must be an https URL');
    }
    if (origin.protocol !== 'https:') throw new Error('--public-origin must be an https URL');
    connectSrc = `'self' wss://${origin.host}`;
  }
  const root = path.resolve(distDir);
  const csp = [
    "default-src 'self'",
    `connect-src ${connectSrc}`,
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "frame-ancestors 'none'",
  ].join('; ');

  function headers(extra = {}) {
    return { 'content-security-policy': csp, 'x-content-type-options': 'nosniff', ...extra };
  }

  return http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, headers({ allow: 'GET, HEAD' }));
      return response.end();
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400, headers());
      return response.end();
    }
    if (pathname === '/config.json') {
      response.writeHead(200, headers({ 'content-type': TYPES['.json'], 'cache-control': 'no-store' }));
      return response.end(JSON.stringify(authMode === 'cookie' ? { authMode } : { relayUrl, streamUrl }));
    }
    let target = path.resolve(root, `.${pathname}`);
    if (target !== root && !target.startsWith(root + path.sep)) {
      response.writeHead(403, headers());
      return response.end();
    }
    if (!path.extname(target) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      if (path.extname(target)) {
        response.writeHead(404, headers());
        return response.end();
      }
      target = path.join(root, 'index.html');
    }
    const type = TYPES[path.extname(target)] ?? 'application/octet-stream';
    const extra = { 'content-type': type };
    if (target === path.join(root, 'index.html')) extra['referrer-policy'] = 'same-origin';
    response.writeHead(200, headers(extra));
    if (request.method === 'HEAD') return response.end();
    const stream = fs.createReadStream(target);
    stream.on('error', () => response.destroy());
    pipeline(stream, response, () => {});
  });
}
