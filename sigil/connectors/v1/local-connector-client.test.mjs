import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalConnectorClient } from './local-connector-client.mjs';
import { createConnectorServer } from './connector-server.mjs';

test('local connector client maps authenticated host operations to connector API', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url.toString(), options]);
    return { ok: true, status: 200, async json() { return { code: 'OK', result: { accepted: true } }; } };
  };
  const client = createLocalConnectorClient({ baseUrl: 'http://127.0.0.1:1234', token: 'secret', fetchImpl });
  assert.deepEqual(await client.sendTask({ envelope: { message_id: 'm1' } }), { accepted: true });
  assert.deepEqual(await client.checkInbox('cursor 1'), { accepted: true });
  assert.equal(calls[0][1].headers.authorization, 'Bearer secret');
  assert.equal(calls[0][0], 'http://127.0.0.1:1234/v1/tasks');
  assert.match(calls[1][0], /\/v1\/inbox\?since=cursor%201$/);
});

test('local connector client preserves structured connector errors', async () => {
  const client = createLocalConnectorClient({ baseUrl: 'http://localhost', token: 'secret', fetchImpl: async () => ({ ok: false, status: 401, async json() { return { code: 'UNAUTHENTICATED', message: 'Authentication required' }; } }) });
  await assert.rejects(() => client.getResult('task-1'), { code: 'UNAUTHENTICATED', status: 401 });
});

test('local connector client round-trips through authenticated connector server', async () => {
  const calls = [];
  const server = createConnectorServer({
    token: 'server-secret',
    connector: {
      async sendTask(input) { calls.push(['sendTask', input]); return { message_id: 'm1' }; },
      async checkInbox(since) { calls.push(['checkInbox', since]); return { items: [], nextSince: since }; }
    }
  });
  await server.listen();
  const address = server.address();
  try {
    const client = createLocalConnectorClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'server-secret' });
    assert.deepEqual(await client.sendTask({ envelope: { message_id: 'm1' } }), { message_id: 'm1' });
    assert.deepEqual(await client.checkInbox('cursor-1'), { items: [], nextSince: 'cursor-1' });
    assert.deepEqual(calls, [['sendTask', { envelope: { message_id: 'm1' } }], ['checkInbox', 'cursor-1']]);
  } finally {
    await server.close();
  }
});
