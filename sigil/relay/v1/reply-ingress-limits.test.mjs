import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayMetrics } from './metrics.mjs';
import { createReplyIngress } from './reply-ingress.mjs';

test('enforces ingress and per-bot limits with the settled retry header', async (t) => {
  let now = new Date('2026-01-01T00:00:00Z');
  let botCalls = 0;
  let botMinute = -1;
  const metrics = createRelayMetrics();
  const ingress = createReplyIngress({
    now: () => now,
    ratePerMinute: 2,
    match: async () => ({ kind: 'bot', botId: 'bot_test', tokenId: 'frt_test' }),
    perBotLimiter: async ({ now: current }) => { const minute = Math.floor(new Date(current).getTime() / 60_000); if (minute !== botMinute) { botMinute = minute; botCalls = 0; } return { allowed: ++botCalls <= 1 }; },
    metrics,
    gate: async ({ response }) => { response.writeHead(202); response.end('{}'); },
  });
  const address = await ingress.listen(0);
  t.after(() => ingress.server.close());
  const origin = `http://127.0.0.1:${address.port}/v1/rooms/room_x/replies`;
  const headers = { authorization: 'Bearer fwr_fixture', 'content-type': 'application/json' };
  assert.equal((await fetch(origin, { method: 'POST', headers, body: '{}' })).status, 202);
  const limitedBot = await fetch(origin, { method: 'POST', headers, body: '{}' });
  assert.equal(limitedBot.status, 429);
  assert.equal(limitedBot.headers.get('retry-after'), '60');
  const limitedIngress = await fetch(origin, { method: 'POST', headers, body: '{}' });
  assert.equal(limitedIngress.status, 429);
  now = new Date('2026-01-01T00:01:00Z');
  assert.equal((await fetch(origin, { method: 'POST', headers, body: '{}' })).status, 202);
  assert.ok(metrics.snapshot().counters['sigil_ingress_rate_limited_total{scope=bot}']);
});

test('rejects bad authentication before content type and fails closed when bot limits cannot reserve', async (t) => {
  const seen = [];
  const ingress = createReplyIngress({
    match: async () => null,
    gate: async () => { throw new Error('gate must not run'); },
    logger: { warn(entry) { seen.push(entry); }, error() {} },
  });
  const address = await ingress.listen(0);
  t.after(() => ingress.server.close());
  const bad = await fetch(`http://127.0.0.1:${address.port}/v1/rooms/room_x/replies`, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: 'Bearer fwr_bad' }, body: 'x' });
  assert.equal(bad.status, 401);
  assert.equal(seen.length, 1);

  const failClosed = createReplyIngress({ match: async () => ({ kind: 'bot', botId: 'bot_test' }), repository: {}, gate: async () => {} });
  const failAddress = await failClosed.listen(0);
  t.after(() => failClosed.server.close());
  const result = await fetch(`http://127.0.0.1:${failAddress.port}/v1/rooms/room_x/replies`, { method: 'POST', headers: { authorization: 'Bearer fwr_fixture', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(result.status, 503);
});
