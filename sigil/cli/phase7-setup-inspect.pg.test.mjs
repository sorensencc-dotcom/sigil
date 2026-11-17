// Phase 7 setup: the inspection's reply-token count, against the real schema.
// Runs only with SIGIL_TEST_DATABASE_URL set to a disposable test database.
// Fixture IDs only; token hashes are fixed fake bytes, never a real token.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';
import { INSPECTION_SQL } from './phase7-setup-inspect.mjs';
import { evaluateReplyToken } from '../relay/v1/reply-token.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function setup(t) {
  const { default: pg } = await import('pg');
  const { applyMigrations } = await import('../scripts/apply-migrations.mjs');
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  return { pool, suffix: crypto.randomUUID().replaceAll('-', '_') };
}

async function seedBot(pool, suffix, tag) {
  const owner = `h_${tag}_${suffix}`;
  const endpointId = `ep_test_bot_${tag}_${suffix}`;
  const botId = `bot_test_${tag}_${suffix}`;
  await pool.query(`INSERT INTO humans (human_id,status,created_at) VALUES ($1,'active',NOW())`, [owner]);
  await pool.query(`INSERT INTO endpoints (endpoint_id,owner_id,runtime,installation_id,display_name,status,kind,created_at) VALUES ($1,$2,'test',$3,$1,'active','agent',NOW())`, [endpointId, owner, `i_${tag}_${suffix}`]);
  await pool.query(`INSERT INTO floor_warden_bots (bot_id,endpoint_id,display_name,status,created_at) VALUES ($1,$2,'Test Bot','active',NOW())`, [botId, endpointId]);
  return botId;
}

let fill = 1;
async function token(pool, botId, status, expiresAt) {
  const n = fill++;
  await pool.query(
    'INSERT INTO floor_warden_reply_tokens (token_id,bot_id,token_sha256,status,created_at,expires_at) VALUES ($1,$2,$3,$4,NOW(),$5)',
    [`frt_test_${botId}_${n}`, botId, Buffer.alloc(32, n), status, expiresAt],
  );
}

const count = async (pool, botId) => (await pool.query(INSPECTION_SQL.replyTokens, [botId])).rows[0].active;

test('setup counts exactly the reply tokens that reply ingress accepts', { skip: !connectionString }, async (t) => {
  const { pool, suffix } = await setup(t);
  const hour = 3_600_000;
  const past = new Date(Date.now() - hour);
  const future = new Date(Date.now() + hour);
  const cases = [
    ['active', 'active', null],
    ['activepast', 'active', past],
    ['activefuture', 'active', future],
    ['gracefuture', 'retired', future],
    ['gracenull', 'retired', null],
    ['gracepast', 'retired', past],
    ['revoked', 'revoked', null],
    ['canary', 'canary', null],
  ];
  for (const [tag, status, expiresAt] of cases) {
    const botId = await seedBot(pool, suffix, tag);
    await token(pool, botId, status, expiresAt);
    const accepted = evaluateReplyToken({ status, expires_at: expiresAt }).ok;
    assert.equal(await count(pool, botId), accepted ? 1 : 0, tag);
  }
  assert.equal(await count(pool, await seedBot(pool, suffix, 'none')), 0, 'no token');
});
