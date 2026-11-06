/**
 * TRM TDD Test Contract: act-02-polling-webhook-queue-agentmail
 * Intent: Polling Webhook Queue Agentmail
 * Target: sigil
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  signSvixWebhook,
  verifySvixSignature,
  createPollingWebhookQueue
} from '../sigil/ingress/v1/agentmail-polling-webhook-queue.mjs';

test('act-02: verifies Svix HMAC signatures and enforces idempotent deduplication on polled batches', async () => {
  const fixtureSignKey = `whsec_${Buffer.from('test-fixture-svix-webhook').toString('base64')}`;
  const nowMs = 1793980000 * 1000;
  const ts = String(1793980000);

  const body1 = JSON.stringify({ type: 'message.received', messageId: 'msg_101' });
  const sig1 = signSvixWebhook({ svixId: 'msg_evt_1', svixTimestamp: ts, rawBody: body1, secret: fixtureSignKey });

  const body2 = JSON.stringify({ type: 'message.received', messageId: 'msg_102' });
  const badSig = 'v1,aW52YWxpZF9zaWduYXR1cmU=';

  const batches = [
    {
      events: [
        { svixId: 'msg_evt_1', svixTimestamp: ts, svixSignature: sig1, rawBody: body1 },
        { svixId: 'msg_evt_1', svixTimestamp: ts, svixSignature: sig1, rawBody: body1 }, // duplicate in same batch
        { svixId: 'msg_evt_2', svixTimestamp: ts, svixSignature: badSig, rawBody: body2 } // tampered signature
      ],
      nextCursor: 'cur_page_2'
    },
    {
      events: [
        { svixId: 'msg_evt_1', svixTimestamp: ts, svixSignature: sig1, rawBody: body1 } // redelivered across batch
      ],
      nextCursor: 'cur_page_3'
    }
  ];

  let callIdx = 0;
  const queue = createPollingWebhookQueue({
    secret: fixtureSignKey,
    verifySignature: true,
    pollBatch: async () => batches[callIdx++]
  });

  const firstPoll = await queue.pollOnce({ nowMs });
  assert.equal(firstPoll.accepted.length, 1);
  assert.equal(firstPoll.accepted[0].id, 'msg_evt_1');
  assert.deepEqual(firstPoll.duplicates, ['msg_evt_1']);
  assert.deepEqual(firstPoll.rejected, [{ id: 'msg_evt_2', reason: 'SIGNATURE_MISMATCH' }]);
  assert.equal(firstPoll.cursor, 'cur_page_2');

  const secondPoll = await queue.pollOnce({ nowMs });
  assert.equal(secondPoll.accepted.length, 0);
  assert.deepEqual(secondPoll.duplicates, ['msg_evt_1']);
  assert.equal(secondPoll.cursor, 'cur_page_3');

  // Out-of-window timestamp check
  const expiredCheck = verifySvixSignature({
    svixId: 'msg_evt_1',
    svixTimestamp: String(1793980000 - 900),
    svixSignature: sig1,
    rawBody: body1,
    secret: fixtureSignKey,
    nowMs
  });
  assert.equal(expiredCheck.valid, false);
  assert.equal(expiredCheck.reason, 'TIMESTAMP_OUT_OF_TOLERANCE');
});
