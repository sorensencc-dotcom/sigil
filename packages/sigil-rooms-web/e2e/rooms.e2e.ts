import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { freePort, startRelay, type Harness } from './relayHarness';

// Locator rules (src/e2eLocators.spec.ts enforces them in the pre-push web gate):
// message text is looked up inside the timeline or thread, never page-wide, because the sidebar
// preview and reply previews repeat it; buttons match their exact name, because rows and controls
// sit next to others whose names contain theirs (Pin e2e-room, Send in the thread).
const timeline = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true });
const roomButton = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

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
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Token rejected');

  await page.getByLabel('Bearer token').fill(harness.humanToken);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await roomButton(page, 'e2e-room').click();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();

  const ackRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(`/v1/rooms/${harness.roomId}/ack`)) ackRequests.push(request.postData() ?? '');
  });

  await page.getByLabel('Message', { exact: true }).fill('hello from the browser');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(timeline(page).getByText('hello from the browser', { exact: true })).toBeVisible();
  await expect(timeline(page).getByText('Sending…')).toHaveCount(0);

  // Prove the room.updated path: post from Node so the browser has no pending row and no
  // fetch of its own; with polling off while Live, only a socket frame can surface it.
  const pushed = `pushed from node ${crypto.randomUUID()}`;
  const response = await fetch(`${harness.relayUrl}/v1/rooms/${harness.roomId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${harness.humanToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: pushed, idempotency_key: crypto.randomUUID() }),
  });
  expect(response.ok).toBe(true);
  await expect(timeline(page).getByText(pushed, { exact: true })).toBeVisible({ timeout: 10_000 });

  await expect.poll(() => ackRequests.length, { timeout: 5000 }).toBeGreaterThan(0);
  expect(JSON.parse(ackRequests.at(-1)!)).toHaveProperty('up_to_room_seq');

  // The token is in sessionStorage, not localStorage. localStorage also holds the browser's room watermark.
  expect(await page.evaluate(() => localStorage.getItem('sigil.token'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('sigil.token'))).toBe(harness.humanToken);
});

test('a reload keeps the session', async ({ page }) => {
  await page.goto(harness.webOrigin);
  await page.getByLabel('Bearer token').fill(harness.humanToken);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(roomButton(page, 'e2e-room')).toBeVisible();
  await page.reload();
  await expect(roomButton(page, 'e2e-room')).toBeVisible();
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
  await page.getByRole('button', { name: 'Connect', exact: true }).click();

  // A fresh room keeps the shared e2e-room name intact for the other tests.
  await page.getByLabel('New room name').fill('manage-me');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'manage-me' })).toBeVisible();

  // The first send teaches the client its own endpoint ID, which unlocks rename and the mode controls.
  await page.getByLabel('Message', { exact: true }).fill('thread root');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(timeline(page).getByText('thread root', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rename room', exact: true })).toBeVisible();

  // Thread: the reply shows in the panel, and the main timeline shows it only as a preview under the
  // root, never as a row of its own.
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  const thread = page.getByRole('complementary', { name: 'Thread' });
  await thread.getByLabel('Reply in thread').fill('a threaded reply');
  await thread.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(thread.getByText('a threaded reply', { exact: true })).toBeVisible();
  await expect(timeline(page).locator('.reply-preview-text', { hasText: 'a threaded reply' })).toBeVisible();
  await expect(timeline(page).locator('.text', { hasText: 'a threaded reply' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '1 reply', exact: true })).toBeVisible();
  await thread.getByRole('button', { name: 'Close', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);

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
  await page.getByRole('button', { name: 'Roster', exact: true }).click();
  const select = page.getByLabel(`Wake rule for ${harness.agentEndpointId}`);
  await expect(select).toHaveValue('joins');
  await select.selectOption('mentions_only');
  await expect(select).toHaveValue('mentions_only');
  const members = (await (await fetch(`${harness.relayUrl}/v1/rooms/${roomId}/members`, { headers: { authorization: `Bearer ${harness.humanToken}` } })).json()) as { items: Array<{ endpoint_id: string; response_mode: string | null }> };
  expect(members.items.find((member) => member.endpoint_id === harness.agentEndpointId)?.response_mode).toBe('mentions_only');

  // Rename: the sidebar follows.
  await page.getByRole('button', { name: 'Rename room', exact: true }).click();
  await page.getByLabel('Room name', { exact: true }).fill('renamed-room');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(roomButton(page, 'renamed-room')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'renamed-room' })).toBeVisible();
});
