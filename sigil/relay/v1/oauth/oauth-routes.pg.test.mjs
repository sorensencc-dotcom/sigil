// Live-Postgres, real-wire pin for the OAuth routes: public listener + cookie
// authenticator + real repository, with a fake GitHub standing in for the provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { provisionHumanTx } from '../provision-human.mjs';
import { PostgresRepository } from '../postgres-repository.mjs';
import { withTransaction } from '../with-transaction.mjs';
import { createInvite } from './invites.mjs';
import { createPublicListener } from './public-listener.mjs';
import { createOAuthRoutes } from './oauth-routes.mjs';
import { createFlowStore } from './flow-store.mjs';
import { createCookieAuthenticator } from './session-auth.mjs';
import { createGitHubProvider } from './providers/github.mjs';
import { FLOW_COOKIE, SESSION_COOKIE } from './cookies.mjs';
import { assertDisposableTestDatabase } from '../../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const skip = !connectionString;
const wrapKey = crypto.randomBytes(32);
const O = 'https://sigil.test';
const GITHUB = 'https://github.com';
const DAY = 24 * 3600_000;

// code "c<id>" exchanges for token "t<id>", which /user resolves to GitHub id <id>.
async function fakeGitHub(t) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/token') {
      let body = ''; for await (const c of req) body += c;
      const code = new URLSearchParams(body).get('code');
      return res.end(JSON.stringify({ access_token: `t${code.slice(1)}`, token_type: 'bearer' }));
    }
    const id = (req.headers.authorization ?? '').replace('Bearer t', '');
    return res.end(JSON.stringify({ id: Number(id), login: `u${id}`, name: `GH ${id}` }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { authorize: `${base}/authorize`, tokenUrl: `${base}/token`, api: base };
}

async function setup(t, { flowMax = 10_000 } = {}) {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString, max: 10 });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyMigrations(connectionString);
  const repository = new PostgresRepository({ pool });
  const operator = await withTransaction(pool, (c) => provisionHumanTx(c, { displayName: 'Operator', wrapKey, now: new Date() }));
  const endpoints = await fakeGitHub(t);
  const closed = [];
  const routes = createOAuthRoutes({
    repository,
    providers: { github: createGitHubProvider({ clientId: 'cid', clientSecret: 'sec', endpoints }) },
    flowStore: createFlowStore({ maxEntries: flowMax }),
    ticketStore: { revokeSession: (id) => closed.push(['ticket', id]) },
    stream: { closeSession: (id) => closed.push(['stream', id]) },
    publicOrigin: O,
    wrapKey,
    operatorHumanId: operator.human_id,
    readBody: async (request) => { let raw = ''; for await (const c of request) raw += c; return raw; },
  });
  const server = createPublicListener({
    publicOrigin: O,
    authenticateCookie: createCookieAuthenticator({ repository }),
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
  return { pool, repository, operator, send, closed };
}

const cookieOf = (res, name) => {
  const header = [].concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`) && !/Max-Age=0/.test(c));
  return header ? header.split(';')[0].slice(name.length + 1) : null;
};

async function login(ctx, { token, githubId }) {
  const start = await ctx.send('POST', '/v1/auth/oauth/github/start', {
    headers: { origin: O, 'content-type': 'application/json' }, body: JSON.stringify(token ? { invite: token } : {}),
  });
  assert.equal(start.status, 302, start.body);
  const flowCookie = cookieOf(start, FLOW_COOKIE);
  const state = new URL(start.headers.location).searchParams.get('state');
  const done = await ctx.send('GET', `/v1/auth/oauth/github/callback?state=${state}&code=c${githubId}`, { headers: { cookie: `${FLOW_COOKIE}=${flowCookie}` } });
  return { start, done, session: cookieOf(done, SESSION_COOKIE) };
}
const me = (ctx, session) => ctx.send('GET', '/v1/auth/me', { headers: { cookie: `${SESSION_COOKIE}=${session}` } });

test('operator --self flow logs in and /me reports is_operator', { skip }, async (t) => {
  const ctx = await setup(t);
  const { token } = await withTransaction(ctx.pool, (c) => createInvite(c, {
    name: 'self', createdByHumanId: ctx.operator.human_id, ttlMs: DAY,
    target: { humanId: ctx.operator.human_id, endpointId: ctx.operator.endpoint_id, issuer: GITHUB, subject: '777' },
  }));
  const { done, session } = await login(ctx, { token, githubId: 777 });
  assert.equal(done.status, 302);
  assert.equal(done.headers.location, '/');
  assert.ok(session);
  const res = await me(ctx, session);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { human_id: ctx.operator.human_id, endpoint_id: ctx.operator.endpoint_id, display_name: 'Operator', is_operator: true });
  // A --self flow skips the global start ceiling.
  const { rows } = await ctx.pool.query(`SELECT scope_kind FROM quota_usage ORDER BY scope_kind`);
  assert.ok(!rows.some((r) => r.scope_kind === 'oauth_start'));
});

test('invited guest logs in with is_operator false; rate-limit scope kinds persist; logout revokes', { skip }, async (t) => {
  const ctx = await setup(t);
  const { token } = await withTransaction(ctx.pool, (c) => createInvite(c, { name: 'guest', createdByHumanId: ctx.operator.human_id, rooms: [], ttlMs: DAY }));
  const { session } = await login(ctx, { token, githubId: 888 });
  assert.ok(session);
  const body = JSON.parse((await me(ctx, session)).body);
  assert.equal(body.is_operator, false);
  assert.notEqual(body.human_id, ctx.operator.human_id);

  const { rows } = await ctx.pool.query(`SELECT DISTINCT scope_kind FROM quota_usage`);
  assert.deepEqual(rows.map((r) => r.scope_kind).sort(), ['invite', 'oauth_provider_subject', 'oauth_start']);

  const out = await ctx.send('POST', '/v1/auth/logout', { headers: { cookie: `${SESSION_COOKIE}=${session}`, origin: O, 'x-sigil-csrf': '1' } });
  assert.equal(out.status, 204);
  assert.equal(ctx.closed.length, 2);
  assert.equal((await me(ctx, session)).status, 401);
  const audit = await ctx.pool.query(`SELECT * FROM audit_events WHERE event_type = 'human_session.revoked'`);
  assert.equal(audit.rowCount, 1);
});

test('a returning user logs in without an invite and the old session is revoked', { skip }, async (t) => {
  const ctx = await setup(t);
  const { token } = await withTransaction(ctx.pool, (c) => createInvite(c, { name: 'guest', createdByHumanId: ctx.operator.human_id, rooms: [], ttlMs: DAY }));
  const first = await login(ctx, { token, githubId: 999 });
  const start = await ctx.send('POST', '/v1/auth/oauth/github/start', { headers: { origin: O, 'content-type': 'application/json' }, body: '{}' });
  const state = new URL(start.headers.location).searchParams.get('state');
  const done = await ctx.send('GET', `/v1/auth/oauth/github/callback?state=${state}&code=c999`, {
    headers: { cookie: `${FLOW_COOKIE}=${cookieOf(start, FLOW_COOKIE)}; ${SESSION_COOKIE}=${first.session}` },
  });
  const second = cookieOf(done, SESSION_COOKIE);
  assert.ok(second && second !== first.session);
  assert.equal((await me(ctx, first.session)).status, 401);
  assert.equal((await me(ctx, second)).status, 200);
});

test('unknown identity without an invite is invite_required; flow store cap yields 503', { skip }, async (t) => {
  const ctx = await setup(t, { flowMax: 1 });
  const { done } = await login(ctx, { token: null, githubId: 555 });
  assert.equal(done.headers.location, '/login?error=invite_required');
  // The consumed flow freed its slot; hold one open and a second start is refused.
  const hold = await ctx.send('POST', '/v1/auth/oauth/github/start', { headers: { origin: O, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(hold.status, 302);
  const busy = await ctx.send('POST', '/v1/auth/oauth/github/start', { headers: { origin: O, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(busy.status, 503);
});
