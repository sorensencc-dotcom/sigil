import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPublicListener, matchPublicRoute } from './public-listener.mjs';

const O = 'https://rooms.example.com';

async function start(overrides = {}) {
  const calls = [];
  const rec = (name) => async ({ response }) => {
    calls.push(name);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
    return true;
  };
  const auth = { calls: [], principal: { endpoint_id: 'e1' } };
  const server = createPublicListener({
    publicOrigin: O,
    authenticateCookie: async (request) => { auth.calls.push(request.headers.cookie ?? null); return auth.principal; },
    handleOAuthPublicRoute: rec('public'),
    handleOAuthSessionRoute: rec('session'),
    handleRoomRoute: rec('room'),
    handleContactsRoute: rec('contacts'),
    roomRouteContext: () => ({ repository: {} }),
    ...overrides,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const send = (method, path, headers = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    r.end();
  });
  return { calls, auth, send, close: () => new Promise((r) => server.close(r)) };
}

test('non-allowlisted requests 404 and run no handler', async () => {
  const t = await start();
  try {
    const cases = [
      ['GET', '/approve'], ['GET', '/v1/health'], ['GET', '/v1/approval-challenges/x/assertion'],
      ['POST', '/v1/agentmail/webhook/x'], ['POST', '/v1/federation/envelopes'], ['GET', '/v1/federation/directory/x'],
      ['POST', '/v1/envelopes'], ['POST', '/v1/endpoint-tokens'], ['POST', '/v1/identities'], ['POST', '/v1/capability-grants'],
      ['POST', '/v1/auth/login'], ['GET', '/v1/rooms/../federation/envelopes'], ['GET', '/v1/rooms/%2e%2e/federation/envelopes'],
      ['GET', '/v1/rooms%2Ffoo'], ['GET', '/v1/rooms%5cfoo'], ['GET', '/v1/auth/oauth/github/start'],
      ['POST', '/v1/auth/oauth/github/callback'], ['DELETE', '/v1/rooms/r1'], ['PUT', '/v1/rooms'], ['PATCH', '/v1/rooms/r1'],
      ['GET', '/v1/auth/oauth/github/start/extra'], ['GET', '/v1/mentions/x'], ['POST', '/v1/mentions'],
    ];
    for (const [m, p] of cases) {
      const res = await t.send(m, p, { origin: O, 'x-sigil-csrf': '1', cookie: 'c=1' });
      assert.equal(res.status, 404, `${m} ${p}`);
      assert.equal(JSON.parse(res.body).code, 'NOT_FOUND');
    }
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.auth.calls, []);
  } finally { await t.close(); }
});

test('Authorization header is ignored; no cookie -> 401', async () => {
  const t = await start();
  t.auth.principal = null;
  try {
    const res = await t.send('GET', '/v1/rooms', { authorization: 'Bearer anything' });
    assert.equal(res.status, 401);
    assert.deepEqual(t.auth.calls, [null]);
    assert.deepEqual(t.calls, []);
  } finally { await t.close(); }
});

test('cookie POST without CSRF header -> 403, with it -> handler', async () => {
  const t = await start();
  try {
    let res = await t.send('POST', '/v1/rooms', { cookie: 's=1', origin: O });
    assert.equal(res.status, 403);
    assert.deepEqual(t.calls, []);
    res = await t.send('POST', '/v1/rooms', { cookie: 's=1', origin: O, 'x-sigil-csrf': '1' });
    assert.equal(res.status, 200);
    res = await t.send('GET', '/v1/rooms/r1', { cookie: 's=1' });
    assert.equal(res.status, 200);
    res = await t.send('GET', '/v1/mentions', { cookie: 's=1' });
    assert.equal(res.status, 200);
    assert.deepEqual(t.calls, ['room', 'room', 'room']);
  } finally { await t.close(); }
});

test('start/callback reach handler with no credential', async () => {
  const t = await start();
  try {
    let res = await t.send('POST', '/v1/auth/oauth/github/start');
    assert.equal(res.status, 200);
    res = await t.send('GET', '/v1/auth/oauth/github/callback?code=a&state=b');
    assert.equal(res.status, 200);
    assert.deepEqual(t.calls, ['public', 'public']);
    assert.deepEqual(t.auth.calls, []);
  } finally { await t.close(); }
});

test('me/logout: 401 without cookie, session handler with cookie', async () => {
  const t = await start();
  try {
    t.auth.principal = null;
    assert.equal((await t.send('GET', '/v1/auth/me')).status, 401);
    assert.equal((await t.send('POST', '/v1/auth/logout', { origin: O, 'x-sigil-csrf': '1' })).status, 401);
    assert.deepEqual(t.calls, []);
    t.auth.principal = { endpoint_id: 'e1' };
    assert.equal((await t.send('GET', '/v1/auth/me', { cookie: 's=1' })).status, 200);
    assert.equal((await t.send('POST', '/v1/auth/logout', { cookie: 's=1' })).status, 403);
    assert.equal((await t.send('POST', '/v1/auth/logout', { cookie: 's=1', origin: O, 'x-sigil-csrf': '1' })).status, 200);
    assert.deepEqual(t.calls, ['session', 'session']);
  } finally { await t.close(); }
});

test('handler returning falsy -> 404; handler throw -> 500', async () => {
  const t = await start({ handleRoomRoute: async () => false });
  try { assert.equal((await t.send('GET', '/v1/rooms', { cookie: 's=1' })).status, 404); } finally { await t.close(); }
  const u = await start({ handleRoomRoute: async () => { throw new Error('boom'); } });
  try { assert.equal((await u.send('GET', '/v1/rooms', { cookie: 's=1' })).status, 500); } finally { await u.close(); }
});

test('handleRoomRoute receives a per-request requestId', async () => {
  let seen = [];
  const t = await start({ handleRoomRoute: async ({ response, requestId }) => { seen.push(requestId); response.writeHead(200); response.end(); return true; } });
  try {
    await t.send('GET', '/v1/rooms', { cookie: 's=1' });
    await t.send('GET', '/v1/rooms', { cookie: 's=1' });
    assert.equal(seen.length, 2);
    assert.ok(seen[0] && seen[1] && seen[0] !== seen[1]);
  } finally { await t.close(); }
});

test('matchPublicRoute exact segments', () => {
  assert.equal(matchPublicRoute('GET', '/v1/rooms'), 'rooms');
  assert.equal(matchPublicRoute('GET', '/v1/rooms/r1/messages?x=1'), 'rooms');
  assert.equal(matchPublicRoute('GET', '/v1/roomsfoo'), null);
  assert.equal(matchPublicRoute('GET', '/v1//rooms'), null);
  assert.equal(matchPublicRoute('GET', '/v1/me/contacts'), 'contacts');
  assert.equal(matchPublicRoute('POST', '/v1/me/contacts'), 'contacts');
  assert.equal(matchPublicRoute('PUT', '/v1/me/contacts/ct_1'), 'contacts');
  assert.equal(matchPublicRoute('DELETE', '/v1/me/contacts/ct_1'), 'contacts');
  assert.equal(matchPublicRoute('PATCH', '/v1/me/contacts'), null);
  assert.equal(matchPublicRoute('GET', '/v1/me/contacts/ct_1'), null);
  assert.equal(matchPublicRoute('GET', '/v1/me/other'), null);
});

test('contacts require a cookie and dispatch to the contacts handler', async () => {
  let received;
  const t = await start({
    handleContactsRoute: async (args) => {
      received = args;
      t.calls.push('contacts');
      args.response.writeHead(200, { 'content-type': 'application/json' });
      args.response.end('{"ok":true}');
      return true;
    },
  });
  try {
    t.auth.principal = null;
    const unauthenticated = await t.send('GET', '/v1/me/contacts');
    assert.equal(unauthenticated.status, 401);
    assert.equal(JSON.parse(unauthenticated.body).code, 'UNAUTHENTICATED');
    assert.deepEqual(t.calls, []);

    t.auth.principal = { endpoint_id: 'e1', human_id: 'h1' };
    const authenticated = await t.send('GET', '/v1/me/contacts', { cookie: 's=1' });
    assert.equal(authenticated.status, 200);
    assert.deepEqual(t.calls, ['contacts']);
    assert.equal(received.principal.human_id, 'h1');
    assert.ok(received.requestId);
    assert.deepEqual(received.repository, {});
  } finally { await t.close(); }
});
