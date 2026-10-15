// Live-Postgres pins for the OAuth callback decision (spec "Callback decision",
// "Linking transaction", "Reactivation transaction", and the audit subject
// rules in "Errors and abuse handling"). Every case asserts on database rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { provisionHumanTx } from '../provision-human.mjs';
import { PostgresRepository } from '../postgres-repository.mjs';
import { withTransaction } from '../with-transaction.mjs';
import { createInvite, revokeInvite } from './invites.mjs';
import { completeLogin, SESSION_ABSOLUTE_MS } from './login-tx.mjs';
import { assertDisposableTestDatabase } from '../../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const skip = !connectionString;
const wrapKey = crypto.randomBytes(32);
const NOW = new Date('2030-01-02T03:04:05.000Z');
const GITHUB = 'https://github.com';
const DAY = 24 * 3600_000;

const identity = (n) => ({ issuer: GITHUB, subject: String(n), displayName: `G${n}` });
const freshSessionId = () => crypto.randomBytes(32).toString('hex');

async function setup(t) {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString, max: 10 });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyMigrations(connectionString);
  const repository = new PostgresRepository({ pool });
  const operator = await makeOperator(pool);
  await pool.query(`INSERT INTO workspaces (workspace_id, name, created_by, created_at) VALUES ('ws_t', 'ws_t', $1, $2)`, [operator.human_id, NOW]);
  for (const id of ['room_a', 'room_b']) await makeRoom(pool, operator, id);
  return { pool, repository, operator };
}

// `human add` / operator provisioning: a human with one kind='human' endpoint.
function makeOperator(pool, displayName = 'Operator') {
  return withTransaction(pool, (c) => provisionHumanTx(c, { displayName, wrapKey, now: NOW }));
}

async function makeRoom(pool, operator, roomId) {
  await pool.query(`INSERT INTO conversations (conversation_id, kind, created_by, created_at) VALUES ($1, 'room', $2, $3)`, [roomId, operator.human_id, NOW]);
  await pool.query(`INSERT INTO rooms (conversation_id, workspace_id, name, created_at) VALUES ($1, 'ws_t', $1, $2)`, [roomId, NOW]);
  await pool.query(`INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at) VALUES ($1, $2, 'owner', $3, $4)`, [roomId, operator.endpoint_id, operator.human_id, NOW]);
}

async function makeInviteFor(pool, operator, { rooms = [], target = null, ttlMs = DAY, name = 'guest' } = {}) {
  const { invite_id, token } = await withTransaction(pool, (c) => createInvite(c, { name, createdByHumanId: operator.human_id, rooms, target, ttlMs, now: NOW }));
  return { inviteId: invite_id, token };
}

function login(repository, { identity: who, inviteToken = null, flowId = 'flow_test', sessionId = freshSessionId(), now = NOW }) {
  return completeLogin({ repository, identity: who, inviteToken, flowId, sessionId, wrapKey, now });
}

const count = async (pool, table, where = 'TRUE', params = []) => (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0].n;
async function counts(pool) {
  const out = {};
  for (const table of ['humans', 'endpoints', 'endpoint_keys', 'oidc_identities', 'human_sessions']) out[table] = await count(pool, table);
  return out;
}
const inviteRow = async (pool, inviteId) => (await pool.query('SELECT * FROM room_invites WHERE invite_id = $1', [inviteId])).rows[0];
const identityRow = async (pool, who) => (await pool.query('SELECT * FROM oidc_identities WHERE issuer = $1 AND subject = $2', [who.issuer, who.subject])).rows[0];
const auditRows = async (pool, type) => (await pool.query('SELECT * FROM audit_events WHERE event_type = $1 ORDER BY created_at, event_id', [type])).rows;

async function linkNew(pool, repository, operator, n) {
  const { token } = await makeInviteFor(pool, operator);
  const result = await login(repository, { identity: identity(n), inviteToken: token });
  assert.equal(result.outcome, 'login');
  return result;
}

test('1. first contact: an open invite provisions one human, endpoint, key, verified identity, and session, and consumes the invite', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const { inviteId, token } = await makeInviteFor(pool, operator, { name: 'Pat', rooms: [{ roomId: 'room_a', role: 'member' }, { roomId: 'room_b', role: 'room_manager' }] });
  const before = await counts(pool);
  const sessionId = freshSessionId();
  const result = await login(repository, { identity: identity(1), inviteToken: token, sessionId });
  assert.equal(result.outcome, 'login');
  assert.deepEqual(result.audit, { type: 'oauth_login.success', subjectId: result.human_id });

  const after = await counts(pool);
  for (const table of Object.keys(before)) assert.equal(after[table], before[table] + 1, `${table} grows by one`);
  const human = (await pool.query('SELECT * FROM humans WHERE human_id = $1', [result.human_id])).rows[0];
  assert.equal(human.status, 'active');
  const ep = (await pool.query('SELECT * FROM endpoints WHERE endpoint_id = $1', [result.endpoint_id])).rows[0];
  assert.equal(ep.owner_id, result.human_id);
  assert.equal(ep.kind, 'human');
  assert.equal(ep.display_name, 'Pat');
  assert.equal(await count(pool, 'endpoint_keys', 'endpoint_id = $1', [result.endpoint_id]), 1);

  const idRow = await identityRow(pool, identity(1));
  assert.equal(idRow.verified_via, 'oauth');
  assert.equal(idRow.endpoint_id, result.endpoint_id);
  assert.equal(idRow.human_id, result.human_id);
  assert.equal(idRow.status, 'active');

  const session = (await pool.query('SELECT * FROM human_sessions WHERE session_id = $1', [sessionId])).rows[0];
  assert.equal(session.human_id, result.human_id);
  assert.equal(session.endpoint_id, result.endpoint_id);
  assert.equal(session.authentication_method, 'oauth_github');
  assert.equal(session.assurance, 'standard');
  assert.equal(session.last_seen_at.toISOString(), NOW.toISOString());
  assert.equal(session.issued_at.toISOString(), NOW.toISOString());
  assert.equal(session.expires_at.getTime(), NOW.getTime() + SESSION_ABSOLUTE_MS);
  assert.equal(session.identity_issuer, GITHUB);
  assert.equal(session.identity_subject, '1');
  assert.equal(session.revoked_at, null);

  const invite = await inviteRow(pool, inviteId);
  assert.equal(invite.consumed_at.toISOString(), NOW.toISOString());
  assert.equal(invite.consumed_by_human_id, result.human_id);

  const members = (await pool.query('SELECT conversation_id, role, added_by FROM conversation_members WHERE endpoint_id = $1 AND removed_at IS NULL ORDER BY conversation_id', [result.endpoint_id])).rows;
  assert.deepEqual(members, [
    { conversation_id: 'room_a', role: 'member', added_by: operator.human_id },
    { conversation_id: 'room_b', role: 'room_manager', added_by: operator.human_id },
  ]);

  const attrs = (await pool.query(`SELECT kind, convert_from(value_or_ciphertext, 'UTF8') AS value, source, verification_state FROM human_attributes WHERE human_id = $1 ORDER BY source`, [result.human_id])).rows;
  assert.deepEqual(attrs, [
    { kind: 'name', value: 'G1', source: 'github', verification_state: 'unverified' },
    { kind: 'name', value: 'Pat', source: 'operator', verification_state: 'unverified' },
  ]);

  const redeemed = await auditRows(pool, 'invite.redeemed');
  assert.equal(redeemed.length, 1);
  assert.equal(redeemed[0].subject_id, result.human_id);
  assert.equal(redeemed[0].object_id, inviteId);
  const success = await auditRows(pool, 'oauth_login.success');
  assert.equal(success.length, 1);
  assert.equal(success[0].subject_id, result.human_id);
});

test('2. atomicity: losing the creator\'s manager role on one room aborts with invite_expired and writes nothing', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const { inviteId, token } = await makeInviteFor(pool, operator, { rooms: [{ roomId: 'room_a', role: 'member' }, { roomId: 'room_b', role: 'room_manager' }] });
  await pool.query(`UPDATE conversation_members SET role = 'member' WHERE conversation_id = 'room_b' AND endpoint_id = $1`, [operator.endpoint_id]);
  const before = await counts(pool);
  const attrsBefore = await count(pool, 'human_attributes');
  const result = await login(repository, { identity: identity(2), inviteToken: token });
  assert.equal(result.outcome, 'invite_expired');
  assert.deepEqual(await counts(pool), before);
  assert.equal(await count(pool, 'human_attributes'), attrsBefore);
  assert.equal(await count(pool, 'human_signing_keys'), before.endpoint_keys);
  const invite = await inviteRow(pool, inviteId);
  assert.equal(invite.consumed_at, null);
  assert.equal(invite.consumed_by_human_id, null);
  assert.equal((await auditRows(pool, 'invite.redeemed')).length, 0);
});

test('3. returning login needs no invite, keeps the endpoint, and ignores an unrelated open invite', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const { inviteId, token } = await makeInviteFor(pool, operator, { rooms: [{ roomId: 'room_a', role: 'member' }] });
  const first = await login(repository, { identity: identity(3), inviteToken: token });
  assert.equal(first.outcome, 'login');
  const consumedBefore = await inviteRow(pool, inviteId);
  const before = await counts(pool);

  const sessionId = freshSessionId();
  const again = await login(repository, { identity: identity(3), sessionId });
  assert.equal(again.outcome, 'login');
  assert.equal(again.endpoint_id, first.endpoint_id);
  assert.equal(again.human_id, first.human_id);
  const session = (await pool.query('SELECT * FROM human_sessions WHERE session_id = $1', [sessionId])).rows[0];
  assert.equal(session.endpoint_id, first.endpoint_id);
  assert.equal(session.last_seen_at.toISOString(), NOW.toISOString());
  assert.deepEqual(await inviteRow(pool, inviteId), consumedBefore, 'the redeemed invite is untouched');

  const unrelated = await makeInviteFor(pool, operator, { rooms: [{ roomId: 'room_b', role: 'member' }] });
  const third = await login(repository, { identity: identity(3), inviteToken: unrelated.token });
  assert.equal(third.outcome, 'login');
  assert.equal(third.endpoint_id, first.endpoint_id);
  const open = await inviteRow(pool, unrelated.inviteId);
  assert.equal(open.consumed_at, null, 'an invite on a returning flow is not consumed');
  assert.equal(await count(pool, 'conversation_members', 'endpoint_id = $1 AND conversation_id = $2', [first.endpoint_id, 'room_b']), 0, 'its rooms are not added');
  const after = await counts(pool);
  assert.equal(after.humans, before.humans);
  assert.equal(after.oidc_identities, before.oidc_identities);
  assert.equal(after.human_sessions, before.human_sessions + 2);
  assert.equal((await auditRows(pool, 'invite.redeemed')).length, 1);
});

test('4. unknown identity with no invite is invite_required; expired, revoked, consumed, and unknown tokens are invite_expired', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const baseline = await counts(pool);
  assert.equal((await login(repository, { identity: identity(40) })).outcome, 'invite_required');
  assert.deepEqual(await counts(pool), baseline);

  const expiring = await makeInviteFor(pool, operator, { ttlMs: 1_000 });
  assert.equal((await login(repository, { identity: identity(41), inviteToken: expiring.token, now: new Date(NOW.getTime() + 10_000) })).outcome, 'invite_expired');
  assert.equal((await inviteRow(pool, expiring.inviteId)).consumed_at, null);

  const revoked = await makeInviteFor(pool, operator);
  await withTransaction(pool, (c) => revokeInvite(c, { inviteId: revoked.inviteId, actorHumanId: operator.human_id, now: NOW }));
  assert.equal((await login(repository, { identity: identity(42), inviteToken: revoked.token })).outcome, 'invite_expired');
  assert.equal((await inviteRow(pool, revoked.inviteId)).consumed_at, null);

  assert.equal((await login(repository, { identity: identity(43), inviteToken: crypto.randomBytes(24).toString('base64url') })).outcome, 'invite_expired');
  assert.deepEqual(await counts(pool), baseline, 'none of the failures wrote rows');

  const used = await makeInviteFor(pool, operator);
  const winner = await login(repository, { identity: identity(44), inviteToken: used.token });
  assert.equal(winner.outcome, 'login');
  const afterWinner = await counts(pool);
  assert.equal((await login(repository, { identity: identity(45), inviteToken: used.token })).outcome, 'invite_expired');
  assert.deepEqual(await counts(pool), afterWinner);
  assert.equal((await inviteRow(pool, used.inviteId)).consumed_by_human_id, winner.human_id);
  assert.equal(await identityRow(pool, identity(45)), undefined);
});

test('5. concurrent redemption of one invite by two identities: exactly one login, one human', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const { inviteId, token } = await makeInviteFor(pool, operator, { rooms: [{ roomId: 'room_a', role: 'member' }] });
  const before = await counts(pool);
  const results = await Promise.all([
    login(repository, { identity: identity(50), inviteToken: token }),
    login(repository, { identity: identity(51), inviteToken: token }),
  ]);
  assert.deepEqual(results.map((r) => r.outcome).sort(), ['invite_expired', 'login']);
  const winner = results.find((r) => r.outcome === 'login');
  const after = await counts(pool);
  assert.equal(after.humans, before.humans + 1);
  assert.equal(after.endpoints, before.endpoints + 1);
  assert.equal(after.oidc_identities, before.oidc_identities + 1);
  assert.equal(after.human_sessions, before.human_sessions + 1);
  assert.equal((await inviteRow(pool, inviteId)).consumed_by_human_id, winner.human_id);
  assert.equal((await auditRows(pool, 'invite.redeemed')).length, 1);
});

test('6. two invites over the same rooms in opposite order redeem concurrently without deadlock', { skip, timeout: 30_000 }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const ab = await makeInviteFor(pool, operator, { rooms: [{ roomId: 'room_a', role: 'member' }, { roomId: 'room_b', role: 'member' }] });
  const ba = await makeInviteFor(pool, operator, { rooms: [{ roomId: 'room_b', role: 'room_manager' }, { roomId: 'room_a', role: 'room_manager' }] });
  const [r1, r2] = await Promise.all([
    login(repository, { identity: identity(60), inviteToken: ab.token }),
    login(repository, { identity: identity(61), inviteToken: ba.token }),
  ]);
  assert.equal(r1.outcome, 'login');
  assert.equal(r2.outcome, 'login');
  assert.notEqual(r1.human_id, r2.human_id);
  for (const [r, role] of [[r1, 'member'], [r2, 'room_manager']]) {
    const rows = (await pool.query('SELECT conversation_id, role FROM conversation_members WHERE endpoint_id = $1 ORDER BY conversation_id', [r.endpoint_id])).rows;
    assert.deepEqual(rows, [{ conversation_id: 'room_a', role }, { conversation_id: 'room_b', role }]);
  }
  assert.ok((await inviteRow(pool, ab.inviteId)).consumed_at);
  assert.ok((await inviteRow(pool, ba.inviteId)).consumed_at);
});

test('7. a --self invite pinned to (github, 7) denies (github, 8) and links (github, 7) to the operator without a second human', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const { inviteId, token } = await makeInviteFor(pool, operator, {
    ttlMs: 10 * 60_000,
    target: { humanId: operator.human_id, endpointId: operator.endpoint_id, issuer: GITHUB, subject: '7' },
  });
  const before = await counts(pool);
  const denied = await login(repository, { identity: identity(8), inviteToken: token, flowId: 'flow_7' });
  assert.equal(denied.outcome, 'denied');
  assert.deepEqual(await counts(pool), before);
  assert.equal(await count(pool, 'oidc_identities'), 0);
  assert.equal((await inviteRow(pool, inviteId)).consumed_at, null);
  const deniedAudit = await auditRows(pool, 'oauth_login.denied');
  assert.equal(deniedAudit.length, 1);
  assert.equal(deniedAudit[0].subject_id, 'flow:flow_7');
  assert.equal(deniedAudit[0].actor_human_id, null);

  const ok = await login(repository, { identity: identity(7), inviteToken: token });
  assert.equal(ok.outcome, 'login');
  assert.equal(ok.human_id, operator.human_id);
  assert.equal(ok.endpoint_id, operator.endpoint_id);
  const after = await counts(pool);
  assert.equal(after.humans, before.humans, 'no second human');
  assert.equal(after.endpoints, before.endpoints);
  assert.equal(after.oidc_identities, 1);
  const idRow = await identityRow(pool, identity(7));
  assert.equal(idRow.human_id, operator.human_id);
  assert.equal(idRow.endpoint_id, operator.endpoint_id);
  assert.equal(idRow.verified_via, 'oauth');
  const invite = await inviteRow(pool, inviteId);
  assert.equal(invite.consumed_by_human_id, operator.human_id);
});

test('8. a targeted invite for an existing human links to that endpoint and adds the listed rooms without provisioning', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const guest = await makeOperator(pool, 'Guest');
  const { inviteId, token } = await makeInviteFor(pool, operator, {
    rooms: [{ roomId: 'room_a', role: 'member' }],
    target: { humanId: guest.human_id, endpointId: guest.endpoint_id, issuer: GITHUB, subject: '80' },
  });
  const before = await counts(pool);
  const result = await login(repository, { identity: identity(80), inviteToken: token });
  assert.equal(result.outcome, 'login');
  assert.equal(result.human_id, guest.human_id);
  assert.equal(result.endpoint_id, guest.endpoint_id);
  const after = await counts(pool);
  assert.equal(after.humans, before.humans);
  assert.equal(after.endpoints, before.endpoints);
  assert.equal(after.endpoint_keys, before.endpoint_keys);
  assert.equal(after.oidc_identities, before.oidc_identities + 1);
  assert.equal((await identityRow(pool, identity(80))).endpoint_id, guest.endpoint_id);
  const members = (await pool.query('SELECT conversation_id, role, added_by FROM conversation_members WHERE endpoint_id = $1', [guest.endpoint_id])).rows;
  assert.deepEqual(members, [{ conversation_id: 'room_a', role: 'member', added_by: operator.human_id }]);
  assert.equal((await inviteRow(pool, inviteId)).consumed_by_human_id, guest.human_id);
});

test('9. a verified identity arriving with a targeted invite for another human is denied and the invite is not consumed', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const linked = await linkNew(pool, repository, operator, 90);
  const { inviteId, token } = await makeInviteFor(pool, operator, {
    target: { humanId: operator.human_id, endpointId: operator.endpoint_id, issuer: GITHUB, subject: '90' },
  });
  const sessionsBefore = await count(pool, 'human_sessions');
  const result = await login(repository, { identity: identity(90), inviteToken: token });
  assert.equal(result.outcome, 'denied');
  assert.equal(await count(pool, 'human_sessions'), sessionsBefore);
  assert.equal((await inviteRow(pool, inviteId)).consumed_at, null);
  const denied = await auditRows(pool, 'oauth_login.denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].subject_id, linked.human_id);
});

test('10. a revoked identity is denied, reactivated only by a pinned targeted invite for its own human, and stays revoked otherwise', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const who = identity(100);
  const linked = await linkNew(pool, repository, operator, 100);
  const revoke = async () => {
    await pool.query(`UPDATE oidc_identities SET status = 'revoked' WHERE issuer = $1 AND subject = $2`, [who.issuer, who.subject]);
    await pool.query(`UPDATE human_sessions SET revoked_at = $3 WHERE identity_issuer = $1 AND identity_subject = $2 AND revoked_at IS NULL`, [who.issuer, who.subject, NOW]);
  };
  await revoke();
  const revokedSessions = (await pool.query('SELECT session_id FROM human_sessions WHERE human_id = $1', [linked.human_id])).rows.map((r) => r.session_id);

  assert.equal((await login(repository, { identity: who })).outcome, 'denied', 'no invite');

  const pin = (subject) => ({ humanId: linked.human_id, endpointId: linked.endpoint_id, issuer: GITHUB, subject });
  const mismatched = await makeInviteFor(pool, operator, { target: pin('999') });
  assert.equal((await login(repository, { identity: who, inviteToken: mismatched.token })).outcome, 'denied', 'mismatched pin');
  assert.equal((await inviteRow(pool, mismatched.inviteId)).consumed_at, null);
  assert.equal((await identityRow(pool, who)).status, 'revoked');

  const good = await makeInviteFor(pool, operator, { target: pin('100') });
  const sessionId = freshSessionId();
  const result = await login(repository, { identity: who, inviteToken: good.token, sessionId });
  assert.equal(result.outcome, 'login');
  assert.equal(result.human_id, linked.human_id);
  assert.equal(result.endpoint_id, linked.endpoint_id);
  assert.equal((await identityRow(pool, who)).status, 'active');
  assert.equal((await inviteRow(pool, good.inviteId)).consumed_by_human_id, linked.human_id);
  const live = (await pool.query('SELECT session_id FROM human_sessions WHERE human_id = $1 AND revoked_at IS NULL', [linked.human_id])).rows.map((r) => r.session_id);
  assert.deepEqual(live, [sessionId], 'only the new session is live');
  for (const id of revokedSessions) {
    assert.ok((await pool.query('SELECT revoked_at FROM human_sessions WHERE session_id = $1', [id])).rows[0].revoked_at, 'earlier sessions stay revoked');
  }
  const reactivated = await auditRows(pool, 'oidc_identity.reactivated');
  assert.equal(reactivated.length, 1);
  // Spec "Errors and abuse handling": oidc_identity.reactivated uses <issuer>|<subject>.
  assert.equal(reactivated[0].subject_id, `${GITHUB}|100`);
  assert.equal(reactivated[0].actor_human_id, linked.human_id);

  // Suspended human with a matching pinned invite: denied, nothing reactivated.
  await revoke();
  const forSuspended = await makeInviteFor(pool, operator, { target: pin('100') });
  await repository.suspendHuman({ humanId: linked.human_id, actorHumanId: operator.human_id });
  const sessionsBefore = await count(pool, 'human_sessions');
  assert.equal((await login(repository, { identity: who, inviteToken: forSuspended.token })).outcome, 'denied', 'suspended human');
  assert.equal((await inviteRow(pool, forSuspended.inviteId)).consumed_at, null);
  assert.equal((await identityRow(pool, who)).status, 'revoked');
  assert.equal(await count(pool, 'human_sessions'), sessionsBefore);
});

test('11. a suspended human or endpoint with a verified row is denied and never falls through to linking, even with an invite', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const who = identity(110);
  const linked = await linkNew(pool, repository, operator, 110);
  await repository.suspendHuman({ humanId: linked.human_id, actorHumanId: operator.human_id });
  const open = await makeInviteFor(pool, operator);
  const before = await counts(pool);
  assert.equal((await login(repository, { identity: who })).outcome, 'denied');
  assert.equal((await login(repository, { identity: who, inviteToken: open.token })).outcome, 'denied');
  assert.deepEqual(await counts(pool), before);
  assert.equal((await inviteRow(pool, open.inviteId)).consumed_at, null);

  await repository.unsuspendHuman({ humanId: linked.human_id, actorHumanId: operator.human_id });
  await pool.query(`UPDATE endpoints SET status = 'suspended' WHERE endpoint_id = $1`, [linked.endpoint_id]);
  assert.equal((await login(repository, { identity: who, inviteToken: open.token })).outcome, 'denied', 'suspended endpoint');
  assert.deepEqual(await counts(pool), before);
  assert.equal((await inviteRow(pool, open.inviteId)).consumed_at, null);
  const denied = await auditRows(pool, 'oauth_login.denied');
  assert.equal(denied.length, 3);
  assert.ok(denied.every((row) => row.subject_id === linked.human_id && row.actor_human_id === linked.human_id));
});

// Gates are deterministic: each side waits on an observed lock wait in
// pg_stat_activity (pg_blocking_pids), never on a fixed sleep.
async function waitUntilBlockedBy(pool, blockerPid) {
  for (let i = 0; i < 1000; i++) {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [blockerPid]);
    if (rows[0].n > 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`no backend became blocked by pid ${blockerPid}`);
}

test('12. suspension racing a returning login never leaves a live session for a suspended human (both commit orders)', { skip, timeout: 30_000 }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const who = identity(120);
  const linked = await linkNew(pool, repository, operator, 120);
  const liveForSuspended = async () => count(pool, 'human_sessions s JOIN humans h ON h.human_id = s.human_id',
    `h.status = 'suspended' AND s.revoked_at IS NULL AND s.human_id = $1`, [linked.human_id]);

  // Order A: the suspension's UPDATE is in flight first. The login's FOR SHARE
  // on humans waits for it, then reads 'suspended' and is denied.
  const suspender = await pool.connect();
  try {
    const [{ pid }] = (await suspender.query('SELECT pg_backend_pid() AS pid')).rows;
    await suspender.query('BEGIN');
    await repository.suspendHuman({ humanId: linked.human_id, actorHumanId: operator.human_id }, suspender);
    const sessionsBefore = await count(pool, 'human_sessions');
    const pending = login(repository, { identity: who });
    await waitUntilBlockedBy(pool, pid);
    await suspender.query('COMMIT');
    assert.equal((await pending).outcome, 'denied');
    assert.equal(await count(pool, 'human_sessions'), sessionsBefore);
  } finally {
    suspender.release();
  }
  assert.equal(await liveForSuspended(), 0);
  await repository.unsuspendHuman({ humanId: linked.human_id, actorHumanId: operator.human_id });

  // Order B: the login holds its locks (paused just before the session insert);
  // the suspension blocks on them, the login commits, and the suspension's
  // sweep revokes the session the login wrote.
  let reached;
  const atSession = new Promise((resolve) => { reached = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let loginPid = null;
  const gated = new Proxy(repository, {
    get(target, prop) {
      if (prop === 'createHumanSession') {
        return async (args) => {
          loginPid = (await args.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          reached();
          await gate;
          return target.createHumanSession(args);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const sessionId = freshSessionId();
  const pending = completeLogin({ repository: gated, identity: who, flowId: 'flow_12', sessionId, wrapKey, now: NOW });
  await atSession;
  const suspension = repository.suspendHuman({ humanId: linked.human_id, actorHumanId: operator.human_id });
  await waitUntilBlockedBy(pool, loginPid);
  release();
  const result = await pending;
  await suspension;
  assert.equal(result.outcome, 'login');
  const session = (await pool.query('SELECT revoked_at FROM human_sessions WHERE session_id = $1', [sessionId])).rows[0];
  assert.ok(session, 'the login committed its session');
  assert.ok(session.revoked_at, 'the suspension sweep revoked it');
  assert.equal((await pool.query('SELECT status FROM humans WHERE human_id = $1', [linked.human_id])).rows[0].status, 'suspended');
  assert.equal(await liveForSuspended(), 0);
});

test('13. a planted unverified row is ignored by step 1; linking the same pair collides on the PK and returns denied without writing', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const who = identity(130);
  await pool.query(`INSERT INTO oidc_identities (issuer, subject, human_id, status, created_at) VALUES ($1, $2, $3, 'active', $4)`, [who.issuer, who.subject, operator.human_id, NOW]);
  const before = await counts(pool);
  const attrsBefore = await count(pool, 'human_attributes');

  // Step 1 does not treat the planted row as an identity: no login as the operator.
  assert.equal((await login(repository, { identity: who })).outcome, 'invite_required');

  const { inviteId, token } = await makeInviteFor(pool, operator);
  const result = await login(repository, { identity: who, inviteToken: token, flowId: 'flow_13' });
  assert.equal(result.outcome, 'denied');
  assert.deepEqual(await counts(pool), before);
  assert.equal(await count(pool, 'human_attributes'), attrsBefore);
  assert.equal((await inviteRow(pool, inviteId)).consumed_at, null);
  const planted = await identityRow(pool, who);
  assert.equal(planted.verified_via, null);
  assert.equal(planted.human_id, operator.human_id);
  const denied = await auditRows(pool, 'oauth_login.denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].subject_id, 'flow:flow_13');
});

test('14. denial audits use the human id for a known human and flow:<flowId> otherwise; no audit row holds the subject or its hash', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const known = identity('98765432101');
  const unknown = identity('98765432102');
  const { token } = await makeInviteFor(pool, operator);
  const linked = await login(repository, { identity: known, inviteToken: token });
  assert.equal(linked.outcome, 'login');
  await repository.suspendHuman({ humanId: linked.human_id, actorHumanId: operator.human_id });

  const deniedKnown = await login(repository, { identity: known, flowId: 'flow_known' });
  assert.equal(deniedKnown.outcome, 'denied');
  assert.deepEqual(deniedKnown.audit, { type: 'oauth_login.denied', subjectId: linked.human_id });

  const pinned = await makeInviteFor(pool, operator, { target: { humanId: operator.human_id, endpointId: operator.endpoint_id, issuer: GITHUB, subject: '98765432103' } });
  const deniedUnknown = await login(repository, { identity: unknown, inviteToken: pinned.token, flowId: 'flow_unknown' });
  assert.equal(deniedUnknown.outcome, 'denied');
  assert.deepEqual(deniedUnknown.audit, { type: 'oauth_login.denied', subjectId: 'flow:flow_unknown' });

  const denied = await auditRows(pool, 'oauth_login.denied');
  assert.equal(denied.length, 2);
  const byFlow = denied.find((r) => r.subject_id === 'flow:flow_unknown');
  assert.ok(byFlow);
  assert.equal(byFlow.actor_human_id, null);
  assert.equal(byFlow.outcome, 'denied');
  const byHuman = denied.find((r) => r.subject_id === linked.human_id);
  assert.ok(byHuman);
  assert.equal(byHuman.actor_human_id, linked.human_id);
  assert.equal(byHuman.outcome, 'denied');

  const all = (await pool.query('SELECT * FROM audit_events')).rows;
  assert.ok(all.length >= 5);
  for (const who of [known, unknown]) {
    const forms = [
      who.subject,
      crypto.createHash('sha256').update(who.subject).digest('hex'),
      crypto.createHash('sha256').update(who.subject).digest('base64url'),
      crypto.createHash('sha256').update(`${who.issuer}|${who.subject}`).digest('hex'),
    ];
    for (const row of all) {
      const text = JSON.stringify(row);
      for (const form of forms) assert.ok(!text.includes(form), `audit ${row.event_type} must not contain ${form}`);
    }
  }
});
