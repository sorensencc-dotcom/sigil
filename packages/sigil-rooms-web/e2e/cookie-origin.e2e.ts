import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startLoopbackTlsProxy } from '../../../sigil/integration/fixtures/loopback-tls-proxy.mjs';
import { freePort } from './relayHarness';

// Spec "Testing": under Referrer-Policy: same-origin the browser must still send
// the public Origin on the cross-document form POST to /v1/auth/oauth/github/start,
// because the relay's start check compares Origin to --public-origin. A relay stub
// behind a loopback TLS proxy records what the browser actually sent.
const webBin = path.resolve(import.meta.dirname, '../bin/sigil-rooms-web.mjs');

test('the invite form POSTs to start with Origin equal to the public origin', async ({ browser }) => {
  const proxyPort = await freePort();
  const origin = `https://127.0.0.1:${proxyPort}`;
  const seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders }> = [];
  const stub: Server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    if (req.method === 'POST' && req.url === '/v1/auth/oauth/github/start') {
      req.resume();
      res.writeHead(302, { location: '/login?error=denied' });
      return res.end();
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"code":"UNAUTHENTICATED"}');
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const staticPort = await freePort();
  const web: ChildProcess = spawn(process.execPath, [webBin, '--auth-mode', 'cookie', '--public-origin', origin, '--port', String(staticPort)], { stdio: 'ignore' });
  const proxy = await startLoopbackTlsProxy({ relayPort: (stub.address() as { port: number }).port, staticPort, port: proxyPort });
  try {
    for (let i = 0; i < 50; i += 1) {
      try { await fetch(`http://127.0.0.1:${staticPort}/config.json`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(`${origin}/invite#tok_secret`);
    await page.getByRole('button', { name: 'Continue with GitHub' }).click();
    await page.waitForURL(/\/login\?error=denied/);

    const start = seen.find((entry) => entry.method === 'POST' && entry.url === '/v1/auth/oauth/github/start');
    expect(start, 'the stub must have received the start POST').toBeTruthy();
    expect(start!.headers.origin).toBe(origin);
    expect(start!.headers.host).toBe(`127.0.0.1:${proxyPort}`);
    expect(start!.headers['sec-fetch-site']).toBe('same-origin');
    // A browser form cannot send the CSRF header; start relies on Origin alone.
    expect(start!.headers['x-sigil-csrf']).toBeUndefined();
    expect(start!.headers['content-type']).toContain('application/x-www-form-urlencoded');
    // The token stays out of the URL: it never reached the server as a query or fragment.
    expect(seen.some((entry) => entry.url.includes('tok_secret'))).toBe(false);
    await context.close();
  } finally {
    await proxy.close();
    web.kill();
    await new Promise<void>((resolve) => { stub.closeAllConnections(); stub.close(() => resolve()); });
  }
});
