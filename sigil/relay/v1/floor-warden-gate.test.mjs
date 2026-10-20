import test from 'node:test';
import assert from 'node:assert/strict';
import { createFloorWardenGate } from './floor-warden-gate.mjs';

function response() {
  return { headersSent: false, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
}

function request(token = '') { return { headers: token ? { authorization: `Bearer ${token}` } : {} }; }

test('preserves main-route outcomes and passes decoded room and bot identity to handler', async () => {
  const calls = [];
  const gate = createFloorWardenGate({
    match: async (token) => token === 'reply' ? { kind: 'bot', botId: 'bot_test', tokenId: 'frt_test' } : null,
    authenticateRequest: async () => ({ endpoint_id: 'ep_test' }),
    handler: async (ctx) => { calls.push(ctx); return { status: 202, body: { accepted: true } }; },
  });
  const ok = response();
  await gate({ request: request('reply'), response: ok, requestId: 'req_1', roomId: 'room%2Fx', now: new Date(), readBody() {} });
  assert.equal(ok.status, 202);
  assert.deepEqual(JSON.parse(ok.body), { request_id: 'req_1', accepted: true });
  assert.equal(calls[0].roomId, 'room/x');
  assert.equal(calls[0].botId, 'bot_test');

  const endpoint = response();
  await gate({ request: request('endpoint'), response: endpoint, requestId: 'req_2', roomId: 'room', now: new Date(), readBody() {} });
  assert.equal(endpoint.status, 403);
  assert.equal(JSON.parse(endpoint.body).code, 'ROUTE_NOT_AUTHORIZED');

  const missing = response();
  await gate({ request: request(), response: missing, requestId: 'req_3', roomId: 'room', now: new Date(), readBody() {} });
  assert.equal(missing.status, 401);
});

test('endpoint principals are not distinguished on the ingress gate', async () => {
  let authCalls = 0;
  const gate = createFloorWardenGate({ match: async () => null, authenticateRequest: async () => { authCalls += 1; return {}; }, distinguishEndpointPrincipal: false, handler: null });
  const out = response();
  await gate({ request: request('endpoint'), response: out, requestId: 'req', roomId: 'room', now: new Date(), readBody() {} });
  assert.equal(out.status, 401);
  assert.equal(authCalls, 0);
});

test('maps handler failures without exposing the error', async () => {
  const gate = createFloorWardenGate({ match: async () => ({ kind: 'global' }), handler: async () => { throw new Error('secret'); } });
  const out = response();
  await gate({ request: request('reply'), response: out, requestId: 'req', roomId: 'room', now: new Date(), readBody() {} });
  assert.equal(out.status, 503);
  assert.equal(JSON.parse(out.body).code, 'DATABASE_UNAVAILABLE');
  assert.equal(out.body.includes('secret'), false);
});
