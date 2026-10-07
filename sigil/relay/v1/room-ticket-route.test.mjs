import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createTicketStore } from './ticket-store.mjs';

const principals = {
  'Bearer chris-web': { endpoint_id: 'ep_web', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer claude': { endpoint_id: 'ep_claude', owner_id: 'usr_chris', human_id: 'usr_chris' },
};
const registry = new Map([
  ['ep_web', { owner_id: 'usr_chris', status: 'active', kind: 'human' }],
  ['ep_claude', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
]);

function call(port, method, path, authorization) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: { ...(authorization ? { authorization } : {}) } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(options, fn) {
  const repository = createMemoryRepository({ registry });
  const server = createRelayServer({ registry, repository, authenticate: async (request) => principals[request.headers.authorization] ?? null, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(server.address().port); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('a human bearer principal gets a ticket with no-store caching', async () => {
  await withServer({ ticketStore: createTicketStore() }, async (port) => {
    const res = await call(port, 'POST', '/v1/rooms/ws-ticket', 'Bearer chris-web');
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 'OK');
    assert.equal(typeof res.body.ticket, 'string');
    assert.ok(Date.parse(res.body.expires_at) > Date.now());
    assert.equal(res.headers['cache-control'], 'no-store');
  });
});

test('an agent endpoint is refused', async () => {
  await withServer({ ticketStore: createTicketStore() }, async (port) => {
    const res = await call(port, 'POST', '/v1/rooms/ws-ticket', 'Bearer claude');
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'HUMAN_CONTEXT_REQUIRED');
  });
});

test('the ninth outstanding ticket answers 429 TICKET_CAP', async () => {
  await withServer({ ticketStore: createTicketStore() }, async (port) => {
    for (let i = 0; i < 8; i += 1) assert.equal((await call(port, 'POST', '/v1/rooms/ws-ticket', 'Bearer chris-web')).status, 200);
    const res = await call(port, 'POST', '/v1/rooms/ws-ticket', 'Bearer chris-web');
    assert.equal(res.status, 429);
    assert.equal(res.body.code, 'TICKET_CAP');
  });
});

test('no ticket store answers 503', async () => {
  await withServer({}, async (port) => {
    const res = await call(port, 'POST', '/v1/rooms/ws-ticket', 'Bearer chris-web');
    assert.equal(res.status, 503);
  });
});

test('the response never carries human_id or owner_id', async () => {
  await withServer({ ticketStore: createTicketStore() }, async (port) => {
    const res = await call(port, 'POST', '/v1/rooms/ws-ticket', 'Bearer chris-web');
    assert.doesNotMatch(res.text, /human_id|owner_id|usr_chris/);
  });
});

test('a browser origin on the allowlist gets CORS headers and a preflight 204 before authentication', async () => {
  await withServer({ ticketStore: createTicketStore(), allowedOrigins: ['https://app.example'] }, async (port) => {
    const pre = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, method: 'OPTIONS', path: '/v1/rooms/ws-ticket', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' } }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
      req.on('error', reject); req.end();
    });
    assert.equal(pre.statusCode, 204);
    assert.equal(pre.headers['access-control-allow-origin'], 'https://app.example');
  });
});
