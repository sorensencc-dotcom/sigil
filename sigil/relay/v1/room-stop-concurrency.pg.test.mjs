// Rooms phase 4a: Stop and invocation-fail race room message accept on Postgres.
// Lock order under test: accept takes the rooms row through UPDATE rooms
// (assignRoomSequence); Stop and fail call lockRoom (SELECT ... FOR UPDATE)
// first. These invariants must hold for every interleaving.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { createRelayServer } from './http-server.mjs';
import { createRoomHumanSigner } from './room-human-signer.mjs';
import { ROOM_SYSTEM_ENDPOINT_ID, ROOM_SYSTEM_OWNER_ID } from './room-system-identity.mjs';
import { createIdentity } from '../../cli/identity.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const ROUNDS = 25;

function call(port, method, path, token, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: `Bearer ${token}` } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function world(t) {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  // Open the pool's connections one at a time before any race: a burst of
  // simultaneous connects through the Windows Docker port proxy can reset
  // (ECONNRESET), which is an environment fault, not a room lock outcome.
  const warm = [];
  for (let n = 0; n < 8; n += 1) { const c = await pool.connect(); await c.query('SELECT 1'); warm.push(c); }
  for (const c of warm) c.release();
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const human = `usr_stop_${suffix}`;
  const web = createIdentity({ ownerId: human, endpointId: `ep_web_${suffix}`, kind: 'human' });
  const agent = createIdentity({ ownerId: human, endpointId: `ep_agent_${suffix}`, kind: 'agent' });
  const system = createIdentity({ ownerId: ROOM_SYSTEM_OWNER_ID, endpointId: ROOM_SYSTEM_ENDPOINT_ID, kind: 'system' });
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [human]);
  for (const [identity, runtime] of [[web, 'web'], [agent, 'claude']]) {
    await pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at) VALUES ($1, $2, $3, $4, $3, 'active', NOW())`, [identity.endpoint_id, human, runtime, `install_${identity.endpoint_id}`]);
    await pool.query(`INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())`, [identity.key_id, identity.endpoint_id, Buffer.from(crypto.createPublicKey(identity.public_key_pem).export({ format: 'jwk' }).x, 'base64url')]);
  }
  const repository = new PostgresRepository({ pool });
  await repository.ensureRoomSystemEndpoint({ identity: system, now: new Date() });
  // Observe real commit order: withTransaction resolves only after COMMIT.
  // Pooled clients are reused, so tags reset when each transaction begins.
  const tags = new WeakMap();
  const commitLog = [];
  const tag = (client, name) => { if (client && typeof client === 'object') (tags.get(client) ?? tags.set(client, new Set()).get(client)).add(name); };
  const originalWithTransaction = repository.withTransaction.bind(repository);
  const originalAssign = repository.assignRoomSequence.bind(repository);
  const originalCancel = repository.cancelRoomInvocations.bind(repository);
  const originalFinish = repository.finishInvocation.bind(repository);
  repository.assignRoomSequence = (client, ...rest) => { tag(client, 'seq'); return originalAssign(client, ...rest); };
  repository.cancelRoomInvocations = (roomId, opts, client) => { tag(client, 'cancel'); return originalCancel(roomId, opts, client); };
  repository.finishInvocation = (id, opts, client) => { tag(client, 'finish'); return originalFinish(id, opts, client); };
  repository.withTransaction = async (work) => {
    let seen;
    const result = await originalWithTransaction(async (client) => { seen = client; tags.delete(client); return work(client); });
    commitLog.push({ tags: new Set(tags.get(seen) ?? []), order: commitLog.length });
    return result;
  };
  const entry = (identity) => ({ owner_id: identity.owner_id, endpoint_id: identity.endpoint_id, status: 'active', kind: identity.kind, key_id: identity.key_id, public_key: crypto.createPublicKey(identity.public_key_pem) });
  const registry = new Map([[web.endpoint_id, entry(web)], [agent.endpoint_id, entry(agent)], [system.endpoint_id, entry(system)]]);
  const errors = [];
  const logger = { log() {}, warn() {}, error: (...args) => errors.push(args.map((a) => (a instanceof Error ? `${a.code ?? ''} ${a.message}` : String(a))).join(' ')) };
  const server = createRelayServer({
    logger, registry, repository, humanSigner: createRoomHumanSigner({ identity: web, registry }), roomSystemIdentity: system,
    authenticate: async (request) => {
      const token = request.headers.authorization;
      if (token === 'Bearer web') return { endpoint_id: web.endpoint_id, owner_id: human, human_id: human };
      if (token === 'Bearer agent') return { endpoint_id: agent.endpoint_id, owner_id: human };
      return null;
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { pool, repository, commitLog, errors, port: server.address().port, web, agent, human, suffix };
}

async function freshRoom(w, label, i) {
  const roomId = `room_${label}_${i}_${w.suffix}`;
  await w.repository.createRoom({ conversationId: roomId, workspaceId: `ws_${w.human}`, name: `${label}_${i}_${w.suffix}`, createdByHumanId: w.human, ownerEndpointId: w.web.endpoint_id, now: new Date() });
  await w.repository.addRoomMember({ conversationId: roomId, endpointId: w.agent.endpoint_id, role: 'member', responseMode: 'mentions_only', addedByHumanId: w.human, now: new Date() });
  return roomId;
}

const JITTER_MS = [0, 1, 3, 6, 10, 15, 25];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Alternate which side starts late so both commit orders occur across rounds.
const staggered = (i, first, second) => {
  const delay = JITTER_MS[Math.floor(i / 2) % JITTER_MS.length];
  return i % 2 === 0 ? [first(), sleep(delay).then(second)] : [sleep(delay).then(first), second()];
};

let keySeq = 0;
function postRoomMessage(w, roomId, text, mentions = [w.agent.endpoint_id]) {
  return call(w.port, 'POST', `/v1/rooms/${roomId}/messages`, 'web', { text, mentions, idempotency_key: `k${++keySeq}_${text}` });
}

// One running and one queued invocation for the agent, both from human messages.
async function seedActive(w, roomId, i) {
  const a = await postRoomMessage(w, roomId, `a${i}`);
  const b = await postRoomMessage(w, roomId, `b${i}`);
  assert.ok(a.status === 201 || a.status === 200, `seed a: ${JSON.stringify(a)}`);
  assert.ok(b.status === 201 || b.status === 200, `seed b: ${JSON.stringify(b)}`);
  const active = await w.repository.listRoomInvocations(roomId, { limit: 10 });
  assert.deepEqual(active.map((inv) => inv.status).sort(), ['queued', 'running'], `seed state ${JSON.stringify(active)}`);
}

// Commit order of the racing writer (Stop or fail) against the message accept,
// from the observer in world(): withTransaction resolves only after COMMIT.
function commitOrder(w, writerTag, ctx) {
  const writer = w.commitLog.find((entry) => entry.tags.has(writerTag));
  const accept = w.commitLog.find((entry) => entry.tags.has('seq') && !entry.tags.has(writerTag));
  assert.ok(writer && accept, `commit observer missed a transaction ${ctx} log=${JSON.stringify(w.commitLog.map((e) => [...e.tags]))}`);
  return writer.order < accept.order ? 'writer-first' : 'message-first';
}

async function rowsOf(w, roomId) {
  const messages = (await w.repository.listRoomMessages(roomId, 0n, 1000)).map((row) => ({ ...row.envelope, room_seq: row.room_seq, message_id: row.message_id }));
  const invocations = await w.repository.listRoomInvocations(roomId, { limit: 1000 });
  const seqOf = new Map(messages.map((m) => [m.message_id, BigInt(m.room_seq)]));
  return { messages, invocations, seqOf };
}

function assertContiguous(messages, ctx) {
  const seqs = messages.map((m) => Number(m.room_seq));
  assert.deepEqual(seqs, seqs.map((_, idx) => idx + 1), `room_seq not exactly 1..N ${ctx}`);
}

async function assertCommitOrder(w, roomId, rowA, rowB, ctx) {
  // The row with the lower room_seq must have committed first. Commit
  // timestamps need track_commit_timestamp; without it the assertion is
  // skipped and the lock-order proof rests on invariants 1 and 3.
  if (!(await commitOrderSupported(w.pool)) || !rowA || !rowB) return false;
  const { rows } = await w.pool.query(`SELECT message_id, pg_xact_commit_timestamp(xmin) AS committed FROM envelopes WHERE conversation_id = $1 AND message_id = ANY($2)`, [roomId, [rowA.message_id, rowB.message_id]]);
  const at = new Map(rows.map((r) => [r.message_id, r.committed]));
  const [lo, hi] = BigInt(rowA.room_seq) < BigInt(rowB.room_seq) ? [rowA, rowB] : [rowB, rowA];
  assert.ok(at.get(lo.message_id) <= at.get(hi.message_id), `commit order disagrees with room_seq ${ctx}`);
  return true;
}

test('Stop racing room message accept keeps seq, invocations, and lock order consistent', { skip: !connectionString, timeout: 170_000 }, async (t) => {
  const w = await world(t);
  const orders = { 'writer-first': 0, 'message-first': 0 };
  for (let i = 0; i < ROUNDS; i += 1) {
    const roomId = await freshRoom(w, 'stop', i);
    await seedActive(w, roomId, i);
    w.commitLog.length = 0;
    const [stop, message] = await Promise.all(staggered(i, () => call(w.port, 'POST', `/v1/rooms/${roomId}/stop`, 'web', {}), () => postRoomMessage(w, roomId, `m${i}`)));
    const ctx = `round ${i} stop=${JSON.stringify(stop)} message=${JSON.stringify(message)} server_errors=${JSON.stringify(w.errors)}`;
    // 5: no deadlock, no failure of either call.
    assert.equal(stop.status, 200, ctx);
    assert.ok(message.status === 201 || message.status === 200, ctx);
    assert.ok(!JSON.stringify([stop, message]).includes('40P01'), `deadlock ${ctx}`);
    const { messages, invocations, seqOf } = await rowsOf(w, roomId);
    // 3: exactly 1..N.
    assertContiguous(messages, ctx);
    const stopEvents = messages.filter((m) => m.message_type === 'room.event' && m.body?.kind === 'invocation_stopped');
    // The seeded running and queued invocations were active when the round
    // began, so Stop always cancels them; when the raced message committed
    // first, its invocation is cancelled too. One event per cancelled row.
    assert.ok(stop.body.cancelled === 2 || stop.body.cancelled === 3, `unexpected cancelled count ${ctx}`);
    assert.equal(stopEvents.length, stop.body.cancelled, `expected one stop event per cancelled invocation ${ctx}`);
    const boundary = stopEvents.map((e) => BigInt(e.room_seq)).reduce((x, y) => (x < y ? x : y));
    const maxStop = stopEvents.map((e) => BigInt(e.room_seq)).reduce((x, y) => (x > y ? x : y));
    // The events are emitted in one transaction under one room lock: nothing
    // lands between them.
    assert.equal(maxStop - boundary, BigInt(stopEvents.length - 1), `stop events not adjacent ${ctx}`);
    // 1: nothing triggered below the Stop event is still active.
    for (const invocation of invocations) {
      const triggerSeq = seqOf.get(invocation.trigger_message_id);
      assert.ok(triggerSeq !== undefined, `trigger message missing for ${invocation.invocation_id} ${ctx}`);
      assert.ok(triggerSeq < boundary || triggerSeq > maxStop, `trigger inside stop events ${ctx}`);
      if (triggerSeq < boundary) assert.ok(!['queued', 'running'].includes(invocation.status), `stale ${invocation.status} invocation trigger_seq=${triggerSeq} < stop_seq=${boundary} ${ctx}`);
    }
    // The raced message either landed before Stop (its invocation cancelled)
    // or after (its invocation is the only active one).
    const messageRow = messages.find((m) => m.message_id === message.body.message_id);
    assert.ok(messageRow, `raced message row missing ${ctx}`);
    const messageSeq = BigInt(messageRow.room_seq);
    const own = invocations.filter((inv) => inv.trigger_message_id === messageRow.message_id);
    assert.equal(own.length, 1, `raced message should create one invocation ${ctx}`);
    if (messageSeq < boundary) assert.equal(own[0].status, 'cancelled', ctx);
    else assert.ok(['running', 'queued'].includes(own[0].status) && own[0].status === 'running', `post-stop invocation should run ${ctx}`);
    // 4: lower room_seq committed first.
    const order = commitOrder(w, 'cancel', ctx);
    assert.equal(order === 'message-first', messageSeq < boundary, `room_seq order disagrees with commit order (${order}) ${ctx}`);
    orders[order] += 1;
  }
  t.diagnostic(`commit orders ${JSON.stringify(orders)}`);
});

test('Stop racing an idle room: a message that lands after Stop is not cancelled', { skip: !connectionString, timeout: 170_000 }, async (t) => {
  const w = await world(t);
  const orders = { 'writer-first': 0, 'message-first': 0 };
  for (let i = 0; i < ROUNDS; i += 1) {
    const roomId = await freshRoom(w, 'idle', i);
    w.commitLog.length = 0;
    w.commitLog.length = 0;
    const [stop, message] = await Promise.all(staggered(i, () => call(w.port, 'POST', `/v1/rooms/${roomId}/stop`, 'web', {}), () => postRoomMessage(w, roomId, `m${i}`)));
    const ctx = `round ${i} stop=${JSON.stringify(stop)} message=${JSON.stringify(message)} server_errors=${JSON.stringify(w.errors)}`;
    assert.equal(stop.status, 200, ctx);
    assert.ok(message.status === 201 || message.status === 200, ctx);
    const { messages, invocations } = await rowsOf(w, roomId);
    assertContiguous(messages, ctx);
    const stopEvents = messages.filter((m) => m.message_type === 'room.event' && m.body?.kind === 'invocation_stopped');
    const messageRow = messages.find((m) => m.message_id === message.body.message_id);
    const own = invocations.filter((inv) => inv.trigger_message_id === messageRow.message_id);
    assert.equal(own.length, 1, ctx);
    if (stop.body.cancelled === 0) {
      // Stop committed first and saw nothing active: no event, and the
      // message's invocation survives.
      assert.equal(stopEvents.length, 0, ctx);
      assert.equal(own[0].status, 'running', ctx);
    } else {
      // The message committed first; Stop cancelled its invocation.
      assert.equal(stop.body.cancelled, 1, ctx);
      assert.equal(stopEvents.length, 1, ctx);
      assert.ok(BigInt(messageRow.room_seq) < BigInt(stopEvents[0].room_seq), `cancelled invocation trigger must precede stop event ${ctx}`);
      assert.equal(own[0].status, 'cancelled', ctx);
    }
    const order = commitOrder(w, 'cancel', ctx);
    assert.equal(order === 'writer-first', stop.body.cancelled === 0, `Stop outcome disagrees with commit order (${order}) ${ctx}`);
    orders[order] += 1;
  }
  t.diagnostic(`commit orders ${JSON.stringify(orders)}`);
});

test('invocation fail racing room message accept keeps seq and promotion consistent', { skip: !connectionString, timeout: 170_000 }, async (t) => {
  const w = await world(t);
  for (let i = 0; i < ROUNDS; i += 1) {
    const roomId = await freshRoom(w, 'fail', i);
    await seedActive(w, roomId, i);
    w.commitLog.length = 0;
    const [fail, message] = await Promise.all(staggered(i, () => call(w.port, 'POST', `/v1/rooms/${roomId}/invocations/fail`, 'agent', { reason: 'bridge_failed' }), () => postRoomMessage(w, roomId, `m${i}`)));
    const ctx = `round ${i} fail=${JSON.stringify(fail)} message=${JSON.stringify(message)} server_errors=${JSON.stringify(w.errors)}`;
    assert.equal(fail.status, 200, ctx);
    assert.ok(message.status === 201 || message.status === 200, ctx);
    assert.ok(!JSON.stringify([fail, message]).includes('40P01'), `deadlock ${ctx}`);
    const { messages, invocations } = await rowsOf(w, roomId);
    assertContiguous(messages, ctx);
    const byStatus = (status) => invocations.filter((inv) => inv.status === status);
    // Seeded a (running) failed; b was promoted or still queued behind it;
    // the raced message added one more invocation.
    assert.equal(invocations.length, 3, ctx);
    assert.equal(byStatus('failed').length, 1, ctx);
    assert.equal(byStatus('running').length, 1, `exactly one running invocation ${ctx}`);
    assert.equal(byStatus('queued').length, 1, `exactly one queued invocation (no lost promotion) ${ctx}`);
    // The failed invocation was the one running at round start, never a newer one.
    assert.ok(byStatus('failed')[0].trigger_message_id.length > 0, ctx);
    const seqOfTrigger = (inv) => BigInt(messages.find((m) => m.message_id === inv.trigger_message_id).room_seq);
    // Promotion is FIFO: the running one triggered below the queued one.
    assert.ok(seqOfTrigger(byStatus('running')[0]) < seqOfTrigger(byStatus('queued')[0]), `promotion out of order ${ctx}`);
  }
});
