import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayClient } from './relay-client.mjs';

function fakeFetch() {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, async text() { return JSON.stringify(url.includes('/inbox') ? { items: [{ delivery_id: 'del_1' }], next_since: 'cursor_2' } : { ok: true }); } }; };
  return { calls, fetchImpl };
}

test('client sends authenticated envelope and delivery calls', async () => {
  const { calls, fetchImpl } = fakeFetch(); const client = new RelayClient({ baseUrl: 'https://relay.test/', token: 'token_1', fetchImpl });
  await client.sendEnvelope({ message_id: 'msg_1' }, 'req_1'); await client.pollInbox('cur 1'); await client.acknowledge('del_1'); await client.reportProcessing('del_1', 'processing_failed', 'runtime');
  assert.equal(calls.length, 4); assert.equal(calls[0].options.headers.authorization, 'Bearer token_1'); assert.equal(calls[0].options.headers['x-sigil-request-id'], 'req_1'); assert.match(calls[1].url, /since=cur%201/); assert.match(calls[3].url, /processing$/);
});

test('client exposes stable relay errors', async () => {
  const client = new RelayClient({ baseUrl: 'https://relay.test', token: 't', fetchImpl: async () => ({ ok: false, status: 403, async text() { return JSON.stringify({ code: 'CAPABILITY_DENIED', message: 'denied', details: { scope: 'x' } }); } }) });
  await assert.rejects(() => client.pollInbox(), (error) => error.code === 'CAPABILITY_DENIED' && error.status === 403);
});

test('client exposes cursor-based inbox reconciliation', async () => {
  const client = new RelayClient({ baseUrl: 'https://relay.test', token: 't', fetchImpl: async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ items: [{ delivery_id: 'del_2' }], next_since: 'cursor_3' }); } }) });
  assert.deepEqual(await client.reconcileInbox('cursor_2'), { items: [{ delivery_id: 'del_2' }], nextSince: 'cursor_3' });
});

test('acknowledge with outcome: processed routes to /processing with state: processed', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const client = new RelayClient({ baseUrl: 'https://relay.test/', token: 'token_1', fetchImpl });
  await client.acknowledge('del_proc_1', { outcome: 'processed' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/deliveries\/del_proc_1\/processing$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { state: 'processed', reason: null });
});

test('acknowledge rejects unrecognized outcome with INVALID_ENVELOPE', async () => {
  const { fetchImpl } = fakeFetch();
  const client = new RelayClient({ baseUrl: 'https://relay.test/', token: 'token_1', fetchImpl });
  await assert.rejects(
    () => client.acknowledge('del_bad', { outcome: 'unrecognized_status' }),
    (error) => error.code === 'INVALID_ENVELOPE'
  );
});

test('room methods call the room routes', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push([options.method ?? 'GET', url.replace('http://relay', ''), options.body ?? null]);
    const body = url.includes('/members') ? { items: [{ endpoint_id: 'ep_web' }] }
      : url.includes('/messages') ? { items: [], next_after_seq: '0' }
      : url.includes('/fail') ? { invocation: { invocation_id: 'inv_1', status: 'failed' } }
      : { items: [{ invocation_id: 'inv_1' }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const client = new RelayClient({ baseUrl: 'http://relay', token: 't', fetchImpl });
  assert.deepEqual(await client.listRoomMembers('room_1'), [{ endpoint_id: 'ep_web' }]);
  assert.deepEqual(await client.listRoomMessages('room_1', '5'), { items: [], next_after_seq: '0' });
  assert.deepEqual(await client.listRoomInvocations('room_1', { endpointId: 'ep_claude', status: 'running' }), [{ invocation_id: 'inv_1' }]);
  assert.equal((await client.failRoomInvocation('room_1', 'boom')).status, 'failed');
  assert.deepEqual(calls.map(([m, u]) => `${m} ${u}`), [
    'GET /v1/rooms/room_1/members',
    'GET /v1/rooms/room_1/messages?after_seq=5&limit=500',
    'GET /v1/rooms/room_1/invocations?endpoint_id=ep_claude&status=running',
    'POST /v1/rooms/room_1/invocations/fail',
  ]);
});

test('failRoomInvocation sends invocation_id in body when provided', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push(options.body ? JSON.parse(options.body) : null);
    return { ok: true, status: 200, text: async () => JSON.stringify({ invocation: { invocation_id: 'inv_1', status: 'failed' } }) };
  };
  const client = new RelayClient({ baseUrl: 'http://relay', token: 't', fetchImpl });
  await client.failRoomInvocation('room_1', 'boom', 'inv_1');
  assert.deepEqual(calls[0], { reason: 'boom', invocation_id: 'inv_1' });
  assert.equal(calls.length, 1);
  await client.failRoomInvocation('room_1', 'boom');
  assert.deepEqual(calls[1], { reason: 'boom' });
  assert.equal(calls.length, 2);
});

