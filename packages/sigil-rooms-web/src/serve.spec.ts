import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain .mjs without types
import { createWebServer, defaultStreamUrl } from '../serve/server.mjs';

let server: import('node:http').Server;
let base: string;

beforeEach(async () => {
  const dist = mkdtempSync(path.join(tmpdir(), 'web-dist-'));
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>x</title>');
  mkdirSync(path.join(dist, 'assets'));
  writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
  server = createWebServer({ distDir: dist, relayUrl: 'http://127.0.0.1:7777', streamUrl: 'ws://127.0.0.1:7778' });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks(); await new Promise((resolve) => server.close(resolve)); });

describe('web server', () => {
  it('serves config.json with the relay and stream URLs, uncached', async () => {
    const res = await fetch(`${base}/config.json`);
    expect(await res.json()).toEqual({ relayUrl: 'http://127.0.0.1:7777', streamUrl: 'ws://127.0.0.1:7778' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('sets a CSP that allows only self, the relay, and the stream', async () => {
    const res = await fetch(`${base}/`);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' http://127.0.0.1:7777 ws://127.0.0.1:7778");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves assets with a content type and falls back to index.html for app routes', async () => {
    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.headers.get('content-type')).toContain('javascript');
    const route = await fetch(`${base}/rooms/room_1`);
    expect(await route.text()).toContain('<title>x</title>');
  });

  it('answers 400 to a malformed escape instead of crashing', async () => {
    const res = await fetch(`${base}/%E0%A4%A`);
    expect([400, 404]).toContain(res.status);
    const after = await fetch(`${base}/config.json`);
    expect(after.status).toBe(200);
  });

  it('refuses path traversal and non-GET methods', async () => {
    const traversal = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
    expect([403, 404]).toContain(traversal.status);
    const post = await fetch(`${base}/`, { method: 'POST' });
    expect(post.status).toBe(405);
  });

  it('defaultStreamUrl adds one to the relay port', () => {
    expect(defaultStreamUrl('http://127.0.0.1:7777')).toBe('ws://127.0.0.1:7778');
    expect(defaultStreamUrl('https://relay.example:8443')).toBe('wss://relay.example:8444');
  });

  it('survives a file stream error and keeps serving', async () => {
    vi.spyOn(fs, 'createReadStream').mockImplementationOnce((() => {
      const broken = new Readable({ read() {} });
      setImmediate(() => broken.destroy(new Error('EACCES')));
      return broken;
    }) as never);
    await fetch(`${base}/assets/app.js`).then((r) => r.text()).catch(() => undefined);
    const after = await fetch(`${base}/config.json`);
    expect(after.status).toBe(200);
  });
});
