import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPollingWebhookQueue,
  signSvixWebhook,
  verifySvixSignature,
} from './agentmail-polling-webhook-queue.mjs';

const secret = `whsec_${crypto.randomBytes(32).toString('base64')}`;
const nowMs = Date.parse('2026-11-25T12:00:00Z');

function signedEvent(id, payload = { ok: true }, timestamp = Math.floor(nowMs / 1000)) {
  const rawBody = JSON.stringify(payload);
  return {
    svixId: id,
    svixTimestamp: String(timestamp),
    svixSignature: signSvixWebhook({ svixId: id, svixTimestamp: String(timestamp), rawBody, secret }),
    rawBody,
    payload,
  };
}

test('verifies a valid signature and accepts a matching signature among multiple v1 values', () => {
  const event = signedEvent('evt_valid');
  const result = verifySvixSignature({
    ...event,
    svixSignature: `v1,${crypto.randomBytes(32).toString('base64')} ${event.svixSignature}`,
    secret,
    nowMs,
  });
  assert.deepEqual(result, { valid: true });
});

test('rejects a tampered body', () => {
  const event = signedEvent('evt_tampered');
  const result = verifySvixSignature({ ...event, rawBody: `${event.rawBody}!`, secret, nowMs });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'SIGNATURE_MISMATCH');
});

test('rejects timestamps outside the replay window in either direction', () => {
  for (const timestamp of [Math.floor(nowMs / 1000) - 301, Math.floor(nowMs / 1000) + 301]) {
    const event = signedEvent('evt_stale', { timestamp }, timestamp);
    const result = verifySvixSignature({ ...event, secret, nowMs });
    assert.equal(result.reason, 'TIMESTAMP_OUT_OF_TOLERANCE');
  }
});

test('deduplicates polling events by event ID', async () => {
  const delivered = [];
  const queue = createPollingWebhookQueue({
    secret,
    pollBatch: async () => ({ events: [signedEvent('evt_duplicate'), signedEvent('evt_duplicate')] }),
  });
  const result = await queue.pollOnce({ onEvent: event => delivered.push(event), nowMs });
  assert.equal(delivered.length, 1);
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.duplicates, ['evt_duplicate']);
});

test('rejects malformed signature headers', () => {
  const event = signedEvent('evt_malformed');
  for (const svixSignature of [`${event.svixSignature} v1,not*base64`, 'v2,abc', 'garbage', 'v1,']) {
    const result = verifySvixSignature({ ...event, svixSignature, secret, nowMs });
    assert.deepEqual(result, { valid: false, reason: 'MALFORMED_SIGNATURE' }, svixSignature);
  }
});

test('ignores tokens for other signature versions', () => {
  const event = signedEvent('evt_future_version');
  const result = verifySvixSignature({ ...event, svixSignature: `v2,abc ${event.svixSignature}`, secret, nowMs });
  assert.deepEqual(result, { valid: true });
});
