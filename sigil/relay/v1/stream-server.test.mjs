import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createStreamServer } from './stream-server.mjs';
import { hashBearerToken } from './transport-auth.mjs';
import { RelayClient } from '../../connectors/v1/relay-client.mjs';

test('stream sends thin delivery notification to authenticated endpoint', async () => {
  const httpServer = http.createServer();
  const stream = createStreamServer({ server: httpServer, authenticate: (request) => request.headers['x-endpoint-id'] });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, { headers: { 'x-endpoint-id': 'ep_claude' } });
  const message = new Promise((resolve) => socket.once('message', (data) => resolve(JSON.parse(data))));
  await new Promise((resolve) => socket.once('open', resolve));
  assert.equal(stream.notify('ep_claude', 'del_1'), true);
  assert.deepEqual(await message, { type: 'delivered', delivery_id: 'del_1', stream_seq: null });
  socket.close(); await stream.close(); await new Promise((resolve) => httpServer.close(resolve));
});

test('notifyReceipt pushes a small delivery.receipt payload to the SENDER, not the recipient', async () => {
  const httpServer = http.createServer();
  const stream = createStreamServer({ server: httpServer, authenticate: (request) => request.headers['x-endpoint-id'] });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const senderSocket = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, { headers: { 'x-endpoint-id': 'ep_codex' } });
  const recipientSocket = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, { headers: { 'x-endpoint-id': 'ep_claude' } });
  const senderMessage = new Promise((resolve) => senderSocket.once('message', (data) => resolve(JSON.parse(data))));
  let recipientReceivedMessage = false;
  recipientSocket.once('message', () => { recipientReceivedMessage = true; });
  await Promise.all([
    new Promise((resolve) => senderSocket.once('open', resolve)),
    new Promise((resolve) => recipientSocket.once('open', resolve))
  ]);
  const receipt = { message_id: 'msg_1', delivery_id: 'del_1', state: 'acknowledged', at: '2026-08-16T12:00:00Z' };
  assert.equal(stream.notifyReceipt('ep_codex', receipt), true);
  assert.deepEqual(await senderMessage, { type: 'delivery.receipt', ...receipt, stream_seq: null });
  assert.equal(recipientReceivedMessage, false);
  senderSocket.close(); recipientSocket.close(); await stream.close(); await new Promise((resolve) => httpServer.close(resolve));
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

test('reconnect recovers missed notification through inbox reconciliation', async () => {
  const httpServer = http.createServer();
  const stream = createStreamServer({ server: httpServer, authenticate: (request) => request.headers['x-endpoint-id'] });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/stream`, { headers: { 'x-endpoint-id': 'ep_claude' } });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.close();
  await new Promise((resolve) => socket.once('close', resolve));

  assert.equal(stream.notify('ep_claude', 'del_missed'), false);
  const client = new RelayClient({
    baseUrl: `http://127.0.0.1:${port}`,
    token: 'unused',
    fetchImpl: async (url) => ({
      ok: true, status: 200,
      async text() { return JSON.stringify({ items: [{ delivery_id: 'del_missed' }], next_since: 'cursor_2' }); }
    })
  });
  assert.deepEqual(await client.reconcileInbox('cursor_1'), {
    items: [{ delivery_id: 'del_missed' }], nextSince: 'cursor_2'
  });

  await stream.close();
  await new Promise((resolve) => httpServer.close(resolve));
});

async function twoSocketRig() {
  const httpServer = http.createServer();
  const stream = createStreamServer({ server: httpServer, authenticate: (request) => request.headers['x-endpoint-id'] });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `ws://127.0.0.1:${httpServer.address().port}/v1/stream`;
  const connect = async () => {
    const socket = new WebSocket(url, { headers: { 'x-endpoint-id': 'ep_a' } });
    const frames = [];
    socket.on('message', (data) => {
      const frame = JSON.parse(data);
      if (frame.type !== 'pong') frames.push(frame);
    });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return { socket, frames };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  const done = async (...sockets) => {
    for (const { socket } of sockets) socket.close();
    await stream.close();
    await new Promise((resolve) => httpServer.close(resolve));
  };
  return { stream, connect, settle, done };
}

test('delivery.receipt reaches every open socket on the endpoint', async () => {
  const { stream, connect, settle, done } = await twoSocketRig();
  const first = await connect();
  const second = await connect();
  assert.equal(stream.notifyReceipt('ep_a', { message_id: 'm1', state: 'delivered' }), true);
  await settle();
  assert.equal(first.frames.length, 1);
  assert.equal(second.frames.length, 1);
  await done(first, second);
});

for (const [method, args, type] of [
  ['notify', ['del_1', '5'], 'delivered'],
  ['notifyResend', [{ conversation_id: 'c1' }], 'resend'],
  ['notifySequenceReset', [{ conversation_id: 'c1' }], 'sequence_reset'],
]) {
  test(`${type} reaches only the latest socket, and closing it promotes the previous one`, async () => {
    const { stream, connect, settle, done } = await twoSocketRig();
    const first = await connect();
    const second = await connect();
    assert.equal(stream[method]('ep_a', ...args), true);
    await settle();
    assert.equal(first.frames.length, 0, 'older socket gets no single-target frame');
    assert.equal(second.frames.length, 1);
    assert.equal(second.frames[0].type, type);

    second.socket.close();
    await settle();
    assert.equal(stream[method]('ep_a', ...args), true);
    await settle();
    assert.equal(first.frames.length, 1, 'previous socket promoted after latest closes');
    assert.equal(first.frames[0].type, type);
    await done(first);
  });
}

test('an endpoint with no open socket returns false from every notify method', async () => {
  const { stream, done } = await twoSocketRig();
  assert.equal(stream.notify('ep_a', 'd', null), false);
  assert.equal(stream.notifyReceipt('ep_a', { message_id: 'm' }), false);
  assert.equal(stream.notifyResend('ep_a', {}), false);
  assert.equal(stream.notifySequenceReset('ep_a', {}), false);
  await done();
});

// Liveness: a repository-backed stream server admits a socket only while its
// endpoint (and owning human) are live, and drops it once they are not.
async function livenessRig({ livenessIntervalMs } = {}) {
  const snapshots = new Map([
    ['ep_a', { endpoint_status: 'active', has_active_key: true, human_status: 'active' }],
    ['ep_b', { endpoint_status: 'active', has_active_key: true, human_status: 'active' }],
    ['ep_c', { endpoint_status: 'active', has_active_key: true, human_status: 'active' }],
  ]);
  const owners = { ep_a: 'hum_a', ep_b: 'hum_b', ep_c: 'hum_a' };
  const repository = {
    async livenessSnapshot({ endpointId }) {
      const row = snapshots.get(endpointId);
      if (row === 'throw') throw new Error('db down');
      return row ? { ...row } : null;
    },
  };
  const ticketStore = { redeem: (ticket) => (ticket === 'tk_c' ? { endpoint_id: 'ep_c', owner_id: 'hum_a', human_id: 'hum_a' } : null) };
  const httpServer = http.createServer();
  const stream = createStreamServer({
    server: httpServer,
    repository,
    ticketStore,
    livenessIntervalMs,
    authenticate: async (request) => {
      const endpointId = request.headers['x-endpoint-id'];
      return endpointId ? { endpoint_id: endpointId, owner_id: owners[endpointId] } : null;
    },
  });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `ws://127.0.0.1:${httpServer.address().port}/v1/stream`;
  const open = (socket) => new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const connect = async (endpointId) => {
    const socket = new WebSocket(url, { headers: { 'x-endpoint-id': endpointId } });
    await open(socket);
    return socket;
  };
  const connectTicket = async (ticket) => {
    const socket = new WebSocket(`${url}?ticket=${ticket}`);
    await open(socket);
    return socket;
  };
  const raw = (endpointId) => new WebSocket(url, { headers: { 'x-endpoint-id': endpointId } });
  const rawTicket = (ticket) => new WebSocket(`${url}?ticket=${ticket}`);
  const closed = (socket) => new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
  const done = async (...sockets) => {
    for (const socket of sockets) socket.terminate();
    await stream.close();
    await new Promise((resolve) => httpServer.close(resolve));
  };
  return { stream, snapshots, connect, connectTicket, raw, rawTicket, closed, settle, done };
}

test('a bearer socket for a non-live endpoint is closed 1008 at upgrade and never registered', async () => {
  const rig = await livenessRig();
  const live = rig.snapshots.get('ep_a');
  for (const bad of [{ ...live, endpoint_status: 'revoked' }, { ...live, has_active_key: false }, { ...live, human_status: 'suspended' }, null, 'throw']) {
    if (bad === null) rig.snapshots.delete('ep_a'); else rig.snapshots.set('ep_a', bad);
    const socket = rig.raw('ep_a');
    const close = await rig.closed(socket);
    assert.deepEqual(close, { code: 1008, reason: 'unauthorized' }, JSON.stringify(bad));
    assert.equal(rig.stream.notifyReceipt('ep_a', { message_id: 'm' }), false);
    assert.equal(rig.stream.notifyRoom('ep_a', { room_id: 'r', changed: 'members' }), false);
  }
  rig.snapshots.set('ep_c', { ...live, human_status: 'suspended' });
  const ticketSocket = rig.rawTicket('tk_c');
  assert.deepEqual(await rig.closed(ticketSocket), { code: 1008, reason: 'unauthorized' });
  assert.equal(rig.stream.notifyRoom('ep_c', { room_id: 'r', changed: 'members' }), false);
  await rig.done();
});

test('a live bearer socket is registered once liveness passes', async () => {
  const rig = await livenessRig();
  const socket = await rig.connect('ep_a');
  await rig.settle();
  assert.equal(rig.stream.notify('ep_a', 'del_1'), true);
  await rig.done(socket);
});

test('revalidate({ endpointId }) closes only the failing sockets of that endpoint', async () => {
  const rig = await livenessRig();
  const a = await rig.connect('ep_a');
  const b = await rig.connect('ep_b');
  await rig.settle();
  rig.snapshots.set('ep_a', { endpoint_status: 'revoked', has_active_key: false, human_status: 'active' });
  rig.snapshots.set('ep_b', { endpoint_status: 'revoked', has_active_key: false, human_status: 'active' });
  const aClosed = rig.closed(a);
  await rig.stream.revalidate({ endpointId: 'ep_a' });
  assert.deepEqual(await aClosed, { code: 1008, reason: 'unauthorized' });
  assert.equal(rig.stream.notify('ep_a', 'd'), false);
  assert.equal(b.readyState, WebSocket.OPEN, 'ep_b was not named, so it is not rechecked');
  assert.equal(rig.stream.notify('ep_b', 'd'), true);
  await rig.done(b);
});

test('revalidate({ humanId }) checks every bearer and browser socket that human owns', async () => {
  const rig = await livenessRig();
  const a = await rig.connect('ep_a');
  const b = await rig.connect('ep_b');
  const c = await rig.connectTicket('tk_c');
  await rig.settle();
  for (const id of ['ep_a', 'ep_c']) rig.snapshots.set(id, { endpoint_status: 'active', has_active_key: true, human_status: 'suspended' });
  const closes = [rig.closed(a), rig.closed(c)];
  await rig.stream.revalidate({ humanId: 'hum_a' });
  for (const close of await Promise.all(closes)) assert.deepEqual(close, { code: 1008, reason: 'unauthorized' });
  assert.equal(rig.stream.notifyRoom('ep_c', { room_id: 'r', changed: 'members' }), false);
  assert.equal(b.readyState, WebSocket.OPEN);
  await rig.done(b);
});

test('revalidate keeps a socket whose snapshot is still live', async () => {
  const rig = await livenessRig();
  const a = await rig.connect('ep_a');
  await rig.settle();
  await rig.stream.revalidate({ endpointId: 'ep_a' });
  await rig.settle();
  assert.equal(a.readyState, WebSocket.OPEN);
  await rig.done(a);
});

test('the periodic liveness pass closes a socket whose snapshot turns bad', async () => {
  const rig = await livenessRig({ livenessIntervalMs: 20 });
  const a = await rig.connect('ep_a');
  const b = await rig.connect('ep_b');
  await rig.settle();
  const aClosed = rig.closed(a);
  rig.snapshots.set('ep_a', 'throw');
  assert.deepEqual(await aClosed, { code: 1008, reason: 'unauthorized' });
  assert.equal(b.readyState, WebSocket.OPEN);
  await rig.done(b);
});
