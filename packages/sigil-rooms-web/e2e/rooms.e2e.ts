import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { freePort, startRelay, type Harness } from './relayHarness';

let WEB_PORT = 0;
let harness: Harness;
let web: ChildProcess;

test.beforeAll(async () => {
  WEB_PORT = await freePort();
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
  await page.getByRole('button', { name: 'e2e-room', exact: true }).click();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();

  const ackRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(`/v1/rooms/${harness.roomId}/ack`)) ackRequests.push(request.postData() ?? '');
  });

  await page.getByLabel('Message', { exact: true }).fill('hello from the browser');
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
  await expect(page.getByRole('button', { name: 'e2e-room', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'e2e-room', exact: true })).toBeVisible();
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
  expect((await preflight(`http://localhost:${WEB_PORT}`))['access-control-allow-origin']).toBeUndefined();
});

test('rename, thread reply, Stop, and a response-mode change', async ({ page }) => {
  await page.goto(harness.webOrigin);
  await page.getByLabel('Bearer token').fill(harness.humanToken);
  await page.getByRole('button', { name: 'Connect' }).click();

  // A fresh room keeps the shared e2e-room name intact for the other tests.
  await page.getByLabel('New room name').fill('manage-me');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('heading', { name: 'manage-me' })).toBeVisible();

  // The first send teaches the client its own endpoint ID, which unlocks rename and the mode controls.
  await page.getByLabel('Message', { exact: true }).fill('thread root');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('thread root')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rename room' })).toBeVisible();

  // Thread: the reply shows in the panel and not in the main timeline.
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  const thread = page.getByRole('complementary', { name: 'Thread' });
  await thread.getByLabel('Reply in thread').fill('a threaded reply');
  await thread.getByRole('button', { name: 'Send' }).click();
  await expect(thread.getByText('a threaded reply')).toBeVisible();
  await expect(page.getByLabel('Messages').getByText('a threaded reply')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '1 reply' })).toBeVisible();
  await thread.getByRole('button', { name: 'Close' }).click();

  // Stop with nothing running answers 200 and leaves the button usable.
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);

  // Response mode: add the agent from Node, then change its mode in the roster.
  const roomsResponse = await fetch(`${harness.relayUrl}/v1/rooms`, { headers: { authorization: `Bearer ${harness.humanToken}` } });
  const { items } = (await roomsResponse.json()) as { items: Array<{ conversation_id: string; name: string }> };
  const roomId = items.find((room) => room.name === 'manage-me')!.conversation_id;
  const added = await fetch(`${harness.relayUrl}/v1/rooms/${roomId}/members`, {
    method: 'POST',
    headers: { authorization: `Bearer ${harness.humanToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint_id: harness.agentEndpointId, response_mode: 'joins' }),
  });
  expect(added.status).toBe(201);
  await page.getByRole('button', { name: 'Roster' }).click();
  const select = page.getByLabel(`Response mode for ${harness.agentEndpointId}`);
  await expect(select).toHaveValue('joins');
  await select.selectOption('mentions_only');
  await expect(select).toHaveValue('mentions_only');
  const members = (await (await fetch(`${harness.relayUrl}/v1/rooms/${roomId}/members`, { headers: { authorization: `Bearer ${harness.humanToken}` } })).json()) as { items: Array<{ endpoint_id: string; response_mode: string | null }> };
  expect(members.items.find((member) => member.endpoint_id === harness.agentEndpointId)?.response_mode).toBe('mentions_only');

  // Rename: the sidebar follows.
  await page.getByRole('button', { name: 'Rename room' }).click();
  await page.getByLabel('Room name', { exact: true }).fill('renamed-room');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'renamed-room', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'renamed-room' })).toBeVisible();
});
