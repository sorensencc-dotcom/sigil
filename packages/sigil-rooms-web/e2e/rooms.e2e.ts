import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startRelay, type Harness } from './relayHarness';

const WEB_PORT = 5188;
let harness: Harness;
let web: ChildProcess;

test.beforeAll(async () => {
  harness = await startRelay(WEB_PORT);
  web = spawn(
    process.execPath,
    [path.resolve(import.meta.dirname, '../bin/sigil-rooms-web.mjs'), '--port', String(WEB_PORT), '--relay-url', harness.relayUrl, '--stream-url', harness.streamUrl],
    { stdio: 'ignore' },
  );
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { await fetch(`http://127.0.0.1:${WEB_PORT}/config.json`); break; } catch {
      if (Date.now() > deadline) throw new Error('web server did not start');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
});

test.afterAll(async () => {
  web?.kill();
  await harness?.stop();
});

test('paste a token, list rooms, send, see it come back live, and ack', async ({ page }) => {
  await page.goto(harness.webOrigin);
  await page.getByLabel('Bearer token').fill('not-a-real-token');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('alert')).toContainText('Token rejected');

  await page.getByLabel('Bearer token').fill(harness.humanToken);
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.getByRole('button', { name: 'e2e-room' }).click();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();

  const ackRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(`/v1/rooms/${harness.roomId}/ack`)) ackRequests.push(request.postData() ?? '');
  });

  await page.getByLabel('Message').fill('hello from the browser');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('hello from the browser')).toBeVisible();
  await expect(page.getByText('Sending…')).toHaveCount(0);

  // Prove the room.updated path: post from Node so the browser has no pending row and no
  // fetch of its own; with polling off while Live, only a socket frame can surface it.
  const pushed = `pushed from node ${crypto.randomUUID()}`;
  const response = await fetch(`${harness.relayUrl}/v1/rooms/${harness.roomId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${harness.humanToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: pushed, idempotency_key: crypto.randomUUID() }),
  });
  expect(response.ok).toBe(true);
  await expect(page.getByText(pushed)).toBeVisible({ timeout: 10_000 });

  await expect.poll(() => ackRequests.length, { timeout: 5000 }).toBeGreaterThan(0);
  expect(JSON.parse(ackRequests.at(-1)!)).toHaveProperty('up_to_room_seq');

  // The token is in sessionStorage, not localStorage.
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem('sigil.token'))).toBe(harness.humanToken);
});

test('a reload keeps the session', async ({ page }) => {
  await page.goto(harness.webOrigin);
  await page.getByLabel('Bearer token').fill(harness.humanToken);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('button', { name: 'e2e-room' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'e2e-room' })).toBeVisible();
});

test('the relay answers a preflight from an unlisted origin without CORS headers', async () => {
  const preflight = (origin: string) =>
    new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const request = http.request(`${harness.relayUrl}/v1/rooms`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } }, (response) => {
        response.resume();
        resolve(response.headers);
      });
      request.on('error', reject);
      request.end();
    });
  expect((await preflight(harness.webOrigin))['access-control-allow-origin']).toBe(harness.webOrigin);
  expect((await preflight('http://localhost:5188'))['access-control-allow-origin']).toBeUndefined();
});
