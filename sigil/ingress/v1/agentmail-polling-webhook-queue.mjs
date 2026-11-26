import crypto from 'node:crypto';

const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000;

function failure(code, message) {
  throw Object.assign(new Error(message), { code });
}

function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

function requiredHeader(headers, name) {
  const value = headerValue(headers, name);
  if (typeof value !== 'string' || value.trim() === '') failure('WEBHOOK_SIGNATURE_INVALID', `Missing ${name} header`);
  return value;
}

export function verifySvixSignature({ body, secret, headers, now = Date.now(), replayWindowMs = DEFAULT_REPLAY_WINDOW_MS } = {}) {
  if (typeof body !== 'string' && !Buffer.isBuffer(body)) failure('WEBHOOK_SIGNATURE_INVALID', 'Webhook body is required');
  if (typeof secret !== 'string' || !secret.startsWith('whsec_')) failure('WEBHOOK_SIGNATURE_INVALID', 'Svix signing secret is invalid');
  const id = requiredHeader(headers, 'svix-id');
  const timestamp = requiredHeader(headers, 'svix-timestamp');
  const signatureHeader = requiredHeader(headers, 'svix-signature');
  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > replayWindowMs) failure('WEBHOOK_REPLAY', 'Svix webhook timestamp is outside the replay window');
  let key;
  try { key = Buffer.from(secret.slice('whsec_'.length), 'base64'); } catch { failure('WEBHOOK_SIGNATURE_INVALID', 'Svix signing secret is invalid'); }
  const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest('base64');
  const valid = signatureHeader.split(' ').some((entry) => {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) return false;
    const actual = Buffer.from(value);
    const expectedBytes = Buffer.from(expected);
    return actual.length === expectedBytes.length && crypto.timingSafeEqual(actual, expectedBytes);
  });
  if (!valid) failure('WEBHOOK_SIGNATURE_INVALID', 'Svix webhook signature is invalid');
  return true;
}

function eventsFrom(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.events)) return result.events;
  if (Array.isArray(result?.data)) return result.data;
  return [];
}

export function createPollingWebhookQueue({ poll, consume, intervalMs = 5000, onError } = {}) {
  if (typeof poll !== 'function') throw new TypeError('Polling webhook queue requires poll');
  if (typeof consume !== 'function') throw new TypeError('Polling webhook queue requires consume');
  const consumedIds = new Set();
  let timer = null;
  let activePoll = null;

  async function pollNow() {
    if (activePoll) return activePoll;
    activePoll = (async () => {
      const events = eventsFrom(await poll());
      let consumed = 0;
      let duplicates = 0;
      for (const event of events) {
        const eventId = event?.event_id ?? event?.id;
        if (typeof eventId !== 'string' || eventId === '') failure('WEBHOOK_EVENT_INVALID', 'Polled webhook event ID is required');
        if (consumedIds.has(eventId)) { duplicates++; continue; }
        await consume(event);
        consumedIds.add(eventId);
        consumed++;
      }
      return { fetched: events.length, consumed, duplicates };
    })();
    try { return await activePoll; } finally { activePoll = null; }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { pollNow().catch((error) => onError?.(error)); }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return Object.freeze({ pollNow, start, stop, close: stop });
}
