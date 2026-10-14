import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
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

describe('cookie auth mode', () => {
  let cookieServer: import('node:http').Server;
  let cookieBase: string;
  let dist: string;
  beforeEach(async () => {
    dist = mkdtempSync(path.join(tmpdir(), 'web-dist-cookie-'));
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>x</title>');
    cookieServer = createWebServer({ distDir: dist, authMode: 'cookie', publicOrigin: 'https://rooms.test' });
    await new Promise<void>((resolve) => cookieServer.listen(0, '127.0.0.1', resolve));
    cookieBase = `http://127.0.0.1:${(cookieServer.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise((resolve) => cookieServer.close(resolve)); });

  it('serves config.json with only authMode', async () => {
    const res = await fetch(`${cookieBase}/config.json`);
    expect(await res.json()).toEqual({ authMode: 'cookie' });
  });

  it('limits connect-src to self and the public origin websocket host', async () => {
    const csp = (await fetch(`${cookieBase}/`)).headers.get('content-security-policy')!;
    expect(csp).toContain("connect-src 'self' wss://rooms.test;");
    expect(csp).not.toContain('127.0.0.1');
  });

  it('serves index.html for /login and /invite with same-origin referrer policy', async () => {
    for (const route of ['/', '/login', '/invite', '/index.html']) {
      const res = await fetch(`${cookieBase}${route}`);
      expect(await res.text()).toContain('<title>x</title>');
      expect(res.headers.get('referrer-policy')).toBe('same-origin');
    }
  });

  it('still rejects POST', async () => {
    expect((await fetch(`${cookieBase}/login`, { method: 'POST' })).status).toBe(405);
  });

  it('rejects a non-https public origin and a missing one', () => {
    expect(() => createWebServer({ distDir: dist, authMode: 'cookie' })).toThrow(/public-origin/);
    expect(() => createWebServer({ distDir: dist, authMode: 'cookie', publicOrigin: 'http://rooms.test' })).toThrow(/public-origin/);
    expect(() => createWebServer({ distDir: dist, authMode: 'bogus', relayUrl: 'http://a', streamUrl: 'ws://a' })).toThrow(/auth-mode/);
  });
});

describe('token mode headers', () => {
  it('sends same-origin referrer policy on index.html, never no-referrer', async () => {
    for (const route of ['/', '/login', '/invite']) {
      const res = await fetch(`${base}${route}`);
      expect(res.headers.get('referrer-policy')).toBe('same-origin');
    }
    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.headers.get('referrer-policy')).not.toBe('no-referrer');
  });
});

describe('sigil-rooms-web CLI flags', () => {
  const bin = path.resolve(__dirname, '../bin/sigil-rooms-web.mjs');
  const run = (args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 10000 });
  it('exits non-zero naming --public-origin when cookie mode lacks it', () => {
    const result = run(['--auth-mode', 'cookie']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--public-origin');
  });
  it('exits non-zero naming --auth-mode for an unknown mode', () => {
    const result = run(['--auth-mode', 'bogus']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--auth-mode');
  });
  it('exits non-zero naming --public-origin for a non-https origin', () => {
    const result = run(['--auth-mode', 'cookie', '--public-origin', 'http://rooms.test']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--public-origin');
  });
});
