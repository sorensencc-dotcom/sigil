// Loopback TLS proxy for the one-origin topology: /v1/* (including WebSocket
// upgrades) goes to the relay's public listener, everything else to the static
// server. Request headers pass through untouched, so Host, Origin, and cookies
// arrive upstream exactly as the client sent them. Test-only: it reuses the
// checked-in self-signed 127.0.0.1 certificate that sigil/cli already ships.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const FIXTURES = new URL('../../cli/fixtures/', import.meta.url);
export const TLS_CERT = fs.readFileSync(fileURLToPath(new URL('self-signed-cert.pem', FIXTURES)));
const TLS_KEY = fs.readFileSync(fileURLToPath(new URL('self-signed-key.pem', FIXTURES)));

const isRelayPath = (url) => url === '/v1' || url.startsWith('/v1/') || url.startsWith('/v1?');

export async function startLoopbackTlsProxy({ relayPort, staticPort, port = 0 }) {
  const server = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (request, response) => {
    const target = isRelayPath(request.url) ? relayPort : staticPort;
    const upstream = http.request({ host: '127.0.0.1', port: target, method: request.method, path: request.url, headers: request.headers }, (res) => {
      response.writeHead(res.statusCode, res.rawHeaders);
      res.pipe(response);
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  const spliced = new Set();
  // Raw TCP splice for upgrades: forwards the original request head verbatim.
  server.on('upgrade', (request, socket, head) => {
    if (!isRelayPath(request.url)) { socket.destroy(); return; }
    const upstream = net.connect(relayPort, '127.0.0.1', () => {
      spliced.add(socket); spliced.add(upstream);
      let raw = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
      for (let i = 0; i < request.rawHeaders.length; i += 2) raw += `${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`;
      upstream.write(`${raw}\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = server.address().port;
  return {
    port: actual,
    origin: `https://127.0.0.1:${actual}`,
    close: () => new Promise((resolve) => { for (const s of spliced) s.destroy(); server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
