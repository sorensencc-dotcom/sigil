// Live-Postgres pin for human suspension (foundation spec, "Suspension"):
// suspendHuman / unsuspendHuman, the `sigil human suspend|unsuspend` command,
// live revocation through sigil_admin, fan-out, in-flight invocations, and the
// FOR SHARE handshake with a returning login.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { endpointIsActive } from './room-policy.mjs';
import { createBearerAuthenticator, hashBearerToken } from './transport-auth.mjs';
import { startAdminListener, createAdminMessageHandler } from './admin-notify.mjs';
import { cmdHumanSuspend, cmdHumanUnsuspend } from '../../cli/human-commands.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function setup(t) {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  return { pool, repository: new PostgresRepository({ pool }), suffix: crypto.randomUUID().replaceAll('-', '_') };
}

async function addHuman(pool, humanId) {
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [humanId]);
}

// An endpoint with one active Ed25519 key, in the given status.
async function addEndpoint(pool, { endpointId, owner, kind, status = 'active' }) {
  const keys = crypto.generateKeyPairSync('ed25519');
  const keyId = `key_${endpointId}`;
  await pool.query(
    `INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at)
     VALUES ($1, $2, $3, $3, $4, $1, $5, NOW())`,
    [endpointId, owner, kind, `install_${endpointId}`, status],
  );
  await pool.query(
    `INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
     VALUES ($1, $2, 'Ed25519', $3, 'active', NOW() - interval '1 day')`,
    [keyId, endpointId, keys.publicKey.export({ type: 'spki', format: 'der' })],
  );
  return { endpointId, keyId, keys };
}

async function addSession(pool, sessionId, humanId) {
  await pool.query(
    `INSERT INTO human_sessions (session_id, human_id, authentication_method, assurance, issued_at, expires_at)
     VALUES ($1, $2, 'oidc', 'aal1', NOW(), NOW() + interval '1 hour')`,
    [sessionId, humanId],
  );
}

// A guest with two active endpoints (human + agent), one endpoint revoked
// before the suspension, and one suspended independently.
async function seedGuest(pool, suffix) {
  const op = `hum_op_${suffix}`;
  const guest = `hum_guest_${suffix}`;
  await addHuman(pool, op);
  await addHuman(pool, guest);
  const ids = {
    op, guest,
    opWeb: await addEndpoint(pool, { endpointId: `ep_opweb_${suffix}`, owner: op, kind: 'human' }),
    web: await addEndpoint(pool, { endpointId: `ep_gweb_${suffix}`, owner: guest, kind: 'human' }),
    agent: await addEndpoint(pool, { endpointId: `ep_gagent_${suffix}`, owner: guest, kind: 'agent' }),
    revoked: await addEndpoint(pool, { endpointId: `ep_grevoked_${suffix}`, owner: guest, kind: 'agent', status: 'revoked' }),
    held: await addEndpoint(pool, { endpointId: `ep_gheld_${suffix}`, owner: guest, kind: 'agent', status: 'suspended' }),
  };
  return ids;
}

const endpointRow = async (pool, endpointId) => (await pool.query('SELECT status, suspended_by_human_id FROM endpoints WHERE endpoint_id = $1', [endpointId])).rows[0];
const humanStatus = async (pool, humanId) => (await pool.query('SELECT status FROM humans WHERE human_id = $1', [humanId])).rows[0].status;

test('suspendHuman flips the human and only its active endpoints, revokes sessions, and audits; unsuspend restores only what it suspended', { skip: !connectionString }, async (t) => {
  const { pool, repository, suffix } = await setup(t);
  const ids = await seedGuest(pool, suffix);
  await addSession(pool, `sess_live_${suffix}`, ids.guest);
  await addSession(pool, `sess_op_${suffix}`, ids.op);

  const suspended = await repository.suspendHuman({ humanId: ids.guest, actorHumanId: ids.op });
  assert.deepEqual([...suspended.endpoint_ids].sort(), [ids.agent.endpointId, ids.web.endpointId].sort());
  assert.equal(await humanStatus(pool, ids.guest), 'suspended');
  for (const ep of [ids.web, ids.agent]) assert.deepEqual(await endpointRow(pool, ep.endpointId), { status: 'suspended', suspended_by_human_id: ids.guest });
  assert.deepEqual(await endpointRow(pool, ids.revoked.endpointId), { status: 'revoked', suspended_by_human_id: null });
  assert.deepEqual(await endpointRow(pool, ids.held.endpointId), { status: 'suspended', suspended_by_human_id: null });
  assert.deepEqual(await endpointRow(pool, ids.opWeb.endpointId), { status: 'active', suspended_by_human_id: null });
  const sessions = await pool.query('SELECT session_id, revoked_at FROM human_sessions ORDER BY session_id');
  assert.ok(sessions.rows.find((row) => row.session_id === `sess_live_${suffix}`).revoked_at, 'the guest session is revoked');
  assert.equal(sessions.rows.find((row) => row.session_id === `sess_op_${suffix}`).revoked_at, null, 'other humans keep their sessions');
  const audit = await pool.query(`SELECT event_type, subject_id, actor_human_id, outcome FROM audit_events WHERE event_type = 'human.suspended'`);
  assert.deepEqual(audit.rows, [{ event_type: 'human.suspended', subject_id: ids.guest, actor_human_id: ids.op, outcome: 'success' }]);

  // Suspending twice changes nothing more and suspends no extra endpoint.
  assert.deepEqual((await repository.suspendHuman({ humanId: ids.guest, actorHumanId: ids.op })).endpoint_ids, []);

  const restored = await repository.unsuspendHuman({ humanId: ids.guest, actorHumanId: ids.op });
  assert.deepEqual([...restored.endpoint_ids].sort(), [ids.agent.endpointId, ids.web.endpointId].sort());
  assert.equal(await humanStatus(pool, ids.guest), 'active');
  for (const ep of [ids.web, ids.agent]) assert.deepEqual(await endpointRow(pool, ep.endpointId), { status: 'active', suspended_by_human_id: null });
  assert.deepEqual(await endpointRow(pool, ids.revoked.endpointId), { status: 'revoked', suspended_by_human_id: null }, 'revoked before suspension stays revoked');
  assert.deepEqual(await endpointRow(pool, ids.held.endpointId), { status: 'suspended', suspended_by_human_id: null }, 'independently suspended stays suspended');
  assert.ok((await pool.query('SELECT revoked_at FROM human_sessions WHERE session_id = $1', [`sess_live_${suffix}`])).rows[0].revoked_at, 'unsuspend does not restore sessions');
  const unaudit = await pool.query(`SELECT subject_id, actor_human_id FROM audit_events WHERE event_type = 'human.unsuspended'`);
  assert.deepEqual(unaudit.rows, [{ subject_id: ids.guest, actor_human_id: ids.op }]);

  await assert.rejects(repository.suspendHuman({ humanId: `hum_missing_${suffix}`, actorHumanId: ids.op }), { code: 'HUMAN_NOT_FOUND' });
  await assert.rejects(repository.unsuspendHuman({ humanId: `hum_missing_${suffix}`, actorHumanId: ids.op }), { code: 'HUMAN_NOT_FOUND' });
});

test('an endpoint suspended by its human but revoked afterwards stays revoked on unsuspend', { skip: !connectionString }, async (t) => {
  const { pool, repository, suffix } = await setup(t);
  const ids = await seedGuest(pool, suffix);
  await repository.suspendHuman({ humanId: ids.guest, actorHumanId: ids.op });
  await repository.revokeEndpoint({ endpointId: ids.agent.endpointId });
  await repository.unsuspendHuman({ humanId: ids.guest, actorHumanId: ids.op });
  assert.equal((await endpointRow(pool, ids.agent.endpointId)).status, 'revoked');
  assert.equal((await endpointRow(pool, ids.web.endpointId)).status, 'active');
});

test('a failure after the suspension writes rolls everything back', { skip: !connectionString }, async (t) => {
  const { pool, repository, suffix } = await setup(t);
  const ids = await seedGuest(pool, suffix);
  await assert.rejects(repository.withTransaction(async (client) => {
    await repository.suspendHuman({ humanId: ids.guest, actorHumanId: ids.op }, client);
    throw new Error('boom');
  }), /boom/);
  assert.equal(await humanStatus(pool, ids.guest), 'active');
  assert.equal((await endpointRow(pool, ids.web.endpointId)).status, 'active');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE event_type = 'human.suspended'`)).rows[0].n, 0);
});

test('sigil human suspend clears the authenticator cache over sigil_admin; unsuspend lets the next call through', { skip: !connectionString }, async (t) => {
  const { pool, repository, suffix } = await setup(t);
  const ids = await seedGuest(pool, suffix);
  const tokens = new Map([[hashBearerToken(`tok_web_${suffix}`), ids.web.endpointId], [hashBearerToken(`tok_agent_${suffix}`), ids.agent.endpointId]]);
  // A TTL far past the test, so a null below proves the NOTIFY cleared the cache.
  const auth = createBearerAuthenticator(tokens, null, { repository, ttlMs: 600_000 });
  const request = (token) => ({ headers: { authorization: `Bearer ${token}` } });
  const revalidated = [];
  const handled = [];
  const handler = createAdminMessageHandler({ auth, stream: { revalidate: async (target) => { revalidated.push(target); } }, repository, logger: null });
  const listener = await startAdminListener({ pool, onMessage: async (message) => { await handler(message); handled.push(message.type); }, logger: null });
  t.after(() => listener.close());
  const waitFor = async (type) => {
    const deadline = Date.now() + 5000;
    while (!handled.includes(type)) {
      if (Date.now() > deadline) throw new Error(`no ${type} notification`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  assert.equal((await auth(request(`tok_web_${suffix}`))).human_id, ids.guest);
  assert.equal((await auth(request(`tok_agent_${suffix}`))).owner_id, ids.guest);

  await cmdHumanSuspend([ids.guest, '--database-url', connectionString]);
  await waitFor('human.suspended');
  assert.equal(await auth(request(`tok_web_${suffix}`)), null);
  assert.equal(await auth(request(`tok_agent_${suffix}`)), null);
  assert.deepEqual(revalidated, [{ humanId: ids.guest, endpointId: undefined }], 'every socket of the human is revalidated');

  await cmdHumanUnsuspend([ids.guest, '--database-url', connectionString]);
  await waitFor('human.unsuspended');
  assert.equal((await auth(request(`tok_web_${suffix}`))).human_id, ids.guest);
  assert.equal(await endpointIsActive(ids.web.endpointId, repository, pool, null), true);
});

test('fan-out skips a suspended human endpoint: no delivery, no inbox depth used, skip audited as endpoint_inactive', { skip: !connectionString }, async (t) => {
  const { pool, repository, suffix } = await setup(t);
  const ids = await seedGuest(pool, suffix);
  const now = new Date();
  const roomId = `room_fan_${suffix}`;
  await repository.createRoom({ conversationId: roomId, workspaceId: `ws_${ids.op}`, name: `fan_${suffix}`, createdByHumanId: ids.op, ownerEndpointId: ids.opWeb.endpointId, now });
  await repository.addRoomMember({ conversationId: roomId, endpointId: ids.web.endpointId, role: 'member', addedByHumanId: ids.op, now });
  const post = () => {
    const envelope = {
      protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: roomId, message_type: 'room.message',
      sender: { endpoint_id: ids.opWeb.endpointId, owner_id: ids.op }, broadcast_scope: { conversation_id: roomId },
      body: { text: 'hello' }, context_refs: [], capabilities: [], correlation_id: null,
      idempotency_key: `idem_${crypto.randomUUID()}`, created_at: now.toISOString(), expires_at: new Date(now.getTime() + 3600_000).toISOString(),
      signature: { algorithm: 'Ed25519', key_id: ids.opWeb.keyId, value: '' },
    };
    envelope.signature.value = crypto.sign(null, signedBytes(envelope), ids.opWeb.keys.privateKey).toString('base64url');
    return acceptEnvelopeAsync(envelope, { repository, registered: new Map(), now, inboxDepthLimit: 2 });
  };
  const guestDeliveries = async () => (await pool.query('SELECT count(*)::int AS n FROM deliveries WHERE recipient_endpoint_id = $1', [ids.web.endpointId])).rows[0].n;

  assert.equal((await post()).status, 202);
  assert.equal(await guestDeliveries(), 1, 'an active guest receives the room message');

  await repository.suspendHuman({ humanId: ids.guest, actorHumanId: ids.op });
  assert.equal(await endpointIsActive(ids.web.endpointId, repository, pool, new Map([[ids.web.endpointId, { status: 'active' }]])), false, 'a stale Map entry does not outvote the row');
  const before = await guestDeliveries();
  for (let i = 0; i < 3; i++) assert.equal((await post()).status, 202);
  assert.equal(await guestDeliveries(), before, 'no delivery to the suspended endpoint');
  const skips = await pool.query(`SELECT DISTINCT reason FROM audit_events WHERE event_type = 'room.delivery_skipped' AND endpoint_id = $1`, [ids.web.endpointId]);
  assert.deepEqual(skips.rows.map((row) => row.reason), ['endpoint_inactive']);
});

test('suspend cancels the human\'s queued and running invocations in every room, and nothing else', { skip: !connectionString }, async (t) => {
  const { pool, repository, suffix } = await setup(t);
  const ids = await seedGuest(pool, suffix);
  const opAgent = await addEndpoint(pool, { endpointId: `ep_opagent_${suffix}`, owner: ids.op, kind: 'agent' });
  const opAgent2 = await addEndpoint(pool, { endpointId: `ep_opagent2_${suffix}`, owner: ids.op, kind: 'agent' });
  const now = new Date();
  const rooms = [`room_a_${suffix}`, `room_b_${suffix}`];
  for (const roomId of rooms) {
    await repository.createRoom({ conversationId: roomId, workspaceId: `ws_${ids.op}`, name: roomId, createdByHumanId: ids.op, ownerEndpointId: ids.opWeb.endpointId, now });
  }
  const rows = [
    ['a_guest_running', rooms[0], opAgent.endpointId, ids.guest, 'running'],
    ['a_guest_queued', rooms[0], opAgent2.endpointId, ids.guest, 'queued'],
    ['a_op_queued', rooms[0], opAgent.endpointId, ids.op, 'queued'],
    ['b_guest_running', rooms[1], opAgent.endpointId, ids.guest, 'running'],
    ['b_op_running', rooms[1], opAgent2.endpointId, ids.op, 'running'],
    ['b_guest_done', rooms[1], opAgent2.endpointId, ids.guest, 'refused'],
  ];
  for (const [name, roomId, endpointId, subjectHumanId, status] of rows) {
    await repository.createRoomInvocation({ invocationId: `inv_${name}_${suffix}`, roomId, workspaceId: `ws_${ids.op}`, triggerMessageId: `msg_${name}_${suffix}`, threadRootId: 'msg_root', endpointId, decidedBy: 'mention', subjectHumanId, status, reason: status === 'refused' ? 'not_allowed' : null, now });
  }
  const result = await repository.suspendHuman({ humanId: ids.guest, actorHumanId: ids.op });
  const name = (id) => id.replace('inv_', '').replace(`_${suffix}`, '');
  assert.deepEqual(result.invocation_ids.map(name).sort(), ['a_guest_queued', 'a_guest_running', 'b_guest_running']);
  const statuses = Object.fromEntries((await pool.query('SELECT invocation_id, status FROM room_invocations')).rows.map((row) => [name(row.invocation_id), row.status]));
  assert.deepEqual(statuses, {
    a_guest_running: 'cancelled', a_guest_queued: 'cancelled', a_op_queued: 'queued',
    b_guest_running: 'cancelled', b_op_running: 'running', b_guest_done: 'refused',
  });
});

// The login spec's returning login takes FOR SHARE on the humans row. Either
// it waits for the suspension and reads 'suspended', or it commits its session
// first and the suspension's session sweep revokes it.
test('a returning login holding FOR SHARE either blocks until the suspension commits or has its session revoked by it', { skip: !connectionString }, async (t) => {
  const { pool, repository, suffix } = await setup(t);
  const ids = await seedGuest(pool, suffix);
  const suspender = await pool.connect();
  const login = await pool.connect();
  try {
    await raceBothOrders({ pool, repository, ids, suffix, suspender, login });
  } finally {
    suspender.release();
    login.release();
  }
});

async function raceBothOrders({ pool, repository, ids, suffix, suspender, login }) {
  const settledWithin = (promise, ms) => Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);

  // Order 1: the suspension writes first; the login's FOR SHARE waits for it.
  await suspender.query('BEGIN');
  await repository.suspendHuman({ humanId: ids.guest, actorHumanId: ids.op }, suspender);
  await login.query('BEGIN');
  const read = login.query('SELECT status FROM humans WHERE human_id = $1 FOR SHARE', [ids.guest]);
  assert.equal(await settledWithin(read, 300), false, 'the login blocks while the suspension is uncommitted');
  await suspender.query('COMMIT');
  assert.equal((await read).rows[0].status, 'suspended');
  await login.query('ROLLBACK');

  await repository.unsuspendHuman({ humanId: ids.guest, actorHumanId: ids.op });

  // Order 2: the login holds FOR SHARE and writes a session; the suspension
  // waits, then its sweep revokes that session.
  await login.query('BEGIN');
  assert.equal((await login.query('SELECT status FROM humans WHERE human_id = $1 FOR SHARE', [ids.guest])).rows[0].status, 'active');
  await addSession(login, `sess_race_${suffix}`, ids.guest);
  await suspender.query('BEGIN');
  const suspension = repository.suspendHuman({ humanId: ids.guest, actorHumanId: ids.op }, suspender);
  assert.equal(await settledWithin(suspension, 300), false, 'the suspension waits for the login');
  await login.query('COMMIT');
  await suspension;
  await suspender.query('COMMIT');
  assert.ok((await pool.query('SELECT revoked_at FROM human_sessions WHERE session_id = $1', [`sess_race_${suffix}`])).rows[0].revoked_at, 'the session committed first is revoked by the sweep');
}

// Spec Testing: every CLI pg_notify payload stays under 8000 bytes however much
// data the command touches. 120 endpoints and 120 sessions would overflow a
// payload that listed them.
test('suspend and unsuspend of a human with many endpoints and sessions publish a fixed-size payload', { skip: !connectionString }, async (t) => {
  const { pool, suffix } = await setup(t);
  const human = `hum_many_${suffix}`;
  await addHuman(pool, human);
  for (let i = 0; i < 120; i++) {
    await addEndpoint(pool, { endpointId: `ep_many_${i}_${suffix}`, owner: human, kind: i % 2 ? 'agent' : 'human' });
    await addSession(pool, `sess_many_${i}_${suffix}`, human);
  }
  const listener = new pg.Client({ connectionString });
  await listener.connect();
  t.after(() => listener.end());
  const payloads = [];
  listener.on('notification', (message) => payloads.push(message.payload));
  await listener.query('LISTEN sigil_admin');

  await cmdHumanSuspend([human, '--database-url', connectionString]);
  await cmdHumanUnsuspend([human, '--database-url', connectionString]);
  const deadline = Date.now() + 5000;
  while (payloads.length < 2) {
    if (Date.now() > deadline) throw new Error(`expected 2 notifications, got ${payloads.length}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(payloads.map((p) => JSON.parse(p)), [{ type: 'human.suspended', human_id: human }, { type: 'human.unsuspended', human_id: human }]);
  for (const payload of payloads) assert.ok(Buffer.byteLength(payload) < 8000);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM endpoints WHERE owner_id = $1 AND status = 'active'`, [human])).rows[0].n, 120);
});
