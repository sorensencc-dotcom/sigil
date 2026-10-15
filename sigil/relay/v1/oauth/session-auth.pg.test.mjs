// Live-Postgres pins for the cookie authenticator (login spec, "Session
// authentication"). Each case logs in for real, then asserts on the principal.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { provisionHumanTx } from '../provision-human.mjs';
import { PostgresRepository } from '../postgres-repository.mjs';
import { withTransaction } from '../with-transaction.mjs';
import { createInvite } from './invites.mjs';
import { completeLogin } from './login-tx.mjs';
import { newCookieSecret, SESSION_COOKIE } from './cookies.mjs';
import { createCookieAuthenticator, SESSION_IDLE_MS } from './session-auth.mjs';
import { assertDisposableTestDatabase } from '../../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const skip = !connectionString;
const wrapKey = crypto.randomBytes(32);
const NOW = new Date('2030-01-02T03:04:05.000Z');
const GITHUB = 'https://github.com';
const MIN = 60_000;
const at = (offsetMs) => new Date(NOW.getTime() + offsetMs);

async function setup(t) {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString, max: 10 });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyMigrations(connectionString);
  const repository = new PostgresRepository({ pool });
  const operator = await withTransaction(pool, (c) => provisionHumanTx(c, { displayName: 'Operator', wrapKey, now: NOW }));
  await pool.query(`INSERT INTO workspaces (workspace_id, name, created_by, created_at) VALUES ('ws_t', 'ws_t', $1, $2)`, [operator.human_id, NOW]);
  await pool.query(`INSERT INTO conversations (conversation_id, kind, created_by, created_at) VALUES ('room_a', 'room', $1, $2)`, [operator.human_id, NOW]);
  await pool.query(`INSERT INTO rooms (conversation_id, workspace_id, name, created_at) VALUES ('room_a', 'ws_t', 'room_a', $1)`, [NOW]);
  await pool.query(`INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at) VALUES ('room_a', $1, 'owner', $2, $3)`, [operator.endpoint_id, operator.human_id, NOW]);
  return { pool, repository, operator };
}

// A real logged-in cookie session: returns the raw cookie value and the ids.
async function loggedIn({ pool, repository, operator }, n = 1) {
  const { token } = await withTransaction(pool, (c) => createInvite(c, { name: 'guest', createdByHumanId: operator.human_id, rooms: [], ttlMs: 24 * 3600_000, now: NOW }));
  const cookie = newCookieSecret();
  const result = await completeLogin({
    repository, identity: { issuer: GITHUB, subject: String(n), displayName: `G${n}` },
    inviteToken: token, flowId: 'flow_t', sessionId: cookie.hash, wrapKey, now: NOW,
  });
  assert.equal(result.outcome, 'login');
  return { cookie: cookie.value, sessionId: cookie.hash, subject: String(n), ...result };
}

const req = (cookie, extra = {}) => ({ headers: { ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}), ...extra } });
const lastSeen = async (pool, sessionId) => (await pool.query('SELECT last_seen_at FROM human_sessions WHERE session_id = $1', [sessionId])).rows[0].last_seen_at;

test('1. valid cookie yields the principal', { skip }, async (t) => {
  const ctx = await setup(t);
  const s = await loggedIn(ctx);
  const auth = createCookieAuthenticator({ repository: ctx.repository, now: () => at(MIN) });
  const principal = await auth(req(s.cookie));
  assert.deepEqual(principal, {
    endpoint_id: s.endpoint_id, owner_id: s.human_id, human_id: s.human_id,
    session_id: s.sessionId, display_name: principal.display_name,
  });
  assert.equal(typeof principal.display_name, 'string');
  assert.ok(principal.display_name.length > 0);
});

test('2. no cookie, unknown cookie, or bearer only yields null', { skip }, async (t) => {
  const ctx = await setup(t);
  const s = await loggedIn(ctx);
  const auth = createCookieAuthenticator({ repository: ctx.repository, now: () => at(MIN) });
  assert.equal(await auth(req(null)), null);
  assert.equal(await auth(req(newCookieSecret().value)), null);
  assert.equal(await auth(req(null, { authorization: `Bearer ${s.cookie}` })), null);
  assert.equal(await auth({ headers: {} }), null);
});

test('3. a step-up session row (null endpoint_id) yields null', { skip }, async (t) => {
  const ctx = await setup(t);
  const cookie = newCookieSecret();
  await ctx.repository.createHumanSession({
    sessionId: cookie.hash, humanId: ctx.operator.human_id, authenticationMethod: 'passkey',
    assurance: 'standard', issuedAt: NOW, expiresAt: at(24 * 3600_000),
  });
  const auth = createCookieAuthenticator({ repository: ctx.repository, now: () => at(MIN) });
  assert.equal(await auth(req(cookie.value)), null);
});

test('4. each unusable state yields null', { skip }, async (t) => {
  const ctx = await setup(t);
  const { pool } = ctx;
  const cases = [
    ['revoked session', 'UPDATE human_sessions SET revoked_at = $1 WHERE session_id = $2', (s) => [NOW, s.sessionId], MIN],
    ['expired session', null, null, 8 * 24 * 3600_000],
    ['idle past 8 h', null, null, SESSION_IDLE_MS + MIN],
    ['revoked identity', `UPDATE oidc_identities SET status = 'revoked' WHERE issuer = '${GITHUB}' AND subject = $1`, (s) => [s.subject], MIN],
    ['suspended human', `UPDATE humans SET status = 'suspended' WHERE human_id = $1`, (s) => [s.human_id], MIN],
    ['suspended endpoint', `UPDATE endpoints SET status = 'suspended' WHERE endpoint_id = $1`, (s) => [s.endpoint_id], MIN],
    ['non-human endpoint kind', `UPDATE endpoints SET kind = 'agent' WHERE endpoint_id = $1`, (s) => [s.endpoint_id], MIN],
  ];
  let n = 0;
  for (const [name, sql, params, offset] of cases) {
    n += 1;
    const s = await loggedIn(ctx, 100 + n);
    const usable = createCookieAuthenticator({ repository: ctx.repository, now: () => at(MIN) });
    assert.ok(await usable(req(s.cookie)), `${name}: usable before the change`);
    if (sql) await pool.query(sql, params(s));
    const auth = createCookieAuthenticator({ repository: ctx.repository, now: () => at(offset) });
    assert.equal(await auth(req(s.cookie)), null, name);
  }
});

test('5. last_seen_at is touched only when more than 5 minutes stale', { skip }, async (t) => {
  const ctx = await setup(t);
  const s = await loggedIn(ctx);
  assert.equal((await lastSeen(ctx.pool, s.sessionId)).getTime(), NOW.getTime());
  await createCookieAuthenticator({ repository: ctx.repository, now: () => at(MIN) })(req(s.cookie));
  assert.equal((await lastSeen(ctx.pool, s.sessionId)).getTime(), NOW.getTime(), 'unchanged after 1 minute');
  await createCookieAuthenticator({ repository: ctx.repository, now: () => at(6 * MIN) })(req(s.cookie));
  assert.equal((await lastSeen(ctx.pool, s.sessionId)).getTime(), at(6 * MIN).getTime(), 'updated after 6 minutes');
});
