import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createStreamServer } from './stream-server.mjs';
import { createTicketStore } from './ticket-store.mjs';

const PUBLIC_ORIGIN = 'https://rooms.example';
const BEARER = 'bearer-token-1';
const principal = { endpoint_id: 'ep_h', owner_id: 'own_h', human_id: 'own_h' };
const liveSnapshot = { endpoint_id: 'ep_h', owner_id: 'own_h', endpoint_status: 'active', has_active_key: true, human_status: 'active' };
const liveSessionRow = (overrides = {}) => ({
  session_id: 'sess_a', endpoint_id: 'ep_h', human_id: 'own_h',
  expires_at: new Date(Date.now() + 3600_000).toISOString(), revoked_at: null,
  last_seen_at: new Date().toISOString(), identity_status: 'active', ...overrides,
});

// sessions: Map<sessionId, row | Error | null>. A missing key reads as null (row gone).
function stubRepository(sessions = new Map()) {
  return {
    sessions,
    async livenessSnapshot() { return { ...liveSnapshot }; },
    async sessionLiveness(sessionId) {
      const value = sessions.get(sessionId) ?? null;
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

async function rig({ repository = null, livenessIntervalMs = 60_000, publicOrigin = PUBLIC_ORIGIN } = {}) {
  const ticketStore = createTicketStore();
  const loopback = http.createServer();
  const publicServer = http.createServer();
  const stream = createStreamServer({
    server: loopback, publicServer, publicOrigin, ticketStore, repository, livenessIntervalMs,
    allowedOrigins: [],
    // Bearer authenticator: accepts the Authorization header or the sigil-bearer. subprotocol.
    authenticate: (request) => {
      const header = request.headers.authorization;
      const protocols = request.headers['sec-websocket-protocol'] ?? '';
      const token = header?.startsWith('Bearer ') ? header.slice(7)
        : protocols.split(',').map((p) => p.trim()).find((p) => p.startsWith('sigil-bearer.'))?.slice('sigil-bearer.'.length);
      return token === BEARER ? principal : null;
    },
  });
  await new Promise((resolve) => loopback.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => publicServer.listen(0, '127.0.0.1', resolve));
  const url = (srv, query = '') => `ws://127.0.0.1:${srv.address().port}/v1/stream${query}`;
  const openOn = (srv, query, headers = {}, protocols = undefined) => new Promise((resolve) => {
    const socket = new WebSocket(url(srv, query), protocols, { headers });
    const frames = [];
    socket.on('message', (data) => frames.push(JSON.parse(data)));
    // Captured from creation, so a close that lands before the test awaits it is not lost.
    socket.closed = new Promise((done) => socket.once('close', done));
    socket.once('open', () => resolve({ socket, frames, opened: true }));
    socket.once('close', (code) => resolve({ socket, frames, opened: false, code }));
    socket.once('error', () => {});
  });
  const closeCode = (socket) => socket.closed;
  const done = async () => {
    await stream.close();
    await new Promise((resolve) => loopback.close(resolve));
    await new Promise((resolve) => publicServer.close(resolve));
  };
  return {
    ticketStore, stream, closeCode, done,
    openPublic: (query, headers, protocols) => openOn(publicServer, query, headers, protocols),
    openLoopback: (query, headers, protocols) => openOn(loopback, query, headers, protocols),
  };
}
const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
// A socket that opened and then was closed by the server reports the code; one
// refused during upgrade-handling also opens then closes 1008. Either way: 1008.
async function expectClosed1008(r, attempt) {
  const result = await attempt;
  const code = result.opened ? await r.closeCode(result.socket) : result.code;
  assert.equal(code, 1008);
}

test('public listener: valid ticket + public Origin connects and shares the room index', async () => {
  const r = await rig();
  const { ticket } = r.ticketStore.issue(principal);
  const s = await r.openPublic(`?ticket=${ticket}`, { origin: PUBLIC_ORIGIN });
  assert.equal(s.opened, true);
  assert.equal(r.stream.notifyRoom('ep_h', { room_id: 'room_1', room_seq: 2, changed: 'messages' }), true);
  await settle();
  assert.deepEqual(s.frames, [{ type: 'room.updated', room_id: 'room_1', room_seq: 2, changed: 'messages' }]);
  // Still open after the frame (not closed by anything).
  await settle();
  assert.equal(s.socket.readyState, 1);
  s.socket.close(); await r.done();
});

test('public listener never accepts bearer credentials, with or without Origin; loopback still does', async () => {
  const r = await rig();
  for (const headers of [{}, { origin: PUBLIC_ORIGIN }]) {
    await expectClosed1008(r, r.openPublic('', headers));
    await expectClosed1008(r, r.openPublic('', { ...headers, authorization: `Bearer ${BEARER}` }));
    await expectClosed1008(r, r.openPublic('', headers, [`sigil-bearer.${BEARER}`]));
  }
  const viaHeader = await r.openLoopback('', { authorization: `Bearer ${BEARER}` });
  assert.equal(viaHeader.opened, true);
  const viaProtocol = await r.openLoopback('', {}, [`sigil-bearer.${BEARER}`]);
  assert.equal(viaProtocol.opened, true);
  await settle();
  assert.equal(viaHeader.socket.readyState, 1);
  assert.equal(viaProtocol.socket.readyState, 1);
  viaHeader.socket.close(); viaProtocol.socket.close(); await r.done();
});

test('public listener: a ticket with a missing or wrong Origin closes 1008 and the ticket is spent', async () => {
  const r = await rig();
  for (const headers of [{}, { origin: 'https://evil.example' }, { origin: `${PUBLIC_ORIGIN}.evil` }]) {
    const { ticket } = r.ticketStore.issue(principal);
    await expectClosed1008(r, r.openPublic(`?ticket=${ticket}`, headers));
    assert.equal(r.ticketStore.redeem(ticket), null, 'ticket spent');
  }
  await r.done();
});

test('public listener refuses everything when no publicOrigin is configured', async () => {
  const r = await rig({ publicOrigin: null });
  const { ticket } = r.ticketStore.issue(principal);
  await expectClosed1008(r, r.openPublic(`?ticket=${ticket}`, { origin: PUBLIC_ORIGIN }));
  await r.done();
});

test('public listener: a bearer credential next to a bogus ticket still closes 1008', async () => {
  const r = await rig();
  await expectClosed1008(r, r.openPublic('?ticket=nope', { origin: PUBLIC_ORIGIN, authorization: `Bearer ${BEARER}` }));
  await r.done();
});

test('closeSession closes only that session\'s sockets', async () => {
  const repository = stubRepository(new Map([['sess_a', liveSessionRow()], ['sess_b', liveSessionRow({ session_id: 'sess_b' })]]));
  const r = await rig({ repository });
  const a = await r.openPublic(`?ticket=${r.ticketStore.issue({ ...principal, session_id: 'sess_a' }).ticket}`, { origin: PUBLIC_ORIGIN });
  const a2 = await r.openPublic(`?ticket=${r.ticketStore.issue({ ...principal, session_id: 'sess_a' }).ticket}`, { origin: PUBLIC_ORIGIN });
  const b = await r.openPublic(`?ticket=${r.ticketStore.issue({ ...principal, session_id: 'sess_b' }).ticket}`, { origin: PUBLIC_ORIGIN });
  const bearer = await r.openLoopback('', { authorization: `Bearer ${BEARER}` });
  assert.ok(a.opened && a2.opened && b.opened && bearer.opened);
  await settle();
  r.stream.closeSession('sess_a');
  assert.equal(await r.closeCode(a.socket), 1008);
  assert.equal(await r.closeCode(a2.socket), 1008);
  await settle();
  assert.equal(b.socket.readyState, 1);
  assert.equal(bearer.socket.readyState, 1);
  assert.equal(r.stream.notifyRoom('ep_h', { room_id: 'room_1', changed: 'members' }), true);
  await settle();
  assert.equal(b.frames.length, 1);
  b.socket.close(); bearer.socket.close(); await r.done();
});

test('a session ticket is refused at upgrade when the session is revoked, gone, or unreadable', async () => {
  const repository = stubRepository(new Map([
    ['sess_revoked', liveSessionRow({ revoked_at: new Date().toISOString() })],
    ['sess_throws', new Error('db down')],
    ['sess_no_seen', liveSessionRow({ last_seen_at: null })],
    ['sess_no_identity', liveSessionRow({ identity_status: undefined })],
  ]));
  const r = await rig({ repository });
  for (const sid of ['sess_revoked', 'sess_gone', 'sess_throws', 'sess_no_seen', 'sess_no_identity']) {
    const { ticket } = r.ticketStore.issue({ ...principal, session_id: sid });
    await expectClosed1008(r, r.openPublic(`?ticket=${ticket}`, { origin: PUBLIC_ORIGIN }));
  }
  await r.done();
});

test('a session ticket fails closed when the repository cannot check sessions', async () => {
  const r = await rig({ repository: null });
  const { ticket } = r.ticketStore.issue({ ...principal, session_id: 'sess_a' });
  await expectClosed1008(r, r.openPublic(`?ticket=${ticket}`, { origin: PUBLIC_ORIGIN }));
  await r.done();
});

test('revalidate({ humanId }) closes sockets whose session was revoked, vanished, or cannot be read', async () => {
  const sessions = new Map([
    ['sess_rev', liveSessionRow({ session_id: 'sess_rev' })],
    ['sess_gone', liveSessionRow({ session_id: 'sess_gone' })],
    ['sess_err', liveSessionRow({ session_id: 'sess_err' })],
    ['sess_ok', liveSessionRow({ session_id: 'sess_ok' })],
  ]);
  const r = await rig({ repository: stubRepository(sessions) });
  const open = {};
  for (const sid of sessions.keys()) {
    open[sid] = await r.openPublic(`?ticket=${r.ticketStore.issue({ ...principal, session_id: sid }).ticket}`, { origin: PUBLIC_ORIGIN });
    assert.equal(open[sid].opened, true, sid);
  }
  const token = await r.openPublic(`?ticket=${r.ticketStore.issue({ ...principal, session_id: null }).ticket}`, { origin: PUBLIC_ORIGIN });
  assert.equal(token.opened, true);
  await settle();
  sessions.set('sess_rev', liveSessionRow({ session_id: 'sess_rev', revoked_at: new Date().toISOString() }));
  sessions.delete('sess_gone');
  sessions.set('sess_err', new Error('db down'));
  await r.stream.revalidate({ humanId: 'own_h' });
  assert.equal(await r.closeCode(open.sess_rev.socket), 1008);
  assert.equal(await r.closeCode(open.sess_gone.socket), 1008);
  assert.equal(await r.closeCode(open.sess_err.socket), 1008);
  await settle();
  assert.equal(open.sess_ok.socket.readyState, 1);
  assert.equal(token.socket.readyState, 1, 'token-mode ticket socket untouched by session checks');
  open.sess_ok.socket.close(); token.socket.close(); await r.done();
});

test('the periodic pass closes an idle-expired session socket and leaves token-mode sockets alone', async () => {
  const sessions = new Map([['sess_idle', liveSessionRow({ session_id: 'sess_idle' })]]);
  const r = await rig({ repository: stubRepository(sessions), livenessIntervalMs: 20 });
  const idle = await r.openPublic(`?ticket=${r.ticketStore.issue({ ...principal, session_id: 'sess_idle' }).ticket}`, { origin: PUBLIC_ORIGIN });
  const token = await r.openPublic(`?ticket=${r.ticketStore.issue({ ...principal, session_id: null }).ticket}`, { origin: PUBLIC_ORIGIN });
  const bearer = await r.openLoopback('', { authorization: `Bearer ${BEARER}` });
  assert.ok(idle.opened && token.opened && bearer.opened);
  await settle(80);
  assert.equal(idle.socket.readyState, 1, 'live session survives the pass');
  sessions.set('sess_idle', liveSessionRow({ session_id: 'sess_idle', last_seen_at: new Date(Date.now() - 8 * 3600_000 - 1000).toISOString() }));
  assert.equal(await r.closeCode(idle.socket), 1008);
  await settle(80);
  assert.equal(token.socket.readyState, 1);
  assert.equal(bearer.socket.readyState, 1);
  token.socket.close(); bearer.socket.close(); await r.done();
});

test('a loopback ticket carrying session_id is session-bound too', async () => {
  const sessions = new Map([['sess_l', liveSessionRow({ session_id: 'sess_l' })]]);
  const r = await rig({ repository: stubRepository(sessions) });
  const s = await r.openLoopback(`?ticket=${r.ticketStore.issue({ ...principal, session_id: 'sess_l' }).ticket}`);
  assert.equal(s.opened, true);
  await settle();
  r.stream.closeSession('sess_l');
  assert.equal(await r.closeCode(s.socket), 1008);
  await r.done();
});
