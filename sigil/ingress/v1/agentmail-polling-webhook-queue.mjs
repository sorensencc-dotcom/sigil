/**
 * sigil/ingress/v1/agentmail-polling-webhook-queue.mjs
 *
 * Svix-Backed Polling Webhook Consumer Queue (act-02).
 * Enables sandboxed background agents lacking public HTTP endpoints or
 * long-lived WebSocket connections to ingest AgentMail/Svix events via
 * outbound polling with HMAC verification and idempotent deduplication.
 */

import crypto from 'node:crypto';

function decodeSvixSecret(secret) {
  const raw = String(secret || '').trim();
  if (!raw) throw Object.assign(new Error('Svix webhook secret is required'), { code: 'SVIX_SECRET_MISSING' });
  if (raw.startsWith('whsec_')) {
    return Buffer.from(raw.slice('whsec_'.length), 'base64');
  }
  return Buffer.from(raw, 'utf8');
}

/**
 * Computes a Svix v1 signature string ("v1,<base64>") for a given event.
 */
export function signSvixWebhook({ svixId, svixTimestamp, rawBody, secret }) {
  const keyBuf = decodeSvixSecret(secret);
  const toSign = `${svixId}.${svixTimestamp}.${rawBody}`;
  const sigBase64 = crypto.createHmac('sha256', keyBuf).update(toSign, 'utf8').digest('base64');
  return `v1,${sigBase64}`;
}

/**
 * Verifies a Svix webhook signature and timestamp replay window.
 */
export function verifySvixSignature({
  svixId,
  svixTimestamp,
  svixSignature,
  rawBody,
  secret,
  toleranceSeconds = 300,
  nowMs = Date.now()
}) {
  if (!svixId || !svixTimestamp || !svixSignature || typeof rawBody !== 'string') {
    return { valid: false, reason: 'MISSING_SVIX_HEADERS' };
  }

  const tsSec = Number(svixTimestamp);
  if (!Number.isFinite(tsSec)) {
    return { valid: false, reason: 'INVALID_TIMESTAMP' };
  }

  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - tsSec) > toleranceSeconds) {
    return { valid: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' };
  }

  const expectedFull = signSvixWebhook({ svixId, svixTimestamp, rawBody, secret });
  const expectedB64 = expectedFull.slice(3);
  const expBuf = Buffer.from(expectedB64, 'base64');

  const candidates = String(svixSignature)
    .split(/\s+/)
    .map(part => part.trim())
    .filter(part => part.startsWith('v1,'))
    .map(part => part.slice(3));

  for (const cand of candidates) {
    const candBuf = Buffer.from(cand, 'base64');
    if (candBuf.length === expBuf.length && crypto.timingSafeEqual(candBuf, expBuf)) {
      return { valid: true };
    }
  }

  return { valid: false, reason: 'SIGNATURE_MISMATCH' };
}

/**
 * Creates a sandboxed outbound polling consumer queue with idempotent deduplication.
 */
export function createPollingWebhookQueue({
  pollBatch,
  secret = null,
  verifySignature = Boolean(secret),
  maxSeenIds = 1000,
  toleranceSeconds = 300
} = {}) {
  if (typeof pollBatch !== 'function') {
    throw Object.assign(new Error('pollBatch function is required'), { code: 'POLL_BATCH_REQUIRED' });
  }

  let cursor = null;
  const seenIds = new Set();
  const seenOrder = [];

  const rememberId = (id) => {
    seenIds.add(id);
    seenOrder.push(id);
    while (seenOrder.length > maxSeenIds) {
      const oldest = seenOrder.shift();
      seenIds.delete(oldest);
    }
  };

  return {
    get cursor() {
      return cursor;
    },
    get seenCount() {
      return seenIds.size;
    },
    async pollOnce({ onEvent, nowMs = Date.now() } = {}) {
      const batch = await pollBatch({ cursor });
      const events = Array.isArray(batch?.events) ? batch.events : [];
      const accepted = [];
      const duplicates = [];
      const rejected = [];

      for (const evt of events) {
        const eventId = String(evt?.svixId || evt?.id || '').trim();
        if (!eventId) {
          rejected.push({ id: null, reason: 'MISSING_EVENT_ID' });
          continue;
        }

        // Idempotent deduplication for at-least-once consumer polling
        if (seenIds.has(eventId)) {
          duplicates.push(eventId);
          continue;
        }

        const rawBody = typeof evt.rawBody === 'string'
          ? evt.rawBody
          : JSON.stringify(evt.payload ?? {});

        if (verifySignature) {
          const check = verifySvixSignature({
            svixId: eventId,
            svixTimestamp: evt.svixTimestamp,
            svixSignature: evt.svixSignature,
            rawBody,
            secret,
            toleranceSeconds,
            nowMs
          });
          if (!check.valid) {
            rejected.push({ id: eventId, reason: check.reason });
            continue;
          }
        }

        rememberId(eventId);
        const parsedPayload = evt.payload ?? JSON.parse(rawBody);
        if (typeof onEvent === 'function') {
          await onEvent({ id: eventId, payload: parsedPayload });
        }
        accepted.push({ id: eventId, payload: parsedPayload });
      }

      if (batch?.nextCursor !== undefined) {
        cursor = batch.nextCursor;
      }

      return {
        accepted,
        duplicates,
        rejected,
        cursor
      };
    }
  };
}
