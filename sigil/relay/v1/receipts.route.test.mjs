import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ port, path }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    }).on('error', reject);
  });
}

async function withServer(options, fn) {
  const server = createRelayServer({ now: new Date('2026-10-06T00:00:00.000Z'), ...options });
  await new Promise((resolve) => server.listen(0, resolve));
  try { return await fn(server.address().port); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function repositoryWith(rows) {
  return {
    async lookupMessageSender(id) { return id === 'msg_1' ? { endpoint_id: 'ep_sender' } : null; },
    async listReceiptsForMessage(id) { return id === 'msg_1' ? rows : []; },
  };
}

const ROWS = [
  { recipient_endpoint_id: 'ep_a', state: 'acknowledged', queued_at: '2026-10-06T00:00:00.000Z', acknowledged_at: '2026-10-06T00:00:02.000Z' },
  { recipient_endpoint_id: 'ep_b', state: 'queued', queued_at: '2026-10-06T00:00:00.000Z' },
];

test('the original sender reads one mapped row per recipient, with the raw state', async () => {
  await withServer({ repository: repositoryWith(ROWS), authenticate: async () => ({ endpoint_id: 'ep_sender' }) }, async (port) => {
    const result = await getJson(port, '/v1/messages/msg_1/receipts');
    assert.equal(result.status, 200);
    assert.equal(result.body.message_id, 'msg_1');
    assert.deepEqual(result.body.receipts, [
      { recipient_endpoint_id: 'ep_a', state: 'read', raw_state: 'acknowledged', at: '2026-10-06T00:00:02.000Z' },
      { recipient_endpoint_id: 'ep_b', state: 'queued', raw_state: 'queued', at: '2026-10-06T00:00:00.000Z' },
    ]);
  });
});

test('a message with no deliveries returns 200 and an empty list', async () => {
  const repository = { ...repositoryWith([]) };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_sender' }) }, async (port) => {
    const result = await getJson(port, '/v1/messages/msg_1/receipts');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.receipts, []);
  });
});

test('a non-sender and an unknown message get the same 404 body', async () => {
  const strip = ({ request_id, ...rest }) => rest;
  const nonSender = await withServer({ repository: repositoryWith(ROWS), authenticate: async () => ({ endpoint_id: 'ep_recipient' }) }, (port) => getJson(port, '/v1/messages/msg_1/receipts'));
  const unknown = await withServer({ repository: repositoryWith(ROWS), authenticate: async () => ({ endpoint_id: 'ep_sender' }) }, (port) => getJson(port, '/v1/messages/msg_nope/receipts'));
  assert.equal(nonSender.status, 404);
  assert.equal(unknown.status, 404);
  assert.deepEqual(strip(nonSender.body), strip(unknown.body));
  assert.equal(nonSender.body.code, 'MESSAGE_NOT_FOUND');
});

test('a forwarded federation message (no local envelope row) returns 404 to its sender', async () => {
  // lookupMessageSender finds nothing because the origin relay never wrote an envelopes row.
  const repository = { async lookupMessageSender() { return null; }, async listReceiptsForMessage() { return ROWS; } };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_sender' }) }, async (port) => {
    assert.equal((await getJson(port, '/v1/messages/msg_fed/receipts')).status, 404);
  });
});

test('a repository without listReceiptsForMessage answers 503', async () => {
  const repository = { async lookupMessageSender() { return { endpoint_id: 'ep_sender' }; } };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_sender' }) }, async (port) => {
    assert.equal((await getJson(port, '/v1/messages/msg_1/receipts')).status, 503);
  });
});

test('a repository failure answers 503 DATABASE_UNAVAILABLE, not a stack trace', async () => {
  const repository = { async lookupMessageSender() { throw new Error('boom'); }, async listReceiptsForMessage() { return []; } };
  await withServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_sender' }) }, async (port) => {
    const result = await getJson(port, '/v1/messages/msg_1/receipts');
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'DATABASE_UNAVAILABLE');
  });
});

test('a principal without an endpoint_id gets 404, same as an unknown message', async () => {
  const strip = ({ request_id, ...rest }) => rest;
  const noId = await withServer({ repository: repositoryWith(ROWS), authenticate: async () => ({}) }, (port) => getJson(port, '/v1/messages/msg_nope/receipts'));
  const real = await withServer({ repository: repositoryWith(ROWS), authenticate: async () => ({}) }, (port) => getJson(port, '/v1/messages/msg_1/receipts'));
  assert.equal(noId.status, 404);
  assert.equal(real.status, 404);
  assert.deepEqual(strip(noId.body), strip(real.body));
});

test('a malformed percent escape in the message ID answers 404, not a crash', async () => {
  await withServer({ repository: repositoryWith(ROWS), authenticate: async () => ({ endpoint_id: 'ep_sender' }) }, async (port) => {
    const result = await getJson(port, '/v1/messages/%E0%A4%A/receipts');
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'MESSAGE_NOT_FOUND');
  });
});
