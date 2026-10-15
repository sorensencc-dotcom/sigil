// Live-Postgres pins for the operator invite and identity-revoke commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createIdentity, saveIdentity } from './identity.mjs';
import { provisionHumanTx } from '../relay/v1/provision-human.mjs';
import { withTransaction } from '../relay/v1/with-transaction.mjs';
import { PostgresRepository } from '../relay/v1/postgres-repository.mjs';
import { startAdminListener, createAdminMessageHandler } from '../relay/v1/admin-notify.mjs';
import { completeLogin } from '../relay/v1/oauth/login-tx.mjs';
import { hashInviteToken } from '../relay/v1/oauth/invites.mjs';
import { cmdInviteCreate, cmdInviteList, cmdInviteRevoke, cmdIdentityRevoke } from './oauth-commands.mjs';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const skip = !connectionString;
const wrapKey = crypto.randomBytes(32);
const GITHUB = 'https://github.com';
const ORIGIN = 'https://relay.example';

// Fake GitHub API: login -> id.
const USERS = { alice: 1001, bob: 1002, carol: 1003 };
const fetchImpl = async (url) => {
  const login = decodeURIComponent(new URL(url).pathname.split('/').pop());
  const id = USERS[login.toLowerCase()];
  return id ? { status: 200, ok: true, json: async () => ({ id, login }) } : { status: 404, ok: false, json: async () => ({}) };
};

async function setup(t) {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString, max: 10 });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyMigrations(connectionString);
  const operator = await withTransaction(pool, (c) => provisionHumanTx(c, { displayName: 'Operator', wrapKey }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-oc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const identityFile = path.join(dir, 'identity.json');
  saveIdentity(identityFile, createIdentity({ ownerId: operator.human_id, endpointId: operator.endpoint_id }));
  const base = ['--identity', identityFile, '--database-url', connectionString];
  const lines = [];
  const deps = { fetchImpl, apiBase: 'http://fake', log: (line) => lines.push(line) };
  return { pool, operator, base, deps, lines, repository: new PostgresRepository({ pool }) };
}

async function seedRoom(pool, operator, roomId) {
  const now = new Date().toISOString();
  await pool.query(`INSERT INTO workspaces (workspace_id, name, created_by, created_at) VALUES ('ws_o', 'ws_o', $1, $2) ON CONFLICT DO NOTHING`, [operator.human_id, now]);
  await pool.query(`INSERT INTO conversations (conversation_id, kind, created_by, created_at) VALUES ($1, 'room', $2, $3)`, [roomId, operator.human_id, now]);
  await pool.query(`INSERT INTO rooms (conversation_id, workspace_id, name, created_at) VALUES ($1, 'ws_o', $1, $2)`, [roomId, now]);
  await pool.query(`INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at) VALUES ($1, $2, 'owner', $3, $4)`, [roomId, operator.endpoint_id, operator.human_id, now]);
}

const tokenOf = (lines) => new URL(lines.find((l) => l.startsWith(`${ORIGIN}/invite#`))).hash.slice(1);
const inviteRow = async (pool, token) => (await pool.query('SELECT * FROM room_invites WHERE token_hash = $1', [hashInviteToken(token)])).rows[0];

test('--self creates a 10-minute pinned invite for the operator and prints the link once', { skip }, async (t) => {
  const { pool, operator, base, deps, lines } = await setup(t);
  await cmdInviteCreate(['--self', '--provider', 'github', '--login', 'Alice', '--public-origin', ORIGIN, ...base], deps);
  const token = tokenOf(lines);
  assert.ok(Buffer.from(token, 'base64url').length >= 24);
  assert.equal(lines.join('\n').split(token).length - 1, 1, 'token printed exactly once');
  const row = await inviteRow(pool, token);
  assert.equal(row.target_human_id, operator.human_id);
  assert.equal(row.target_endpoint_id, operator.endpoint_id);
  assert.equal(row.target_issuer, GITHUB);
  assert.equal(row.target_subject, '1001');
  assert.equal(row.expires_at.getTime() - row.created_at.getTime(), 10 * 60_000);
  assert.ok(!JSON.stringify((await pool.query('SELECT * FROM audit_events')).rows).includes(token));
});

test('--human with two human endpoints requires --endpoint; with it the invite is pinned for 24 h with rooms', { skip }, async (t) => {
  const { pool, operator, base, deps, lines } = await setup(t);
  await seedRoom(pool, operator, 'room_a');
  const guest = await withTransaction(pool, (c) => provisionHumanTx(c, { displayName: 'Guest', wrapKey }));
  const second = await withTransaction(pool, async (c) => {
    const ep = `ep_${crypto.randomBytes(8).toString('hex')}`;
    await c.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at) VALUES ($1,$2,'human','human',$3,'Second','active',now())`, [ep, guest.human_id, `install_${ep}`]);
    return ep;
  });
  const args = ['--human', guest.human_id, '--provider', 'github', '--login', 'bob', '--room', 'room_a:member', '--public-origin', ORIGIN, ...base];
  await assert.rejects(cmdInviteCreate(args, deps), /pass --endpoint/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM room_invites')).rows[0].n, 0);
  await cmdInviteCreate([...args, '--endpoint', second], deps);
  const row = await inviteRow(pool, tokenOf(lines));
  assert.equal(row.target_human_id, guest.human_id);
  assert.equal(row.target_endpoint_id, second);
  assert.equal(row.target_subject, '1002');
  assert.equal(row.expires_at.getTime() - row.created_at.getTime(), 24 * 3600_000);
  assert.equal((await pool.query('SELECT role FROM room_invite_rooms WHERE invite_id = $1', [row.invite_id])).rows[0].role, 'member');
});

test('unknown GitHub login creates nothing; unpinned --name invite is 24 h', { skip }, async (t) => {
  const { pool, operator, base, deps, lines } = await setup(t);
  await seedRoom(pool, operator, 'room_a');
  await assert.rejects(cmdInviteCreate(['--self', '--provider', 'github', '--login', 'ghost', '--public-origin', ORIGIN, ...base], deps), /HTTP 404/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM room_invites')).rows[0].n, 0);
  await cmdInviteCreate(['--name', 'Pat', '--room', 'room_a:room_manager', '--public-origin', ORIGIN, ...base], deps);
  const row = await inviteRow(pool, tokenOf(lines));
  assert.equal(row.target_subject, null);
  assert.equal(row.name, 'Pat');
  assert.equal(row.expires_at.getTime() - row.created_at.getTime(), 24 * 3600_000);
});

test('invite list shows states; revoke changes an open invite and leaves a consumed one alone', { skip }, async (t) => {
  const { pool, base, deps, lines, repository } = await setup(t);
  const mk = async (name) => {
    lines.length = 0;
    await cmdInviteCreate(['--name', name, '--public-origin', ORIGIN, ...base], deps);
    return { token: tokenOf(lines), id: /invite_id: (\S+)/.exec(lines[0])[1] };
  };
  const open = await mk('open');
  const revoked = await mk('revoked');
  const consumed = await mk('consumed');
  await completeLogin({ repository, identity: { issuer: GITHUB, subject: '9', displayName: 'N' }, inviteToken: consumed.token, flowId: 'f', sessionId: crypto.randomBytes(32).toString('hex'), wrapKey });
  lines.length = 0;
  await cmdInviteRevoke([revoked.id, ...base], deps);
  assert.match(lines[0], /^revoked inv_/);
  lines.length = 0;
  await cmdInviteRevoke([consumed.id, ...base], deps);
  assert.match(lines[0], /not revoked/);
  assert.equal((await pool.query('SELECT revoked_at FROM room_invites WHERE invite_id = $1', [consumed.id])).rows[0].revoked_at, null);
  lines.length = 0;
  await cmdInviteList(['--database-url', connectionString], deps);
  const states = Object.fromEntries(lines.map((l) => l.split('\t')).map(([id, state]) => [id, state]));
  assert.deepEqual(states, { [open.id]: 'open', [revoked.id]: 'revoked', [consumed.id]: 'consumed' });
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE event_type = 'invite.revoked'`)).rows[0].n, 1);
});

async function linkIdentity({ base, deps, lines, repository }, login, subject) {
  lines.length = 0;
  await cmdInviteCreate(['--name', login, '--public-origin', ORIGIN, ...base], deps);
  const result = await completeLogin({ repository, identity: { issuer: GITHUB, subject: String(subject), displayName: login }, inviteToken: tokenOf(lines), flowId: `f_${subject}`, sessionId: crypto.randomBytes(32).toString('hex'), wrapKey });
  assert.equal(result.outcome, 'login');
  return result;
}

test('identity revoke revokes the identity and exactly its live sessions, audits, and NOTIFYs a small fixed payload to a relay that revalidates', { skip }, async (t) => {
  const ctx = await setup(t);
  const { pool, base, deps, lines, repository } = ctx;
  const alice = await linkIdentity(ctx, 'alice', 1001);
  await linkIdentity(ctx, 'bob', 1002);
  // 500 sessions for alice: one already revoked, one expired, 498 live.
  await pool.query(
    `INSERT INTO human_sessions (session_id, human_id, endpoint_id, authentication_method, assurance, issued_at, last_seen_at, expires_at, identity_issuer, identity_subject)
     SELECT md5(random()::text || g::text) || md5(g::text), human_id, endpoint_id, authentication_method, assurance, issued_at, last_seen_at, expires_at, identity_issuer, identity_subject
       FROM human_sessions, generate_series(1, 499) g WHERE identity_subject = '1001'`);
  await pool.query(`UPDATE human_sessions SET revoked_at = now() - interval '1 hour' WHERE session_id = (SELECT session_id FROM human_sessions WHERE identity_subject = '1001' LIMIT 1)`);
  await pool.query(`UPDATE human_sessions SET issued_at = now() - interval '3 hours', last_seen_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE session_id = (SELECT session_id FROM human_sessions WHERE identity_subject = '1001' AND revoked_at IS NULL LIMIT 1)`);
  const live = `SELECT count(*)::int AS n FROM human_sessions WHERE identity_subject = $1 AND revoked_at IS NULL AND expires_at > now()`;
  assert.equal((await pool.query(live, ['1001'])).rows[0].n, 498);

  const revalidated = [];
  const payloads = [];
  const stream = { revalidate: async (target) => { revalidated.push(target); } };
  const handle = createAdminMessageHandler({ auth: null, stream, repository, logger: null });
  const raw = new pg.Client({ connectionString });
  await raw.connect();
  t.after(() => raw.end());
  raw.on('notification', (m) => payloads.push(m.payload));
  await raw.query('LISTEN sigil_admin');
  const listener = await startAdminListener({ pool, onMessage: handle, logger: null });
  t.after(() => listener.close());

  lines.length = 0;
  await cmdIdentityRevoke(['--provider', 'github', '--login', 'alice', ...base], deps);
  assert.match(lines[0], /sessions revoked: 498/);

  assert.equal((await pool.query('SELECT status FROM oidc_identities WHERE issuer = $1 AND subject = $2', [GITHUB, '1001'])).rows[0].status, 'revoked');
  assert.equal((await pool.query(`SELECT status FROM oidc_identities WHERE subject = '1002'`)).rows[0].status, 'active');
  assert.equal((await pool.query(live, ['1001'])).rows[0].n, 0);
  assert.equal((await pool.query(live, ['1002'])).rows[0].n, 1, 'other identity untouched');
  const audit = (await pool.query(`SELECT subject_id, object_id FROM audit_events WHERE event_type = 'oidc_identity.revoked'`)).rows;
  assert.deepEqual(audit.map((r) => ({ ...r })), [{ subject_id: `${GITHUB}|1001`, object_id: '1001' }]);

  for (let i = 0; i < 50 && !(payloads.length && revalidated.length); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(payloads.length, 1);
  assert.ok(Buffer.byteLength(payloads[0]) < 200);
  assert.deepEqual(JSON.parse(payloads[0]), { type: 'identity.revoked', human_id: alice.human_id });
  assert.deepEqual(revalidated, [{ humanId: alice.human_id, endpointId: undefined }]);

  await assert.rejects(cmdIdentityRevoke(['--provider', 'github', '--subject', '99999', ...base], deps), /no OAuth-verified github identity/);
});

test('after identity revoke, login with no invite is denied; a fresh pinned invite reactivates', { skip }, async (t) => {
  const ctx = await setup(t);
  const { pool, base, deps, lines, repository } = ctx;
  await linkIdentity(ctx, 'alice', 1001);
  await cmdIdentityRevoke(['--provider', 'github', '--subject', '1001', ...base], deps);
  const who = { issuer: GITHUB, subject: '1001', displayName: 'alice' };
  const attempt = (inviteToken) => completeLogin({ repository, identity: who, inviteToken, flowId: 'f_re', sessionId: crypto.randomBytes(32).toString('hex'), wrapKey });
  assert.equal((await attempt(null)).outcome, 'denied');
  assert.equal((await pool.query(`SELECT status FROM oidc_identities WHERE subject = '1001'`)).rows[0].status, 'revoked');

  const { human_id: humanId, endpoint_id: endpointId } = (await pool.query(`SELECT human_id, endpoint_id FROM oidc_identities WHERE subject = '1001'`)).rows[0];
  lines.length = 0;
  await cmdInviteCreate(['--human', humanId, '--endpoint', endpointId, '--provider', 'github', '--login', 'alice', '--public-origin', ORIGIN, ...base], deps);
  assert.equal((await attempt(tokenOf(lines))).outcome, 'login');
  assert.equal((await pool.query(`SELECT status FROM oidc_identities WHERE subject = '1001'`)).rows[0].status, 'active');
});
