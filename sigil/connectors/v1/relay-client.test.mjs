import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayClient } from './relay-client.mjs';

function fakeFetch() {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true }); } }; };
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
