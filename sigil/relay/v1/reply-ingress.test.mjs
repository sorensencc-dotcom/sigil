import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplyIngress } from './reply-ingress.mjs';

test('serves one exact loopback route and fixed 404 elsewhere', async (t) => {
  const calls = [];
  const ingress = createReplyIngress({ gate: async (ctx) => { calls.push(ctx); ctx.response.writeHead(202, { 'content-type': 'application/json' }); ctx.response.end('{"ok":true}'); } });
  const address = await ingress.listen(0);
  t.after(() => ingress.server.close());
  const origin = `http://127.0.0.1:${address.port}`;
  const missing = await fetch(`${origin}/v1/rooms/room_x/replies/`);
  const missingBody = await missing.text();
  assert.equal(missing.status, 404);
  assert.equal(missingBody, JSON.stringify({ code: 'NOT_FOUND', message: 'Not found', details: {} }));
  const query = await fetch(`${origin}/v1/rooms/room_x/replies?x=1`, { method: 'POST', headers: { authorization: 'Bearer fixture' }, body: '{}' });
  assert.equal(query.status, 202);
  assert.equal(calls[0].roomId, 'room_x');
  const other = await fetch(`${origin}/`, { method: 'POST' });
  assert.equal(other.status, 404);
  assert.equal(await other.text(), missingBody);
});

test('binds loopback only and does not emit CORS headers', async (t) => {
  const ingress = createReplyIngress({ gate: async () => {} });
  const address = await ingress.listen(0);
  t.after(() => ingress.server.close());
  assert.equal(address.address, '127.0.0.1');
  const response = await fetch(`http://127.0.0.1:${address.port}/`, { method: 'GET' });
  assert.equal(response.headers.has('access-control-allow-origin'), false);
});
