// Phase 7 setup — Task 7: disposable-PostgreSQL proof of provisioning and reruns.
// Runs serially against a disposable `_test` database only (`SIGIL_TEST_DATABASE_URL`).
// Fixture IDs only (`ep_test_bot`, `ep_test_other`).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createIdentity, saveIdentity } from './identity.mjs';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../scripts/apply-migrations.mjs';
import { planSetup } from './phase7-setup-policy.mjs';
import { inspectSetup } from './phase7-setup-inspect.mjs';
import { applySetup, applyPhrase, botPhrase } from './phase7-setup-apply.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const DOMAIN = 'fixture.example';
const DB_LABEL = 'sigil_test';
const OWNER_ID = 'hum_test_operator';
const WRAP_ENV = 'SIGIL_TEST_BOT_WRAP_KEY';
const wrapKeyB64 = crypto.randomBytes(32).toString('base64');

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

async function readJsonOrNull(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (err) { if (err?.code === 'ENOENT') return null; throw err; }
}

async function setupEnv(t) {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());

  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [OWNER_ID]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-p7-pg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const operatorIdentityPath = path.join(dir, 'operator.identity.json');
  const registryPath = path.join(dir, 'registry.json');
  const opIdentity = createIdentity({ ownerId: OWNER_ID, endpointId: `ep_test_operator@${DOMAIN}`, kind: 'human' });
  saveIdentity(operatorIdentityPath, opIdentity);

  await pool.query(
    `INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, kind, created_at)
     VALUES ($1, $2, 'test', 'inst_op', 'Test Operator', 'active', 'human', NOW())`,
    [opIdentity.endpoint_id, OWNER_ID],
  );

  const migrationNames = (await fsp.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const config = {
    secretRoot: dir,
    operatorIdentityPath,
    registryPath,
    dbLabel: DB_LABEL,
    databaseEnv: 'SIGIL_TEST_DATABASE_URL',
    wrapKeyRef: WRAP_ENV,
    relayDomain: DOMAIN,
    routine: { urlEnv: 'FIXTURE_URL', keyEnv: 'FIXTURE_KEY', keyHeader: 'Authorization' },
    bots: [
      {
        botId: 'bot_test_one',
        endpointId: `ep_test_bot@${DOMAIN}`,
        displayName: 'Test Bot One',
        role: 'reply',
        roleConfirmed: true,
        identityPath: path.join(dir, 'ep_test_bot.identity.json'),
      },
      {
        botId: 'bot_test_other',
        endpointId: `ep_test_other@${DOMAIN}`,
        displayName: 'Test Bot Other',
        role: 'reply',
        roleConfirmed: true,
        identityPath: path.join(dir, 'ep_test_other.identity.json'),
      },
    ],
  };

  const inspect = async () => {
    const snap = await inspectSetup({ ...config, operatorOwnerId: OWNER_ID }, {
      pool,
      readIdentity: readJsonOrNull,
      readRegistry: () => readJsonOrNull(registryPath),
      migrationNames,
    });
    return {
      ...snap,
      routine: { urlState: 'present', keyState: 'present' },
      registryRefresh: 'verified',
      registryPreflight: { ok: true, gaps: [] },
    };
  };

  const storage = {
    checkpoints: [],
    assertReady() {},
    async checkpoint(meta) { this.checkpoints.push(meta); },
  };

  const env = { ...process.env, SIGIL_TEST_DATABASE_URL: connectionString, [WRAP_ENV]: wrapKeyB64 };
  return { pool, dir, config, inspect, storage, env };
}

function scriptedConfirm(answers) {
  const queue = [...answers];
  return async () => (queue.length ? queue.shift() : '');
}

test('first-run creation provisions both bots and healthy rerun makes zero changes', { skip: !connectionString }, async (t) => {
  const { pool, config, inspect, storage, env } = await setupEnv(t);

  const initialSnap = await inspect();
  const plan1 = planSetup(initialSnap, { apply: true });
  assert.deepEqual(plan1.blockers, []);
  assert.equal(plan1.create.length, 2);

  const res1 = await applySetup({
    config,
    plan: plan1,
    storage,
    inspect,
    confirm: scriptedConfirm([
      applyPhrase(DB_LABEL),
      botPhrase(`ep_test_bot@${DOMAIN}`),
      botPhrase(`ep_test_other@${DOMAIN}`),
    ]),
    spawn,
    isTTY: true,
    env,
  });

  assert.equal(res1.status, 'completed');
  assert.deepEqual(res1.bots.map((b) => b.result), ['created', 'created']);

  const createdRows = (await pool.query(
    `SELECT endpoint_id, created_at FROM endpoints WHERE endpoint_id = ANY($1) ORDER BY endpoint_id`,
    [[`ep_test_bot@${DOMAIN}`, `ep_test_other@${DOMAIN}`]],
  )).rows;
  assert.equal(createdRows.length, 2);

  // Rerun on healthy state must skip creation and spawn zero child processes.
  const rerunSnap = await inspect();
  const plan2 = planSetup(rerunSnap, { apply: true });
  assert.deepEqual(plan2.blockers, []);
  assert.equal(plan2.create.length, 0);

  let spawned = 0;
  const res2 = await applySetup({
    config,
    plan: plan2,
    storage,
    inspect,
    confirm: scriptedConfirm([applyPhrase(DB_LABEL)]),
    spawn: () => { spawned += 1; throw new Error('must not spawn on healthy rerun'); },
    isTTY: true,
    env,
  });

  assert.equal(res2.status, 'nothing-to-create');
  assert.equal(spawned, 0);
  const afterRows = (await pool.query(
    `SELECT endpoint_id, created_at FROM endpoints WHERE endpoint_id = ANY($1) ORDER BY endpoint_id`,
    [[`ep_test_bot@${DOMAIN}`, `ep_test_other@${DOMAIN}`]],
  )).rows;
  assert.deepEqual(afterRows, createdRows);
});

test('partial and conflict states block provisioning against Postgres', { skip: !connectionString }, async (t) => {
  const { pool, config, inspect, storage, env } = await setupEnv(t);

  // Partial: identity file exists on disk with no matching Postgres rows.
  saveIdentity(config.bots[0].identityPath, {
    ...createIdentity({ ownerId: OWNER_ID, endpointId: config.bots[0].endpointId, kind: 'agent' }),
    bot_id: config.bots[0].botId,
    receive_only: true,
  });

  const partialSnap = await inspect();
  const partialPlan = planSetup(partialSnap, { apply: true });
  assert.ok(partialPlan.blockers.includes('bot-partial:bot_test_one'));

  let spawned = 0;
  const partialRes = await applySetup({
    config,
    plan: partialPlan,
    storage,
    inspect,
    confirm: scriptedConfirm([applyPhrase(DB_LABEL)]),
    spawn: () => { spawned += 1; throw new Error('must not spawn when partial'); },
    isTTY: true,
    env,
  });
  assert.equal(partialRes.status, 'blocked');
  assert.equal(spawned, 0);

  // Conflict: remove leftover identity file and insert conflicting roster row in Postgres.
  fs.rmSync(config.bots[0].identityPath, { force: true });
  await pool.query(
    `INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, kind, created_at)
     VALUES ($1, $2, 'test', 'inst_conflict', 'Conflict Bot', 'active', 'agent', NOW())`,
    [`ep_test_conflict@${DOMAIN}`, OWNER_ID],
  );
  await pool.query(
    `INSERT INTO floor_warden_bots (bot_id, endpoint_id, display_name, status, created_at)
     VALUES ($1, $2, 'Conflict Bot', 'active', NOW())`,
    [config.bots[0].botId, `ep_test_conflict@${DOMAIN}`],
  );

  const conflictSnap = await inspect();
  const conflictPlan = planSetup(conflictSnap, { apply: true });
  assert.ok(conflictPlan.blockers.includes('bot-conflict:bot_test_one'));

  const conflictRes = await applySetup({
    config,
    plan: conflictPlan,
    storage,
    inspect,
    confirm: scriptedConfirm([applyPhrase(DB_LABEL)]),
    spawn: () => { spawned += 1; throw new Error('must not spawn when conflict'); },
    isTTY: true,
    env,
  });
  assert.equal(conflictRes.status, 'blocked');
  assert.equal(spawned, 0);
});

test('revoke race: operator revoked in Postgres after planning blocks apply before spawning', { skip: !connectionString }, async (t) => {
  const { pool, config, inspect, storage, env } = await setupEnv(t);

  const initialSnap = await inspect();
  const plan = planSetup(initialSnap, { apply: true });
  assert.equal(plan.create.length, 2);

  let spawned = 0;
  const res = await applySetup({
    config,
    plan,
    storage,
    inspect,
    confirm: async () => {
      // Simulate operator revocation racing between initial plan and locked re-inspection.
      await pool.query(`UPDATE humans SET status = 'revoked' WHERE human_id = $1`, [OWNER_ID]);
      return applyPhrase(DB_LABEL);
    },
    spawn: () => { spawned += 1; throw new Error('must not spawn when operator revoked'); },
    isTTY: true,
    env,
  });

  assert.equal(res.status, 'blocked');
  assert.ok(res.blockers.includes('operator-inactive'));
  assert.equal(spawned, 0);
  const botCount = (await pool.query(`SELECT count(*)::int AS n FROM floor_warden_bots`)).rows[0].n;
  assert.equal(botCount, 0);
});
