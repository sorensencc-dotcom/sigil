import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createStreamServer } from './stream-server.mjs';
import { createTicketStore } from './ticket-store.mjs';

const principal = { endpoint_id: 'ep_h', owner_id: 'own_h', human_id: 'own_h' };

async function rig({ allowedOrigins = ['https://app.example'], logger } = {}) {
  const ticketStore = createTicketStore();
  const httpServer = http.createServer();
  const stream = createStreamServer({
    server: httpServer, ticketStore, allowedOrigins, logger,
    authenticate: (request) => request.headers['x-endpoint-id'] ?? null,
  });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = (query = '') => `ws://127.0.0.1:${httpServer.address().port}/v1/stream${query}`;
  const open = (query, headers = {}) => new Promise((resolve) => {
    const socket = new WebSocket(url(query), { headers });
    const frames = [];
    socket.on('message', (data) => frames.push(JSON.parse(data)));
    socket.once('open', () => resolve({ socket, frames, opened: true }));
    socket.once('close', (code) => resolve({ socket, frames, opened: false, code }));
    socket.once('error', () => {});
  });
  const closeCode = (socket) => new Promise((resolve) => (socket.readyState === 3 ? resolve(null) : socket.once('close', resolve)));
  const done = async () => { await stream.close(); await new Promise((resolve) => httpServer.close(resolve)); };
  return { ticketStore, stream, open, closeCode, done };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('a valid ticket opens a socket and registers it for room frames', async () => {
  const r = await rig();
  const { ticket } = r.ticketStore.issue(principal);
  const { socket, frames } = await r.open(`?ticket=${ticket}`, { origin: 'https://app.example' });
  assert.equal(r.stream.notifyRoom('ep_h', { room_id: 'room_1', room_seq: 5, changed: 'messages' }), true);
  await settle();
  assert.deepEqual(frames, [{ type: 'room.updated', room_id: 'room_1', room_seq: 5, changed: 'messages' }]);
  socket.close(); await r.done();
});

test('a members frame carries no room_seq', async () => {
  const r = await rig();
  const { ticket } = r.ticketStore.issue(principal);
  const { socket, frames } = await r.open(`?ticket=${ticket}`);
  r.stream.notifyRoom('ep_h', { room_id: 'room_1', changed: 'members' });
  await settle();
  assert.deepEqual(frames, [{ type: 'room.updated', room_id: 'room_1', changed: 'members' }]);
  socket.close(); await r.done();
});

test('a replayed ticket closes 1008', async () => {
  const r = await rig();
  const { ticket } = r.ticketStore.issue(principal);
  const first = await r.open(`?ticket=${ticket}`);
  assert.equal(first.opened, true);
  const second = await r.open(`?ticket=${ticket}`);
  assert.equal(await r.closeCode(second.socket), 1008);
  first.socket.close(); await r.done();
});

test('an unknown ticket closes 1008', async () => {
  const r = await rig();
  const { socket } = await r.open('?ticket=nope');
  assert.equal(await r.closeCode(socket), 1008);
  await r.done();
});

test('a bad Origin on a ticket upgrade closes 1008 and the ticket is still spent', async () => {
  const r = await rig();
  const { ticket } = r.ticketStore.issue(principal);
  const { socket } = await r.open(`?ticket=${ticket}`, { origin: 'https://evil.example' });
  assert.equal(await r.closeCode(socket), 1008);
  assert.equal(r.ticketStore.redeem(ticket), null);
  await r.done();
});

test('no Origin header skips the origin check', async () => {
  const r = await rig({ allowedOrigins: [] });
  const { ticket } = r.ticketStore.issue(principal);
  const { opened, socket } = await r.open(`?ticket=${ticket}`);
  assert.equal(opened, true);
  socket.close(); await r.done();
});

test('a ticket socket never evicts a bearer socket on the same endpoint', async () => {
  const r = await rig();
  const bearer = await r.open('', { 'x-endpoint-id': 'ep_h' });
  const { ticket } = r.ticketStore.issue(principal);
  const browser = await r.open(`?ticket=${ticket}`);
  assert.equal(r.stream.notify('ep_h', 'del_1', '1'), true);
  await settle();
  assert.equal(bearer.frames.filter((f) => f.type === 'delivered').length, 1);
  assert.equal(browser.frames.filter((f) => f.type === 'delivered').length, 0, 'browser sockets get room.updated only');
  bearer.socket.close(); browser.socket.close(); await r.done();
});

test('room.updated reaches bearer sockets and browser sockets on the same endpoint (receipts spec frame-table row)', async () => {
  const r = await rig();
  const bearerA = await r.open('', { 'x-endpoint-id': 'ep_h' });
  const bearerB = await r.open('', { 'x-endpoint-id': 'ep_h' });
  const browser = await r.open(`?ticket=${r.ticketStore.issue(principal).ticket}`);
  assert.equal(r.stream.notifyRoom('ep_h', { room_id: 'room_1', room_seq: 3, changed: 'messages' }), true);
  await settle();
  for (const socket of [bearerA, bearerB, browser]) {
    assert.deepEqual(socket.frames.filter((f) => f.type === 'room.updated'), [{ type: 'room.updated', room_id: 'room_1', room_seq: 3, changed: 'messages' }]);
  }
  for (const socket of [bearerA, bearerB, browser]) socket.socket.close();
  await r.done();
});

test('a bearer upgrade from a disallowed Origin closes 1008, from an allowed Origin or with no Origin it opens', async () => {
  const r = await rig();
  const bad = await r.open('', { 'x-endpoint-id': 'ep_h', origin: 'https://evil.example' });
  assert.equal(await r.closeCode(bad.socket), 1008);
  const good = await r.open('', { 'x-endpoint-id': 'ep_h', origin: 'https://app.example' });
  assert.equal(good.opened, true);
  const cli = await r.open('', { 'x-endpoint-id': 'ep_h' });
  assert.equal(cli.opened, true);
  good.socket.close(); cli.socket.close(); await r.done();
});

test('two tabs both receive room.updated, and closing one leaves the other', async () => {
  const r = await rig();
  const a = await r.open(`?ticket=${r.ticketStore.issue(principal).ticket}`);
  const b = await r.open(`?ticket=${r.ticketStore.issue(principal).ticket}`);
  r.stream.notifyRoom('ep_h', { room_id: 'room_1', room_seq: 1, changed: 'messages' });
  await settle();
  assert.equal(a.frames.length, 1);
  assert.equal(b.frames.length, 1);
  a.socket.close(); await settle();
  assert.equal(r.stream.notifyRoom('ep_h', { room_id: 'room_1', room_seq: 2, changed: 'messages' }), true);
  await settle();
  assert.equal(b.frames.length, 2);
  b.socket.close(); await r.done();
});

test('notifyRoom returns false when no browser socket is connected', async () => {
  const r = await rig();
  assert.equal(r.stream.notifyRoom('ep_h', { room_id: 'room_1', changed: 'members' }), false);
  await r.done();
});

test('the stream server never logs a raw ticket', async () => {
  const lines = [];
  const logger = { log: (...a) => lines.push(a), info: (...a) => lines.push(a), warn: (...a) => lines.push(a), error: (...a) => lines.push(a), debug: (...a) => lines.push(a) };
  const r = await rig({ logger });
  const { ticket } = r.ticketStore.issue(principal);
  const first = await r.open(`?ticket=${ticket}`);
  const replay = await r.open(`?ticket=${ticket}`);
  await r.closeCode(replay.socket);
  first.socket.close(); await r.done();
  assert.equal(JSON.stringify(lines).includes(ticket), false);
});

test('a server-side socket error terminates that socket and does not crash the relay', async () => {
  const r = await rig();
  const a = await r.open(`?ticket=${r.ticketStore.issue(principal).ticket}`);
  const b = await r.open(`?ticket=${r.ticketStore.issue(principal).ticket}`);
  // Masked text frame (zero mask) with invalid UTF-8: the server receiver emits 'error'.
  a.socket._socket.write(Buffer.from([0x81, 0x80 | 2, 0, 0, 0, 0, 0xff, 0xfe]));
  await settle();
  assert.equal(r.stream.notifyRoom('ep_h', { room_id: 'room_1', room_seq: 1, changed: 'messages' }), true);
  await settle();
  assert.equal(b.frames.length, 1);
  b.socket.close(); await r.done();
});
