import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPollingWebhookQueue, verifySvixSignature } from './agentmail-polling-webhook-queue.mjs';

const fixtureSignKey = `whsec_${Buffer.from('polling-fixture-signing-key').toString('base64')}`;
const fixtureBody = JSON.stringify({ event_type: 'message.received', event_id: 'evt_1' });
const fixtureNow = 1_700_000_000_000;

function signedHeader({ id = 'msg_1', timestamp = Math.floor(fixtureNow / 1000), body = fixtureBody } = {}) {
  const secret = Buffer.from(fixtureSignKey.slice('whsec_'.length), 'base64');
  const digest = crypto.createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${digest}` };
}

test('verifySvixSignature validates Svix v1 HMAC-SHA256 and rejects replayed timestamps', () => {
  assert.equal(verifySvixSignature({ body: fixtureBody, secret: fixtureSignKey, headers: signedHeader(), now: fixtureNow }), true);
  assert.throws(() => verifySvixSignature({ body: fixtureBody, secret: fixtureSignKey, headers: signedHeader({ timestamp: 1 }), now: fixtureNow }), { code: 'WEBHOOK_REPLAY' });
  assert.throws(() => verifySvixSignature({ body: fixtureBody, secret: fixtureSignKey, headers: { ...signedHeader(), 'svix-signature': 'v1,invalid' }, now: fixtureNow }), { code: 'WEBHOOK_SIGNATURE_INVALID' });
});

test('polling queue consumes each event ID once and exposes lifecycle controls', async () => {
  const batches = [[{ id: 'evt_1' }, { id: 'evt_2' }], [{ id: 'evt_2' }, { id: 'evt_3' }]];
  const consumed = [];
  const queue = createPollingWebhookQueue({ poll: async () => batches.shift() ?? [], consume: async (event) => consumed.push(event.id) });
  assert.deepEqual(await queue.pollNow(), { fetched: 2, consumed: 2, duplicates: 0 });
  assert.deepEqual(await queue.pollNow(), { fetched: 2, consumed: 1, duplicates: 1 });
  assert.deepEqual(consumed, ['evt_1', 'evt_2', 'evt_3']);
  queue.start();
  queue.stop();
});

test('polling queue does not deduplicate an event whose consumer failed', async () => {
  let attempts = 0;
  const queue = createPollingWebhookQueue({ poll: async () => [{ event_id: 'evt_retry' }], consume: async () => { if (++attempts === 1) throw new Error('temporary'); } });
  await assert.rejects(queue.pollNow(), /temporary/);
  assert.deepEqual(await queue.pollNow(), { fetched: 1, consumed: 1, duplicates: 0 });
  assert.equal(attempts, 2);
});
