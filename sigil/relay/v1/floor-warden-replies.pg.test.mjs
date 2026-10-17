// Rooms phase 6: Floor Warden reply idempotency, single-shot completion and
// audit against Postgres, where concurrent replies really interleave.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { createRelayServer } from './http-server.mjs';
import { createRoomHumanSigner } from './room-human-signer.mjs';
import { createRoomBotSigner } from './room-bot-signer.mjs';
import { wrapPrivateKey } from './key-wrap.mjs';
import { loadReplyTokens } from './floor-warden-token.mjs';
import { createIdentity } from '../../cli/identity.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const REPLY = crypto.randomBytes(24).toString('hex');
const humanWrapKey = crypto.randomBytes(32);
const botWrapKey = crypto.randomBytes(32);

function post(port, path, token, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: token } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { let parsed = null; try { parsed = JSON.parse(text); } catch {} resolve({ status: res.statusCode, body: parsed }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

let pool;
let migrated;
async function ready() {
  assertDisposableTestDatabase(connectionString);
  migrated ??= applyMigrations(connectionString, { reset: true }).then(() => { pool = new pg.Pool({ connectionString }); });
  await migrated;
  return pool;
}
test.after(() => pool?.end());

async function insertEndpoint(db, endpointId, owner, kind, publicKey, keyId) {
  await db.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at) VALUES ($1, $2, $3, $4, $5, $1, 'active', NOW())`, [endpointId, owner, kind === 'human' ? 'web' : 'bot', kind, `install_${endpointId}`]);
  await db.query(`INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())`, [keyId, endpointId, publicKey.export({ type: 'spki', format: 'der' })]);
}

// One operator, one rostered bot, one server. Rooms are made per test so one
// migration serves the whole file.
async function world(t) {
  const db = await ready();
  const run = crypto.randomUUID().replaceAll('-', '_');
  const human = `usr_fw_${run}`;
  const web = `ep_web_${run}`;
  const botEp = `ep_test_bot_${run}`;
  const botId = `bot_test_${run}`;
  const identity = createIdentity({ ownerId: human, endpointId: web, kind: 'human' });
  await db.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [human]);
  await insertEndpoint(db, web, human, 'human', crypto.createPublicKey(identity.public_key_pem), identity.key_id);
  const bot = crypto.generateKeyPairSync('ed25519');
  const botKeyId = `key_${botEp}`;
  await insertEndpoint(db, botEp, human, 'agent', bot.publicKey, botKeyId);
  const repository = new PostgresRepository({ pool: db });
  await repository.insertBotSigningKey({ keyId: botKeyId, wrapped: wrapPrivateKey({ wrapKey: botWrapKey, endpointId: botEp, keyId: botKeyId, privateKey: bot.privateKey }), now: new Date() });
  await repository.insertFloorWardenBot({ bot_id: botId, endpoint_id: botEp, display_name: 'Test Bot', status: 'active', created_at: new Date().toISOString() });

  const humanSigner = createRoomHumanSigner({ identity, repository, wrapKey: humanWrapKey });
  await humanSigner.verifyOperator();
  const logs = [];
  const capture = (level) => (...args) => { logs.push([level, ...args.map((x) => (x instanceof Error ? { message: x.message, stack: x.stack } : x))]); };
  const server = createRelayServer({
    registry: new Map(), repository, humanSigner,
    logger: { info: capture('info'), warn: capture('warn'), error: capture('error'), debug: capture('debug') },
    floorWardenReplies: { tokens: loadReplyTokens({ FWT: REPLY }, 'FWT'), botSigner: createRoomBotSigner({ repository, wrapKey: botWrapKey }) },
    authenticate: async (request) => (request.headers.authorization === 'Bearer web' ? { endpoint_id: web, owner_id: human, human_id: human } : null),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  let rooms = 0;
  const newRoom = async () => {
    const roomId = `room_${run}_${rooms += 1}`;
    await repository.createRoom({ conversationId: roomId, workspaceId: `ws_${human}`, name: `fw_${run}_${rooms}`, createdByHumanId: human, ownerEndpointId: web, now: new Date() });
    await repository.addRoomMember({ conversationId: roomId, endpointId: botEp, role: 'member', responseMode: 'mentions_only', addedByHumanId: human, now: new Date() });
    return roomId;
  };
  const say = async (roomId, text, extra = {}) => {
    const res = await post(port, `/v1/rooms/${roomId}/messages`, 'Bearer web', { text, idempotency_key: crypto.randomUUID(), ...extra });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.message_id;
  };
  const reply = (roomId, fields) => post(port, `/v1/rooms/${roomId}/replies`, `Bearer ${REPLY}`, { room_id: roomId, target_bot_id: botId, sender: botEp, text: 'bot answer', idempotency_key: `k_${crypto.randomUUID()}`, ...fields });
  const botMessages = async (roomId) => (await db.query(`SELECT message_id FROM envelopes WHERE conversation_id = $1 AND sender_endpoint_id = $2`, [roomId, botEp])).rows;
  const invocations = async (roomId) => (await db.query(`SELECT invocation_id, trigger_message_id, status, reply_message_id FROM room_invocations WHERE room_id = $1 AND endpoint_id = $2`, [roomId, botEp])).rows;
  return { db, port, botEp, botId, logs, newRoom, say, reply, botMessages, invocations };
}

test('racing duplicates under one key store one envelope and both answer 202, one duplicate', { skip: !connectionString }, async (t) => {
  const w = await world(t);
  for (let i = 0; i < 5; i += 1) {
    const roomId = await w.newRoom();
    const trigger = await w.say(roomId, 'hi bot', { mentions: [w.botEp] });
    const [a, b] = await Promise.all([
      w.reply(roomId, { in_reply_to: trigger, idempotency_key: 'k_race', text: 'answer one' }),
      w.reply(roomId, { in_reply_to: trigger, idempotency_key: 'k_race', text: 'answer two' }),
    ]);
    assert.deepEqual([a.status, b.status], [202, 202], JSON.stringify([a.body, b.body]));
    assert.equal(a.body.message_id, b.body.message_id);
    assert.equal(a.body.room_seq, b.body.room_seq);
    assert.deepEqual([a.body.duplicate, b.body.duplicate].sort(), [false, true]);
    assert.equal((await w.botMessages(roomId)).length, 1);

    const again = await w.reply(roomId, { in_reply_to: trigger, idempotency_key: 'k_race', text: 'answer three' });
    assert.equal(again.status, 202, JSON.stringify(again.body));
    assert.deepEqual([again.body.message_id, again.body.duplicate], [a.body.message_id, true]);
  }
});

test('concurrent replies to one trigger under different keys complete it once and leave the promoted invocation running', { skip: !connectionString }, async (t) => {
  const w = await world(t);
  for (let i = 0; i < 5; i += 1) {
    const roomId = await w.newRoom();
    const triggerA = await w.say(roomId, 'first', { mentions: [w.botEp] });
    const triggerB = await w.say(roomId, 'second', { mentions: [w.botEp], thread_root_id: triggerA });
    const [x, y] = await Promise.all([
      w.reply(roomId, { in_reply_to: triggerA, idempotency_key: 'k_x' }),
      w.reply(roomId, { in_reply_to: triggerA, idempotency_key: 'k_y' }),
    ]);
    const statuses = [x, y].map((r) => r.status).sort();
    assert.deepEqual(statuses, [202, 403], JSON.stringify([x.body, y.body]));
    const refused = x.status === 403 ? x : y;
    assert.equal(refused.body.code, 'ROOM_NOT_INVOKED');
    const rows = await w.invocations(roomId);
    const a = rows.find((r) => r.trigger_message_id === triggerA);
    const b = rows.find((r) => r.trigger_message_id === triggerB);
    assert.equal(a.status, 'completed');
    assert.equal(b.status, 'running', JSON.stringify(rows));
    assert.equal(b.reply_message_id, null);
    assert.equal((await w.botMessages(roomId)).length, 1);
  }
});

test('a second reply under a new key after completion answers 403 ROOM_NOT_INVOKED', { skip: !connectionString }, async (t) => {
  const w = await world(t);
  const roomId = await w.newRoom();
  const trigger = await w.say(roomId, 'hi', { mentions: [w.botEp] });
  assert.equal((await w.reply(roomId, { in_reply_to: trigger, idempotency_key: 'k_1' })).status, 202);
  const second = await w.reply(roomId, { in_reply_to: trigger, idempotency_key: 'k_2' });
  assert.equal(second.status, 403);
  assert.equal(second.body.code, 'ROOM_NOT_INVOKED');
});

test('audit rows name bot, endpoint, room, message and outcome and never the token or the text', { skip: !connectionString }, async (t) => {
  const w = await world(t);
  const roomId = await w.newRoom();
  const SECRET_TEXT = `private reply ${crypto.randomUUID()}`;
  const trigger = await w.say(roomId, 'hi', { mentions: [w.botEp] });
  const ok = await w.reply(roomId, { in_reply_to: trigger, idempotency_key: 'k_a', text: SECRET_TEXT });
  const dup = await w.reply(roomId, { in_reply_to: trigger, idempotency_key: 'k_a', text: SECRET_TEXT });
  const refused = await w.reply(roomId, { in_reply_to: trigger, idempotency_key: 'k_b', text: SECRET_TEXT });
  const missing = await w.reply(`room_missing_${crypto.randomUUID()}`, { in_reply_to: trigger, text: SECRET_TEXT });
  assert.deepEqual([ok.status, dup.status, refused.status, missing.status], [202, 202, 403, 404]);

  const rows = (await w.db.query(`SELECT * FROM audit_events WHERE event_type = 'room.floor_warden_reply' AND subject_id = $1 ORDER BY created_at, event_id`, [w.botId])).rows;
  assert.equal(rows.length, 4, JSON.stringify(rows));
  const accepted = rows.find((r) => r.outcome === 'accepted');
  assert.deepEqual([accepted.endpoint_id, accepted.conversation_id, accepted.object_id], [w.botEp, roomId, ok.body.message_id]);
  assert.equal(rows.find((r) => r.outcome === 'duplicate').object_id, ok.body.message_id);
  const refusals = rows.filter((r) => r.outcome === 'refused').map((r) => [r.reason, r.conversation_id]).sort();
  assert.deepEqual(refusals, [['ROOM_NOT_FOUND', null], ['ROOM_NOT_INVOKED', roomId]]);

  const everyAuditRow = (await w.db.query('SELECT * FROM audit_events')).rows;
  const dump = JSON.stringify(everyAuditRow) + JSON.stringify(w.logs);
  assert.equal(dump.includes(REPLY), false, 'no token in audit rows or logs');
  assert.equal(dump.includes(SECRET_TEXT), false, 'no reply text in audit rows or logs');
});
