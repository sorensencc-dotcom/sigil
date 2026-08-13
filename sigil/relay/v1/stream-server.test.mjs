import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createStreamServer } from './stream-server.mjs';
import { hashBearerToken } from './transport-auth.mjs';

test('stream sends thin delivery notification to authenticated endpoint', async () => {
  const httpServer = http.createServer();
  const stream = createStreamServer({ server: httpServer, authenticate: (request) => request.headers['x-endpoint-id'] });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, { headers: { 'x-endpoint-id': 'ep_claude' } });
  const message = new Promise((resolve) => socket.once('message', (data) => resolve(JSON.parse(data))));
  await new Promise((resolve) => socket.once('open', resolve));
  assert.equal(stream.notify('ep_claude', 'del_1'), true);
  assert.deepEqual(await message, { type: 'delivered', delivery_id: 'del_1' });
  socket.close(); await stream.close(); await new Promise((resolve) => httpServer.close(resolve));
});

test('stream authenticates bearer token against endpoint hash', async () => {
  const httpServer = http.createServer();
  const stream = createStreamServer({ server: httpServer, tokenHashes: new Map([[hashBearerToken('stream_secret'), 'ep_claude']]) });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, { headers: { authorization: 'Bearer stream_secret' } });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  assert.equal(stream.notify('ep_claude', 'del_2'), true);
  socket.close(); await stream.close(); await new Promise((resolve) => httpServer.close(resolve));
});

test('stream authenticates browser-safe bearer subprotocol', async () => {
  const httpServer = http.createServer();
  const stream = createStreamServer({ server: httpServer, tokenHashes: new Map([[hashBearerToken('browser_secret'), 'ep_claude']]) });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${httpServer.address().port}/v1/stream`, ['sigil-bearer.browser_secret']);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.close(); await stream.close(); await new Promise((resolve) => httpServer.close(resolve));
});

test('stream closes invalid and missing bearer tokens with policy violation', async () => {
  const httpServer = http.createServer();
  const stream = createStreamServer({ server: httpServer, tokenHashes: new Map([[hashBearerToken('valid'), 'ep_claude']]) });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  for (const options of [{ headers: { authorization: 'Bearer invalid' } }, {}]) {
    const socket = new WebSocket(`ws://127.0.0.1:${httpServer.address().port}/v1/stream`, options);
    const close = await new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    assert.equal(close.code, 1008);
    assert.equal(close.reason, 'unauthorized');
  }
  await stream.close(); await new Promise((resolve) => httpServer.close(resolve));
});
