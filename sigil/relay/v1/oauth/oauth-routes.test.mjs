import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPublicListener } from './public-listener.mjs';
import { createOAuthRoutes } from './oauth-routes.mjs';
import { createFlowStore } from './flow-store.mjs';
import { hashCookie, SESSION_COOKIE, FLOW_COOKIE } from './cookies.mjs';

const O = 'https://sigil.test';
const OPERATOR = 'usr_operator';
const NOW = new Date('2030-01-02T03:04:05.000Z');

async function harness(t, { providerOverrides = {}, invites = {}, limits = {}, repoOverrides = {}, principal = null, completeLoginImpl = null } = {}) {
  const calls = { authorizeUrl: 0, audit: [], pool: [], closeSession: [], revokeSession: [], reserve: [], login: [] };
  const provider = {
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      calls.authorizeUrl += 1;
      return `https://github.test/authorize?state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(redirectUri)}`;
    },
    async exchangeCode() { return { accessToken: 'tok' }; },
    async resolveIdentity() { return { issuer: 'https://github.com', subject: '1', displayName: 'G1' }; },
    ...providerOverrides,
  };
  const repository = {
    withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }),
    reserveRateLimit: async (kind, id, windowStart, limit) => {
      calls.reserve.push({ kind, id, windowStart, limit });
      return { allowed: !limits[kind] };
    },
    recordAuditEvent: async (event) => { calls.audit.push(event); },
    pool: {
      query: async (sql, params) => {
        calls.pool.push({ sql, params });
        if (/FROM room_invites/.test(sql)) {
          const row = invites[params[0]];
          return { rows: row ? [row] : [] };
        }
        return { rows: [] };
      },
    },
    ...repoOverrides,
  };
  const flowStore = createFlowStore({ now: () => NOW });
  const routes = createOAuthRoutes({
    repository,
    providers: { github: provider },
    flowStore,
    ticketStore: { revokeSession: (id) => calls.revokeSession.push(id) },
    stream: { closeSession: (id) => calls.closeSession.push(id) },
    publicOrigin: O,
    wrapKey: Buffer.alloc(32),
    operatorHumanId: OPERATOR,
    now: () => NOW,
    readBody: async (request) => { let raw = ''; for await (const c of request) raw += c; return raw; },
    completeLoginImpl: completeLoginImpl ?? (async (args) => { calls.login.push(args); return { outcome: 'login', human_id: 'usr_g', endpoint_id: 'ep_g' }; }),
  });
  const server = createPublicListener({
    publicOrigin: O,
    authenticateCookie: async () => principal,
    ...routes,
    handleRoomRoute: async () => false,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;
  const send = (method, path, { headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
  return { calls, flowStore, send, repository };
}

const startHeaders = { origin: O, 'content-type': 'application/json' };
const startBody = (invite) => JSON.stringify(invite ? { invite } : {});
const cookieOf = (res, name) => {
  const header = [].concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
  return header ? header.split(';')[0].slice(name.length + 1) : null;
};

test('start rejects a foreign Origin, a missing Origin, and cross-site fetch metadata', async (t) => {
  const h = await harness(t);
  for (const headers of [{ origin: 'https://evil.test' }, {}, { origin: O, 'sec-fetch-site': 'cross-site' }]) {
    const res = await h.send('POST', '/v1/auth/oauth/github/start', { headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
    assert.equal(res.status, 403);
    assert.equal(res.headers['set-cookie'], undefined);
  }
  assert.equal(h.calls.authorizeUrl, 0);
});

test('start: unknown provider is 404 and a missing database is 501', async (t) => {
  const h = await harness(t);
  assert.equal((await h.send('POST', '/v1/auth/oauth/nope/start', { headers: startHeaders, body: '{}' })).status, 404);
  const noDb = await harness(t, { repoOverrides: { withTransaction: undefined } });
  assert.equal((await noDb.send('POST', '/v1/auth/oauth/github/start', { headers: startHeaders, body: '{}' })).status, 501);
});

test('start with a bad invite redirects to invite_expired without contacting the provider', async (t) => {
  const h = await harness(t);
  const res = await h.send('POST', '/v1/auth/oauth/github/start', { headers: startHeaders, body: startBody('nope') });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login?error=invite_expired');
  assert.equal(h.calls.authorizeUrl, 0);
});

test('start OK redirects to the provider with S256 and sets the flow cookie for 600 s', async (t) => {
  const h = await harness(t);
  const res = await h.send('POST', '/v1/auth/oauth/github/start', { headers: startHeaders, body: '{}' });
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /code_challenge_method=S256/);
  assert.match(res.headers.location, /redirect_uri=https%3A%2F%2Fsigil\.test%2Fv1%2Fauth%2Foauth%2Fgithub%2Fcallback/);
  const cookie = [].concat(res.headers['set-cookie']).find((c) => c.startsWith('__Host-sigil_oauth='));
  assert.ok(cookie);
  assert.match(cookie, /Max-Age=600/);
});

test('start with a form-encoded invite stores the token on the flow', async (t) => {
  const { hashInviteToken } = await import('./invites.mjs');
  const h = await harness(t, { invites: { [hashInviteToken('tok1')]: { invite_id: 'inv_1', target_human_id: null } } });
  const res = await h.send('POST', '/v1/auth/oauth/github/start', { headers: { origin: O, 'content-type': 'application/x-www-form-urlencoded' }, body: 'invite=tok1' });
  assert.equal(res.status, 302);
  assert.ok(h.calls.reserve.some((r) => r.kind === 'invite' && r.id === 'inv_1' && r.limit === 10));
  const flow = h.flowStore.take(cookieOf(res, FLOW_COOKIE));
  assert.equal(flow.inviteId, 'tok1');
});

async function startFlow(h) {
  const res = await h.send('POST', '/v1/auth/oauth/github/start', { headers: startHeaders, body: '{}' });
  const cookie = cookieOf(res, FLOW_COOKIE);
  const state = new URL(res.headers.location).searchParams.get('state');
  return { cookie, state };
}

test('callback without a valid flow is denied and writes no audit row', async (t) => {
  const h = await harness(t);
  const noCookie = await h.send('GET', '/v1/auth/oauth/github/callback?state=x&code=c');
  assert.equal(noCookie.headers.location, '/login?error=denied');

  const { cookie, state } = await startFlow(h);
  const wrong = await h.send('GET', `/v1/auth/oauth/github/callback?state=wrong&code=c`, { headers: { cookie: `${FLOW_COOKIE}=${cookie}` } });
  assert.equal(wrong.headers.location, '/login?error=denied');
  // The wrong-state attempt consumed the flow: a replay with the right state fails.
  const replay = await h.send('GET', `/v1/auth/oauth/github/callback?state=${state}&code=c`, { headers: { cookie: `${FLOW_COOKIE}=${cookie}` } });
  assert.equal(replay.headers.location, '/login?error=denied');
  assert.deepEqual(h.calls.audit, []);
  assert.equal(h.calls.login.length, 0);
});

test('callback with ?error= is denied and clears the flow cookie', async (t) => {
  const h = await harness(t);
  const { cookie, state } = await startFlow(h);
  const res = await h.send('GET', `/v1/auth/oauth/github/callback?state=${state}&error=access_denied`, { headers: { cookie: `${FLOW_COOKIE}=${cookie}` } });
  assert.equal(res.headers.location, '/login?error=denied');
  assert.match([].concat(res.headers['set-cookie']).join('\n'), /__Host-sigil_oauth=; Max-Age=0/);
  assert.equal(h.flowStore.take(cookie), null);
});

test('callback maps a provider PROVIDER_ERROR to provider_error', async (t) => {
  const h = await harness(t, { providerOverrides: { exchangeCode: async () => { throw Object.assign(new Error('boom'), { code: 'PROVIDER_ERROR' }); } } });
  const { cookie, state } = await startFlow(h);
  const res = await h.send('GET', `/v1/auth/oauth/github/callback?state=${state}&code=c`, { headers: { cookie: `${FLOW_COOKIE}=${cookie}` } });
  assert.equal(res.headers.location, '/login?error=provider_error');
});

test('callback success sets the session cookie, clears the flow cookie, and revokes the presented session', async (t) => {
  const h = await harness(t);
  const { cookie, state } = await startFlow(h);
  const res = await h.send('GET', `/v1/auth/oauth/github/callback?state=${state}&code=c`, {
    headers: { cookie: `${FLOW_COOKIE}=${cookie}; ${SESSION_COOKIE}=oldsession` },
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/');
  const set = [].concat(res.headers['set-cookie']);
  assert.ok(set.some((c) => c.startsWith('__Host-sigil_oauth=;') && /Max-Age=0/.test(c)));
  const session = set.find((c) => c.startsWith('__Host-sigil_session=') && !/Max-Age=0/.test(c));
  assert.ok(session);
  assert.match(session, /Max-Age=604800/);
  const revoke = h.calls.pool.find((c) => /UPDATE human_sessions SET revoked_at/.test(c.sql));
  assert.equal(revoke.params[0], hashCookie('oldsession'));
  assert.ok(h.calls.reserve.some((r) => r.kind === 'oauth_provider_subject' && r.id === 'https://github.com|1'));
  assert.equal(h.calls.login[0].inviteToken, null);
  assert.equal(h.calls.login[0].sessionId, hashCookie(session.split(';')[0].slice('__Host-sigil_session='.length)));
});

test('callback maps non-login outcomes onto the login error codes', async (t) => {
  for (const outcome of ['denied', 'invite_required', 'invite_expired']) {
    const h = await harness(t, { completeLoginImpl: async () => ({ outcome }) });
    const { cookie, state } = await startFlow(h);
    const res = await h.send('GET', `/v1/auth/oauth/github/callback?state=${state}&code=c`, { headers: { cookie: `${FLOW_COOKIE}=${cookie}` } });
    assert.equal(res.headers.location, `/login?error=${outcome}`);
    assert.equal(cookieOf(res, SESSION_COOKIE), null);
  }
});

test('me returns the principal shape with is_operator, and logout revokes everything', async (t) => {
  const principal = { human_id: 'usr_x', endpoint_id: 'ep_x', session_id: 'sess_hash', display_name: 'Xavier' };
  const h = await harness(t, { principal });
  const headers = { cookie: `${SESSION_COOKIE}=whatever`, origin: O, 'x-sigil-csrf': '1' };
  const me = await h.send('GET', '/v1/auth/me', { headers });
  assert.deepEqual(JSON.parse(me.body), { human_id: 'usr_x', endpoint_id: 'ep_x', display_name: 'Xavier', is_operator: false });

  const op = await harness(t, { principal: { ...principal, human_id: OPERATOR } });
  assert.equal(JSON.parse((await op.send('GET', '/v1/auth/me', { headers })).body).is_operator, true);

  const out = await h.send('POST', '/v1/auth/logout', { headers });
  assert.equal(out.status, 204);
  assert.match(out.headers['set-cookie'].join(), /^__Host-sigil_session=; Max-Age=0; /);
  assert.match(out.headers['set-cookie'].join(), /Secure.*Path=\/.*HttpOnly.*SameSite=Lax/);
  assert.deepEqual(h.calls.closeSession, ['sess_hash']);
  assert.deepEqual(h.calls.revokeSession, ['sess_hash']);
  assert.equal(h.calls.audit[0].eventType, 'human_session.revoked');
  assert.ok(h.calls.pool.some((c) => /UPDATE human_sessions SET revoked_at/.test(c.sql) && c.params[0] === 'sess_hash'));
});

test('global start ceiling returns 429 for a normal flow but a --self flow still starts', async (t) => {
  const { hashInviteToken } = await import('./invites.mjs');
  const invites = {
    [hashInviteToken('selftok')]: { invite_id: 'inv_self', target_human_id: OPERATOR },
    [hashInviteToken('guesttok')]: { invite_id: 'inv_guest', target_human_id: null },
  };
  const h = await harness(t, { limits: { oauth_start: true }, invites });
  const normal = await h.send('POST', '/v1/auth/oauth/github/start', { headers: startHeaders, body: '{}' });
  assert.equal(normal.status, 429);
  const guest = await h.send('POST', '/v1/auth/oauth/github/start', { headers: startHeaders, body: startBody('guesttok') });
  assert.equal(guest.status, 429);
  const self = await h.send('POST', '/v1/auth/oauth/github/start', { headers: startHeaders, body: startBody('selftok') });
  assert.equal(self.status, 302);
  const global = h.calls.reserve.find((r) => r.kind === 'oauth_start');
  assert.equal(global.id, 'global');
  assert.equal(global.limit, 60);
  assert.equal(global.windowStart, '2030-01-02T03:04:00.000Z');
});

test('flow store cap yields 503', async (t) => {
  const h = await harness(t);
  h.flowStore.start = () => { throw Object.assign(new Error('full'), { code: 'FLOW_CAP' }); };
  assert.equal((await h.send('POST', '/v1/auth/oauth/github/start', { headers: startHeaders, body: '{}' })).status, 503);
});
