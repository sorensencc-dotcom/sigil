// Live-Postgres pins for the room join request queue (#272, design
// docs/superpowers/specs/2026-11-28-sigil-rooms-join-requests-design.md,
// section 8 "Tests to write first"). Every case asserts on database rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { provisionHumanTx } from './provision-human.mjs';
import { PostgresRepository } from './postgres-repository.mjs';
import { withTransaction } from './with-transaction.mjs';
import { createRelayServer } from './http-server.mjs';
import { createInvite } from './oauth/invites.mjs';
import { completeLogin } from './oauth/login-tx.mjs';
import { decideJoinRequestTx, JOIN_REQUEST_TTL_MS, ROOM_PENDING_LIMIT } from './join-requests.mjs';
import { createIdentity, identityKeys } from '../../cli/identity.mjs';
import { ROOM_SYSTEM_ENDPOINT_ID, ROOM_SYSTEM_OWNER_ID } from './room-system-identity.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const skip = !connectionString;
const wrapKey = crypto.randomBytes(32);
const NOW = new Date('2030-01-02T03:04:05.000Z');
const GITHUB = 'https://github.com';
const DAY = 24 * 3600_000;
const identity = (n) => ({ issuer: GITHUB, subject: String(n), displayName: `G${n}` });

async function setup(t) {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString, max: 10 });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyMigrations(connectionString);
  const repository = new PostgresRepository({ pool });
  const operator = await human(pool, 'Operator');
  await pool.query(`INSERT INTO workspaces (workspace_id, name, created_by, created_at) VALUES ('ws_t', 'ws_t', $1, $2)`, [operator.human_id, NOW]);
  for (const id of ['room_a', 'room_b']) {
    await pool.query(`INSERT INTO conversations (conversation_id, kind, created_by, created_at) VALUES ($1, 'room', $2, $3)`, [id, operator.human_id, NOW]);
    await pool.query(`INSERT INTO rooms (conversation_id, workspace_id, name, created_at) VALUES ($1, 'ws_t', $2, $3)`, [id, `Room ${id.slice(-1).toUpperCase()}`, NOW]);
    await pool.query(`INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at) VALUES ($1, $2, 'owner', $3, $4)`, [id, operator.endpoint_id, operator.human_id, NOW]);
  }
  return { pool, repository, operator };
}

const human = (pool, displayName) => withTransaction(pool, (c) => provisionHumanTx(c, { displayName, wrapKey, now: NOW }));

async function invite(pool, creator, { roomId = 'room_a', role = 'member', admission = 'request', name = 'guest' } = {}) {
  const { invite_id, token } = await withTransaction(pool, (c) => createInvite(c, { name, createdByHumanId: creator.human_id, rooms: [{ roomId, role, admission }], ttlMs: DAY, now: NOW }));
  return { inviteId: invite_id, token };
}

const login = (repository, who, inviteToken, now = NOW) => completeLogin({ repository, identity: who, inviteToken, flowId: 'flow_test', sessionId: crypto.randomBytes(32).toString('hex'), wrapKey, now });
const memberCount = async (pool, roomId, humanId) => (await pool.query(
  `SELECT count(*)::int AS n FROM conversation_members m JOIN endpoints e ON e.endpoint_id = m.endpoint_id WHERE m.conversation_id = $1 AND e.owner_id = $2 AND m.removed_at IS NULL`,
  [roomId, humanId])).rows[0].n;
const requestRow = async (pool, requestId) => (await pool.query('SELECT * FROM room_join_requests WHERE request_id = $1', [requestId])).rows[0];

async function addMember(pool, roomId, who, role, addedBy) {
  await pool.query(`INSERT INTO conversation_members (conversation_id, endpoint_id, role, added_by, added_at) VALUES ($1, $2, $3, $4, $5)`, [roomId, who.endpoint_id, role, addedBy.human_id, NOW]);
}

// A relay whose authenticate() answers with whichever human the test names
// in x-test-human, so one server can act as owner, manager and requester.
async function relay(t, repository, people) {
  const systemIdentity = createIdentity({ ownerId: ROOM_SYSTEM_OWNER_ID, endpointId: ROOM_SYSTEM_ENDPOINT_ID, kind: 'system' });
  await repository.ensureRoomSystemEndpoint({ identity: systemIdentity, now: NOW });
  const frames = [];
  const stream = { notifyRoom: (endpointId, frame) => { frames.push([endpointId, frame]); return true; }, deliver() { return false; }, publish() { return false; } };
  const logger = { error() {}, warn() {}, info() {}, debug() {} };
  const server = createRelayServer({
    registry: new Map(), repository, stream, logger, roomSystemIdentity: systemIdentity, relayOrigin: 'https://relay.test', now: () => NOW,
    authenticate: async (request) => {
      const who = people[request.headers['x-test-human']];
      return who ? { endpoint_id: who.endpoint_id, owner_id: who.human_id, human_id: who.human_id } : null;
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const call = (as, method, path, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path, headers: { 'x-test-human': as, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
  return { call, frames, systemIdentity };
}

test('a request invite never adds a membership before accept, for a new person', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const { inviteId, token } = await invite(pool, operator);
  const result = await login(repository, identity(1), token);
  assert.equal(result.outcome, 'login');
  assert.equal(await memberCount(pool, 'room_a', result.human_id), 0);
  assert.equal(result.join_requests.length, 1);
  const row = await requestRow(pool, result.join_requests[0].request_id);
  assert.equal(row.status, 'pending');
  assert.equal(row.room_id, 'room_a');
  assert.equal(row.requester_human_id, result.human_id);
  assert.equal(row.requester_endpoint_id, result.endpoint_id);
  assert.equal(row.invite_id, inviteId);
  assert.equal(row.offered_role, 'member');
  assert.equal(row.expires_at.getTime(), NOW.getTime() + JOIN_REQUEST_TTL_MS);
  assert.ok((await pool.query('SELECT consumed_at FROM room_invites WHERE invite_id = $1', [inviteId])).rows[0].consumed_at, 'the single-use link is consumed');
});

test('a request invite never adds a membership before accept, for a returning person', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const first = await login(repository, identity(2), (await invite(pool, operator, { roomId: 'room_b', admission: 'direct' })).token);
  assert.equal(await memberCount(pool, 'room_b', first.human_id), 1);
  const again = await login(repository, identity(2), (await invite(pool, operator)).token);
  assert.equal(again.outcome, 'login');
  assert.equal(again.human_id, first.human_id);
  assert.equal(await memberCount(pool, 'room_a', first.human_id), 0);
  assert.equal(again.join_requests.length, 1);
  assert.equal((await requestRow(pool, again.join_requests[0].request_id)).status, 'pending');
});

test('a returning person redeeming a direct invite now joins the room', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const first = await login(repository, identity(3), (await invite(pool, operator, { roomId: 'room_b', admission: 'direct' })).token);
  const direct = await invite(pool, operator, { admission: 'direct', role: 'room_manager' });
  const again = await login(repository, identity(3), direct.token);
  assert.equal(again.outcome, 'login');
  assert.deepEqual(again.join_requests, []);
  const { rows: [m] } = await pool.query('SELECT role FROM conversation_members WHERE conversation_id = $1 AND endpoint_id = $2 AND removed_at IS NULL', ['room_a', first.endpoint_id]);
  assert.equal(m.role, 'room_manager');
});

test('a stale invite still lets a returning person log in, and adds nothing', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const first = await login(repository, identity(4), (await invite(pool, operator, { roomId: 'room_b', admission: 'direct' })).token);
  const stale = await invite(pool, operator);
  const later = new Date(NOW.getTime() + 2 * DAY);
  const again = await login(repository, identity(4), stale.token, later);
  assert.equal(again.outcome, 'login');
  assert.deepEqual(again.join_requests, []);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM room_join_requests')).rows[0].n, 0);
  assert.equal(await memberCount(pool, 'room_a', first.human_id), 0);
});

test('a room already joined, or already requested, is not queued twice', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const first = await login(repository, identity(5), (await invite(pool, operator)).token);
  const second = await login(repository, identity(5), (await invite(pool, operator)).token);
  assert.deepEqual(second.join_requests, [], 'an open request for the room is reused');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM room_join_requests WHERE requester_human_id = $1`, [first.human_id])).rows[0].n, 1);
});

test('the per-room pending limit fails the login with a clear outcome, not a silent drop', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  for (let i = 0; i < ROOM_PENDING_LIMIT; i += 1) {
    const filler = await human(pool, `F${i}`);
    await pool.query(
      `INSERT INTO room_join_requests (request_id, room_id, requester_human_id, requester_endpoint_id, invite_id, offered_role, status, created_at, expires_at)
       VALUES ($1, 'room_a', $2, $3, $4, 'member', 'pending', $5, $6)`,
      [`jreq_${crypto.randomBytes(16).toString('hex')}`, filler.human_id, filler.endpoint_id, (await invite(pool, operator)).inviteId, NOW, new Date(NOW.getTime() + DAY)]);
  }
  const { inviteId, token } = await invite(pool, operator);
  const result = await login(repository, identity(6), token);
  assert.equal(result.outcome, 'join_request_limit');
  assert.equal((await pool.query('SELECT consumed_at FROM room_invites WHERE invite_id = $1', [inviteId])).rows[0].consumed_at, null, 'the whole login rolled back');
});

test('accept adds the member, records the decision, and emits a signed member_joined event', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const result = await login(repository, identity(7), (await invite(pool, operator)).token);
  const requestId = result.join_requests[0].request_id;
  const { call, frames, systemIdentity } = await relay(t, repository, { operator });

  const queue = await call('operator', 'GET', '/v1/rooms/room_a/join-requests');
  assert.equal(queue.status, 200);
  assert.deepEqual(queue.body.pending.map((r) => [r.request_id, r.requester_name]), [[requestId, 'guest']]);

  const accepted = await call('operator', 'POST', `/v1/rooms/room_a/join-requests/${requestId}/accept`, { role: 'room_manager' });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.request.status, 'accepted');
  const row = await requestRow(pool, requestId);
  assert.equal(row.status, 'accepted');
  assert.equal(row.decided_role, 'room_manager');
  assert.equal(row.decided_by_human_id, operator.human_id);
  const { rows: [m] } = await pool.query('SELECT role FROM conversation_members WHERE conversation_id = $1 AND endpoint_id = $2 AND removed_at IS NULL', ['room_a', result.endpoint_id]);
  assert.equal(m.role, 'room_manager');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE event_type = 'join_request.accepted' AND object_id = $1`, [requestId])).rows[0].n, 1);

  const { rows: events } = await pool.query(`SELECT body, sender_endpoint_id, signature_value, canonical_bytes FROM envelopes WHERE conversation_id = 'room_a' AND message_type = 'room.event'`);
  assert.equal(events.length, 1);
  assert.equal(events[0].body.kind, 'member_joined');
  assert.deepEqual(events[0].body.endpoint_ids, [result.endpoint_id]);
  assert.equal(events[0].body.reason, 'guest joined as room manager');
  assert.equal(events[0].sender_endpoint_id, ROOM_SYSTEM_ENDPOINT_ID);
  assert.ok(crypto.verify(null, events[0].canonical_bytes, identityKeys(systemIdentity).publicKey, Buffer.from(events[0].signature_value, 'base64url')), 'the event verifies under the relay system key');
  assert.ok(frames.some(([, f]) => f.room_id === 'room_a' && f.changed === 'join_requests'));
  assert.ok(frames.some(([, f]) => f.room_id === 'room_a' && f.changed === 'members'));
});

test('decline stores no reason and adds no member; the requester sees it', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const result = await login(repository, identity(8), (await invite(pool, operator)).token);
  const requestId = result.join_requests[0].request_id;
  const guest = { human_id: result.human_id, endpoint_id: result.endpoint_id };
  const { call } = await relay(t, repository, { operator, guest });
  const mine = await call('guest', 'GET', '/v1/join-requests');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.items.map((r) => [r.request_id, r.status, r.room_name]), [[requestId, 'pending', 'Room A']], 'the room name is shown before accept');
  assert.equal((await call('operator', 'POST', `/v1/rooms/room_a/join-requests/${requestId}/decline`)).status, 200);
  assert.equal((await requestRow(pool, requestId)).status, 'declined');
  assert.equal(await memberCount(pool, 'room_a', result.human_id), 0);
  assert.equal((await call('guest', 'GET', '/v1/join-requests')).body.items[0].status, 'declined');
  assert.equal((await call('guest', 'GET', '/v1/rooms/room_a/join-requests')).status, 404, 'a requester is not a member and cannot see the room');
});

test('a manager who lost the role between request and decision is refused', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const manager = await human(pool, 'Manager');
  await addMember(pool, 'room_a', manager, 'room_manager', operator);
  const result = await login(repository, identity(9), (await invite(pool, operator)).token);
  const requestId = result.join_requests[0].request_id;
  await pool.query(`UPDATE conversation_members SET role = 'member' WHERE conversation_id = 'room_a' AND endpoint_id = $1`, [manager.endpoint_id]);
  await assert.rejects(
    withTransaction(pool, (c) => decideJoinRequestTx(c, { repository, roomId: 'room_a', requestId, deciderHumanId: manager.human_id, decision: 'accept', now: NOW })),
    { code: 'ROUTE_NOT_AUTHORIZED' });
  assert.equal((await requestRow(pool, requestId)).status, 'pending');
});

test('a room manager can accept, as well as the owner', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const manager = await human(pool, 'Manager');
  await addMember(pool, 'room_a', manager, 'room_manager', operator);
  const result = await login(repository, identity(10), (await invite(pool, operator)).token);
  const { call } = await relay(t, repository, { manager });
  const accepted = await call('manager', 'POST', `/v1/rooms/room_a/join-requests/${result.join_requests[0].request_id}/accept`, {});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.request.decided_role, 'member', 'the invite\'s offered role is the default');
  assert.equal(await memberCount(pool, 'room_a', result.human_id), 1);
});

test('accept and decline race: exactly one wins, the loser gets JOIN_REQUEST_DECIDED', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const result = await login(repository, identity(11), (await invite(pool, operator)).token);
  const requestId = result.join_requests[0].request_id;
  const decide = (decision) => withTransaction(pool, (c) => decideJoinRequestTx(c, { repository, roomId: 'room_a', requestId, deciderHumanId: operator.human_id, decision, now: NOW }));
  const outcomes = await Promise.allSettled([decide('accept'), decide('decline')]);
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((o) => o.status === 'rejected').reason.code, 'JOIN_REQUEST_DECIDED');
  const row = await requestRow(pool, requestId);
  assert.equal(await memberCount(pool, 'room_a', result.human_id), row.status === 'accepted' ? 1 : 0);
});

test("a request for room A cannot be read or decided through room B's route", { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const result = await login(repository, identity(12), (await invite(pool, operator)).token);
  const requestId = result.join_requests[0].request_id;
  const { call } = await relay(t, repository, { operator });
  assert.deepEqual((await call('operator', 'GET', '/v1/rooms/room_b/join-requests')).body.pending, []);
  const wrong = await call('operator', 'POST', `/v1/rooms/room_b/join-requests/${requestId}/accept`, {});
  assert.equal(wrong.status, 404);
  assert.equal(wrong.body.code, 'JOIN_REQUEST_NOT_FOUND');
  assert.equal((await requestRow(pool, requestId)).status, 'pending');
});

test('a pending request past expires_at cannot be accepted, and reads as expired', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const result = await login(repository, identity(13), (await invite(pool, operator)).token);
  const requestId = result.join_requests[0].request_id;
  const later = new Date(NOW.getTime() + JOIN_REQUEST_TTL_MS + 1);
  await assert.rejects(
    withTransaction(pool, (c) => decideJoinRequestTx(c, { repository, roomId: 'room_a', requestId, deciderHumanId: operator.human_id, decision: 'accept', now: later })),
    { code: 'JOIN_REQUEST_EXPIRED' });
  assert.equal(await memberCount(pool, 'room_a', result.human_id), 0);
  const { listRoomJoinRequests } = await import('./join-requests.mjs');
  const queue = await withTransaction(pool, (c) => listRoomJoinRequests(c, { roomId: 'room_a', now: later }));
  assert.deepEqual(queue.pending, []);
  assert.deepEqual(queue.decided.map((r) => [r.request_id, r.status]), [[requestId, 'expired']]);
});

test('the requester can withdraw a pending request, once', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const result = await login(repository, identity(14), (await invite(pool, operator)).token);
  const requestId = result.join_requests[0].request_id;
  const guest = { human_id: result.human_id, endpoint_id: result.endpoint_id };
  const other = await human(pool, 'Other');
  const { call } = await relay(t, repository, { guest, other });
  assert.equal((await call('other', 'POST', `/v1/join-requests/${requestId}/withdraw`)).status, 404, 'only the requester can withdraw');
  assert.equal((await call('guest', 'POST', `/v1/join-requests/${requestId}/withdraw`)).status, 200);
  assert.equal((await requestRow(pool, requestId)).status, 'withdrawn');
  const again = await call('guest', 'POST', `/v1/join-requests/${requestId}/withdraw`);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'JOIN_REQUEST_DECIDED');
});

test('managers mint request invites from the room, list them without tokens, and revoke them', { skip }, async (t) => {
  const { pool, repository, operator } = await setup(t);
  const member = await human(pool, 'Member');
  await addMember(pool, 'room_a', member, 'member', operator);
  const { call } = await relay(t, repository, { operator, member });
  assert.equal((await call('member', 'POST', '/v1/rooms/room_a/invites', { name: 'x' })).status, 403, 'a plain member cannot mint');
  const minted = await call('operator', 'POST', '/v1/rooms/room_a/invites', { name: 'Pat' });
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  assert.equal(minted.body.admission, 'request', 'room panel invites default to the queue');
  assert.equal(minted.body.link, `https://relay.test/invite#${minted.body.token}`);
  const { rows: [r] } = await pool.query('SELECT admission, role FROM room_invite_rooms WHERE invite_id = $1', [minted.body.invite_id]);
  assert.deepEqual([r.admission, r.role], ['request', 'member']);
  const listed = await call('operator', 'GET', '/v1/rooms/room_a/invites');
  assert.deepEqual(listed.body.items.map((i) => [i.invite_id, i.state, i.admission]), [[minted.body.invite_id, 'open', 'request']]);
  assert.ok(!JSON.stringify(listed.body).includes(minted.body.token), 'the token is never listed');
  assert.equal((await call('operator', 'POST', `/v1/rooms/room_b/invites/${minted.body.invite_id}/revoke`)).status, 404, 'another room cannot revoke it');
  const revoked = await call('operator', 'POST', `/v1/rooms/room_a/invites/${minted.body.invite_id}/revoke`);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revoked, true);
  assert.equal((await call('operator', 'GET', '/v1/rooms/room_a/invites')).body.items[0].state, 'revoked');
  assert.equal((await call('operator', 'POST', '/v1/rooms/room_a/invites', { name: 'Pat', admission: 'open' })).status, 400);
});

test('CLI-style invites keep defaulting to direct admission', { skip }, async (t) => {
  const { pool, operator } = await setup(t);
  const { inviteId } = await withTransaction(pool, (c) => createInvite(c, { name: 'cli', createdByHumanId: operator.human_id, rooms: [{ roomId: 'room_a', role: 'member' }], ttlMs: DAY, now: NOW }))
    .then(({ invite_id }) => ({ inviteId: invite_id }));
  assert.equal((await pool.query('SELECT admission FROM room_invite_rooms WHERE invite_id = $1', [inviteId])).rows[0].admission, 'direct');
});
