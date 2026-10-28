import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createRelayMetrics } from './metrics.mjs';
import { createReplyIngress } from './reply-ingress.mjs';

function dispatch(server, { method = 'GET', url, headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(body)]);
    req.method = method;
    req.url = url;
    req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    let statusCode = 200;
    const responseHeaders = {};
    const chunks = [];
    const res = {
      headersSent: false,
      writeHead(status, hdrs = {}) {
        statusCode = status;
        Object.assign(responseHeaders, hdrs);
        this.headersSent = true;
      },
      end(chunk) {
        if (chunk != null) chunks.push(Buffer.from(chunk));
        this.headersSent = true;
        resolve({ status: statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: responseHeaders });
      },
    };
    try {
      const handled = server.emit('request', req, res);
      if (!handled) reject(new Error('no request listener'));
    } catch (error) {
      reject(error);
    }
  });
}

function postReply(server, authorization) {
  return dispatch(server, {
    method: 'POST',
    url: '/v1/rooms/room_x/replies',
    headers: { authorization, 'content-type': 'application/json' },
    body: '{}',
  });
}

const UNAUTHENTICATED_BODY = JSON.stringify({ code: 'UNAUTHENTICATED', message: 'Authentication required', details: {} });

test('serves one exact loopback route and fixed 404 elsewhere', async () => {
  const calls = [];
  const ingress = createReplyIngress({ gate: async (ctx) => { calls.push(ctx); ctx.response.writeHead(202, { 'content-type': 'application/json' }); ctx.response.end('{"ok":true}'); } });
  const missing = await dispatch(ingress.server, { method: 'GET', url: '/v1/rooms/room_x/replies/' });
  assert.equal(missing.status, 404);
  assert.equal(missing.text, JSON.stringify({ code: 'NOT_FOUND', message: 'Not found', details: {} }));
  const query = await dispatch(ingress.server, { method: 'POST', url: '/v1/rooms/room_x/replies?x=1', headers: { authorization: 'Bearer fixture' }, body: '{}' });
  assert.equal(query.status, 202);
  assert.equal(calls[0].roomId, 'room_x');
  const other = await dispatch(ingress.server, { method: 'POST', url: '/' });
  assert.equal(other.status, 404);
  assert.equal(other.text, missing.text);
});

test('binds loopback only and does not emit CORS headers', async (t) => {
  const ingress = createReplyIngress({ gate: async () => {} });
  const response = await dispatch(ingress.server, { method: 'GET', url: '/' });
  assert.equal(Object.keys(response.headers).some((name) => name.toLowerCase() === 'access-control-allow-origin'), false);
  let address;
  try {
    address = await ingress.listen(0);
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('loopback bind is not permitted in this environment');
      return;
    }
    throw error;
  }
  t.after(() => ingress.server.close());
  assert.equal(address.address, '127.0.0.1');
});

function auditPayloadKeys(event) {
  const payload = event.payload ?? {};
  return Object.keys(payload).sort();
}

test('canary bearer is 401 UNAUTHENTICATED with the unknown body, no gate, and ingress.canary_used only', async () => {
  const gateCalls = [];
  const audits = [];
  const metrics = createRelayMetrics();
  const rows = new Map([
    ['fwr_canary_token', { kind: 'canary', botId: 'bot_canary', tokenId: 'frt_canary' }],
    ['fwr_active_token', { kind: 'bot', botId: 'bot_active', tokenId: 'frt_active' }],
  ]);
  const ingress = createReplyIngress({
    match: async (bearer) => rows.get(bearer) ?? null,
    repository: {
      async recordAuditEvent(event) { audits.push(event); },
    },
    perBotLimiter: async () => ({ allowed: true }),
    logger: { warn() {}, error() {} },
    metrics,
    gate: async (ctx) => {
      gateCalls.push(ctx);
      ctx.response.writeHead(202, { 'content-type': 'application/json' });
      ctx.response.end('{"ok":true}');
    },
  });

  const unknown = await postReply(ingress.server, 'Bearer fwr_unknown_token');
  assert.equal(unknown.status, 401);
  assert.equal(unknown.text, UNAUTHENTICATED_BODY);
  assert.equal(audits.length, 0);

  const canary = await postReply(ingress.server, 'Bearer fwr_canary_token');
  assert.equal(canary.status, 401);
  assert.equal(canary.text, unknown.text);
  assert.equal(gateCalls.length, 0);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].eventType, 'ingress.canary_used');
  assert.equal(audits[0].subjectId, 'bot_canary');
  assert.equal(audits[0].objectId, 'frt_canary');
  assert.equal(audits[0].objectType, 'floor_warden_reply_token');
  assert.deepEqual(audits[0].payload, { token_id: 'frt_canary', bot_id: 'bot_canary' });
  assert.deepEqual(auditPayloadKeys(audits[0]), ['bot_id', 'token_id']);
  assert.equal(JSON.stringify(audits[0]).includes('fwr_canary_token'), false);
  const snapshot = metrics.snapshot().counters;
  assert.ok(snapshot['sigil_ingress_auth_failed_total{}'] >= 2);
  assert.ok(snapshot['sigil_ingress_requests_total{result=auth_failed}'] >= 2);

  const revoked = await postReply(ingress.server, 'Bearer fwr_revoked_token');
  assert.equal(revoked.status, 401);
  assert.equal(revoked.text, unknown.text);
  assert.equal(audits.length, 1);
  assert.equal(gateCalls.length, 0);

  const active = await postReply(ingress.server, 'Bearer fwr_active_token');
  assert.equal(active.status, 202);
  assert.equal(gateCalls.length, 1);
  assert.equal(audits.length, 1);
  assert.equal(gateCalls[0].matched.kind, 'bot');
});

test('canary still returns the unknown 401 body when audit write fails', async () => {
  let gateCalled = false;
  const ingress = createReplyIngress({
    match: async () => ({ kind: 'canary', botId: 'bot_canary', tokenId: 'frt_canary' }),
    repository: { async recordAuditEvent() { throw new Error('audit down'); } },
    logger: { warn() {}, error() {} },
    gate: async () => { gateCalled = true; },
  });
  const result = await postReply(ingress.server, 'Bearer fwr_canary_token');
  assert.equal(result.status, 401);
  assert.equal(result.text, UNAUTHENTICATED_BODY);
  assert.equal(gateCalled, false);
});
