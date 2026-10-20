import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { PostgresRepository } from './postgres-repository.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const at = (minutes) => new Date(`2030-01-01T00:${String(minutes).padStart(2, '0')}:00.000Z`);
const hash = (value) => Buffer.alloc(32, value);

async function setup(t) {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  await pool.query(`INSERT INTO humans (human_id,status,created_at) VALUES ($1,'active',NOW())`, [`h_${suffix}`]);
  await pool.query(`INSERT INTO endpoints (endpoint_id,owner_id,runtime,installation_id,display_name,status,kind,created_at) VALUES ($1,$2,'test',$3,$1,'active','agent',NOW())`, [`ep_${suffix}`, `h_${suffix}`, `i_${suffix}`]);
  await pool.query(`INSERT INTO floor_warden_bots (bot_id,endpoint_id,display_name,status,created_at) VALUES ($1,$2,'Test','active',NOW())`, [`bot_${suffix}`, `ep_${suffix}`]);
  return { pool, repository: new PostgresRepository({ pool }), suffix, botId: `bot_${suffix}` };
}

test('Postgres reply token methods preserve the memory repository contract', { skip: !connectionString }, async (t) => {
  const { pool, repository, suffix, botId } = await setup(t);
  const otherBot = `other_${suffix}`;
  await pool.query(`INSERT INTO humans (human_id,status,created_at) VALUES ($1,'active',NOW())`, [`oh_${suffix}`]);
  await pool.query(`INSERT INTO endpoints (endpoint_id,owner_id,runtime,installation_id,display_name,status,kind,created_at) VALUES ($1,$2,'test',$3,$1,'active','agent',NOW())`, [`oep_${suffix}`, `oh_${suffix}`, `oi_${suffix}`]);
  await pool.query(`INSERT INTO floor_warden_bots (bot_id,endpoint_id,display_name,status,created_at) VALUES ($1,$2,'Other','active',NOW())`, [otherBot, `oep_${suffix}`]);

  await repository.insertReplyToken({ tokenId: `frt_a_${suffix}`, botId, tokenSha256: hash(1), status: 'active', createdAt: at(0), expiresAt: null });
  await repository.insertReplyToken({ tokenId: `frt_a2_${suffix}`, botId, tokenSha256: hash(2), status: 'active', createdAt: at(1), expiresAt: null });
  await repository.insertReplyToken({ tokenId: `frt_b_${suffix}`, botId: otherBot, tokenSha256: hash(3), status: 'active', createdAt: at(0), expiresAt: null });
  assert.equal((await repository.lookupReplyTokenByHash(hash(1))).token_id, `frt_a_${suffix}`);
  assert.equal(await repository.lookupReplyTokenByHash(hash(4)), null);
  assert.equal(await repository.retireActiveReplyTokens(botId, at(10)), 2);
  assert.equal((await repository.lookupReplyTokenByHash(hash(1))).status, 'retired');
  assert.equal((await repository.lookupReplyTokenByHash(hash(3))).status, 'active');
  assert.equal(await repository.revokeReplyToken(`frt_a_${suffix}`, at(11)), true);
  assert.equal(await repository.revokeReplyToken(`frt_a_${suffix}`, at(12)), false);
  assert.equal('token_sha256' in (await repository.listReplyTokens(botId))[0], false);
  assert.equal(await repository.touchReplyTokenLastUsed(`frt_a2_${suffix}`, at(13), 60_000), true);
  assert.equal(await repository.touchReplyTokenLastUsed(`frt_a2_${suffix}`, new Date(at(13).getTime() + 30_000), 60_000), false);
  await repository.recordAuditEvent({ eventType: 'room.floor_warden_reply', subjectId: botId, outcome: 'accepted', now: at(5) });
  await repository.recordAuditEvent({ eventType: 'room.floor_warden_reply', subjectId: botId, outcome: 'refused', now: at(6) });
  await repository.recordAuditEvent({ eventType: 'room.floor_warden_reply', subjectId: otherBot, outcome: 'accepted', now: at(7) });
  assert.equal(await repository.countAcceptedReplies({ botId, since: at(4) }), 1);
  assert.deepEqual(await repository.reserveRateLimit('floor_warden_reply', botId, at(0), 30), { count: 1, allowed: true });
});

test('Postgres reply token bot_id is a foreign key', { skip: !connectionString }, async (t) => {
  const { repository, suffix } = await setup(t);
  await assert.rejects(repository.insertReplyToken({ tokenId: `frt_bad_${suffix}`, botId: `missing_${suffix}`, tokenSha256: hash(9), status: 'active', createdAt: at(0), expiresAt: null }), { code: '23503' });
});
