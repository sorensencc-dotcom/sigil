import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const NOW = new Date('2026-10-16T12:00:00.000Z');
const LATER = new Date('2026-10-16T12:00:05.000Z');
const EARLIER = new Date('2026-10-16T11:59:55.000Z');

let pool;
let migrated;
async function ready() {
  assertDisposableTestDatabase(connectionString);
  migrated ??= applyMigrations(connectionString, { reset: true }).then(() => {
    pool = new pg.Pool({ connectionString });
  });
  await migrated;
  return pool;
}

async function addEndpoint(db, humanId, endpointId, runtime, kind) {
  await db.query(
    `INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $1, 'active', NOW())`,
    [endpointId, humanId, runtime, kind, `install_${endpointId}`],
  );
}

async function setup() {
  const db = await ready();
  const run = crypto.randomUUID().replaceAll('-', '_');
  const human = `usr_fw_${run}`;
  const web = `ep_web_${run}`;
  const claude = `ep_claude_${run}`;
  const botEndpoint = `ep_bot_${run}`;
  const botEndpoint2 = `ep_bot2_${run}`;
  await db.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [human]);
  await addEndpoint(db, human, web, 'web', 'human');
  await addEndpoint(db, human, claude, 'claude', 'agent');
  await addEndpoint(db, human, botEndpoint, 'bot', 'agent');
  await addEndpoint(db, human, botEndpoint2, 'bot', 'agent');
  const repository = new PostgresRepository({ pool: db });
  const roomId = `room_${run}`;
  const workspaceId = `ws_${human}`;
  await repository.createRoom({ conversationId: roomId, workspaceId, name: `build_${run}`, createdByHumanId: human, ownerEndpointId: web, now: NOW });
  const base = { roomId, workspaceId, threadRootId: 'msg_root', decidedBy: 'mention', subjectHumanId: human };
  return { db, run, human, web, claude, botEndpoint, botEndpoint2, repository, roomId, base };
}

test('insertFloorWardenBot then lookupFloorWardenBot round trip', { skip: !connectionString }, async () => {
  const { repository, run, botEndpoint } = await setup();
  await repository.insertFloorWardenBot({ bot_id: `bot_${run}`, endpoint_id: botEndpoint, display_name: 'Bot A', status: 'active', created_at: NOW.toISOString() });
  assert.deepEqual(await repository.lookupFloorWardenBot(`bot_${run}`), { bot_id: `bot_${run}`, endpoint_id: botEndpoint, display_name: 'Bot A', status: 'active' });
  assert.equal(await repository.lookupFloorWardenBot('bot_missing'), null);
});

test('duplicate bot_id throws BOT_EXISTS', { skip: !connectionString }, async () => {
  const { repository, run, botEndpoint, botEndpoint2 } = await setup();
  const row = { bot_id: `bot_${run}`, endpoint_id: botEndpoint, display_name: 'Bot A', status: 'active', created_at: NOW.toISOString() };
  await repository.insertFloorWardenBot(row);
  await assert.rejects(repository.insertFloorWardenBot({ ...row, endpoint_id: botEndpoint2 }), { code: 'BOT_EXISTS' });
});

test('duplicate endpoint_id throws BOT_EXISTS', { skip: !connectionString }, async () => {
  const { repository, run, botEndpoint } = await setup();
  const row = { bot_id: `bot_${run}`, endpoint_id: botEndpoint, display_name: 'Bot A', status: 'active', created_at: NOW.toISOString() };
  await repository.insertFloorWardenBot(row);
  await assert.rejects(repository.insertFloorWardenBot({ ...row, bot_id: `bot_other_${run}` }), { code: 'BOT_EXISTS' });
});

test('a disabled bot still returns with status disabled', { skip: !connectionString }, async () => {
  const { repository, run, botEndpoint } = await setup();
  await repository.insertFloorWardenBot({ bot_id: `bot_${run}`, endpoint_id: botEndpoint, display_name: 'Bot A', status: 'disabled', created_at: NOW.toISOString() });
  assert.equal((await repository.lookupFloorWardenBot(`bot_${run}`)).status, 'disabled');
});

test('insertBotSigningKey then loadWrappedBotSigningKey; unknown key is null', { skip: !connectionString }, async () => {
  const { db, repository, run, botEndpoint } = await setup();
  const keyId = `key_bot_${run}`;
  await db.query(
    `INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from) VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())`,
    [keyId, botEndpoint, Buffer.alloc(32, 2)],
  );
  const wrapped = Buffer.from('wrapped-bytes');
  await repository.insertBotSigningKey({ keyId, wrapped, now: NOW });
  assert.deepEqual(await repository.loadWrappedBotSigningKey(keyId), wrapped);
  assert.equal(await repository.loadWrappedBotSigningKey('key_unknown'), null);
});

test('resetAgentTurns bumps cap_epoch by one and returns it', { skip: !connectionString }, async () => {
  const { db, repository, roomId } = await setup();
  assert.equal(await repository.resetAgentTurns(roomId, 'msg_root', { now: NOW }), 1);
  assert.equal(await repository.resetAgentTurns(roomId, 'msg_root', { now: LATER }), 2);
  const row = (await db.query('SELECT cap_epoch, last_reset_at FROM room_threads WHERE room_id = $1 AND thread_root_id = $2', [roomId, 'msg_root'])).rows[0];
  assert.equal(row.cap_epoch, 2);
  assert.equal(row.last_reset_at.toISOString(), LATER.toISOString());
});

test('listCapRefusedEndpoints returns hop_budget refusals after last_reset_at, de-duplicated', { skip: !connectionString }, async () => {
  const { db, human, repository, roomId, base, claude, run } = await setup();
  for (const id of [`ep_old_${run}`, `ep_reason_${run}`, `ep_thread_${run}`]) await addEndpoint(db, human, id, 'claude', 'agent');
  const mk= (n, extra) => repository.createRoomInvocation({ ...base, invocationId: `inv_${n}_${run}`, triggerMessageId: `msg_${n}_${run}`, status: 'refused', reason: 'hop_budget', ...extra });
  await mk('old', { endpointId: `ep_old_${run}`, now: EARLIER });
  await repository.resetAgentTurns(roomId, 'msg_root', { now: NOW });
  await mk(1, { endpointId: claude, now: LATER });
  await mk(2, { endpointId: claude, now: LATER });
  await mk(3, { endpointId: `ep_reason_${run}`, reason: 'not_a_member', now: LATER });
  await mk(4, { endpointId: `ep_thread_${run}`, threadRootId: 'msg_other', now: LATER });
  assert.deepEqual(await repository.listCapRefusedEndpoints(roomId, 'msg_root'), [claude]);
});

test('listCapRefusedEndpoints counts all refusals when the thread was never reset', { skip: !connectionString }, async () => {
  const { repository, roomId, base, claude, run } = await setup();
  await repository.createRoomInvocation({ ...base, invocationId: `inv_1_${run}`, triggerMessageId: `msg_1_${run}`, endpointId: claude, status: 'refused', reason: 'hop_budget', now: NOW });
  assert.deepEqual(await repository.listCapRefusedEndpoints(roomId, 'msg_root'), [claude]);
});
