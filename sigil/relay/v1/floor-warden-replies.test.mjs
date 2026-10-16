import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRelayServer } from './http-server.mjs';
import { loadReplyTokens } from './floor-warden-token.mjs';

const REPLY = 'r'.repeat(40);
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const tokenHashes = new Map([[sha('human-token'), 'ep_human'], [sha('agent-token'), 'ep_agent']]);
const registry = new Map([['ep_human', { kind: 'human', owner_id: 'alice' }], ['ep_agent', { kind: 'agent', owner_id: 'alice' }]]);

function call(port, method, path, authorization) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let body = null; try { body = JSON.parse(text); } catch {} resolve({ status: res.statusCode, body }); });
    });
    req.on('error', reject);
    req.end('{}');
  });
}

async function withServer(options, fn) {
  const server = createRelayServer({ registry, tokenHashes, ...options });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(server.address().port); } finally { await new Promise((r) => server.close(r)); }
}

const configured = () => {
  const calls = [];
  const floorWardenReplies = { tokens: loadReplyTokens({ FWT: REPLY }, 'FWT'), handler: async (ctx) => { calls.push(ctx); return { status: 201, body: { code: 'OK' } }; } };
  return { floorWardenReplies, calls };
};
const PATH = '/v1/rooms/room_1/replies';

test('unconfigured route answers 404 for any bearer', async () => {
  await withServer({}, async (port) => {
    for (const auth of [undefined, 'Bearer human-token', `Bearer ${REPLY}`]) {
      assert.equal((await call(port, 'POST', PATH, auth)).status, 404);
    }
  });
});

test('reply token continues to the handler', async () => {
  const { floorWardenReplies, calls } = configured();
  await withServer({ floorWardenReplies }, async (port) => {
    const res = await call(port, 'POST', PATH, `Bearer ${REPLY}`);
    assert.equal(res.status, 201);
    assert.equal(calls[0].roomId, 'room_1');
  });
});

test('valid endpoint bearers get 403 ROUTE_NOT_AUTHORIZED', async () => {
  const { floorWardenReplies, calls } = configured();
  await withServer({ floorWardenReplies }, async (port) => {
    for (const t of ['human-token', 'agent-token']) {
      const res = await call(port, 'POST', PATH, `Bearer ${t}`);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'ROUTE_NOT_AUTHORIZED');
    }
    assert.equal(calls.length, 0);
  });
});

test('no header and wrong header answer 401 UNAUTHENTICATED', async () => {
  const { floorWardenReplies } = configured();
  await withServer({ floorWardenReplies }, async (port) => {
    for (const auth of [undefined, 'Bearer nope', 'Basic abc']) {
      const res = await call(port, 'POST', PATH, auth);
      assert.equal(res.status, 401);
      assert.equal(res.body.code, 'UNAUTHENTICATED');
    }
  });
});

test('the reply token is not an endpoint token on other paths', async () => {
  const { floorWardenReplies, calls } = configured();
  await withServer({ floorWardenReplies }, async (port) => {
    assert.equal((await call(port, 'POST', '/v1/rooms/room_1/other', `Bearer ${REPLY}`)).status, 401);
    // Only POST is the reply route; GET falls through to the existing gates.
    assert.notEqual((await call(port, 'GET', PATH, `Bearer ${REPLY}`)).status, 201);
    assert.equal(calls.length, 0);
    assert.equal((await call(port, 'GET', '/v1/health')).status, 200);
  });
});
