import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createIdentity, saveIdentity } from './identity.mjs';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../scripts/apply-migrations.mjs';
import { unwrapPrivateKey } from '../relay/v1/key-wrap.mjs';
import { loadRegistryFile, toTokenHashes } from './registry-store.mjs';
import { hashBearerToken } from '../relay/v1/transport-auth.mjs';
import { cmdBotAdd } from './bot-commands.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const cli = fileURLToPath(new URL('./sigil.mjs', import.meta.url));
const run = promisify(execFile);
const wrapKey = crypto.randomBytes(32);
const env = { ...process.env, SIGIL_BOT_WRAP_KEY_TEST: wrapKey.toString('base64') };
delete env.SIGIL_BOT_WRAP_KEY_UNSET;
const OWNER = 'hum_test_operator';

async function setup(t) {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1,'active',NOW())`, [OWNER]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-bot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const identityPath = path.join(dir, 'operator.json');
  saveIdentity(identityPath, createIdentity({ ownerId: OWNER, endpointId: 'ep_test_operator', kind: 'human' }));
  return { pool, dir, identityPath };
}

const addArgs = ({ identityPath, dir }, botId = 'bot_test_one', endpoint = 'ep_test_bot', keyEnv = 'SIGIL_BOT_WRAP_KEY_TEST') => [
  cli, 'bot', 'add', '--bot-id', botId, '--endpoint', endpoint, '--name', 'Test Bot',
  '--identity', identityPath, '--out', path.join(dir, `${endpoint}.json`), '--registry', path.join(dir, 'registry.json'),
  '--database-url', connectionString, '--room-bot-key-wrap-key', keyEnv,
];

test('bot add creates endpoint, key, wrapped signing key, roster row, and a keyless identity file', { skip: !connectionString }, async (t) => {
  const ctx = await setup(t);
  const { stdout, stderr } = await run(process.execPath, addArgs(ctx), { env });
  const row = (await ctx.pool.query('SELECT owner_id, kind, status, display_name FROM endpoints WHERE endpoint_id = $1', ['ep_test_bot'])).rows[0];
  assert.deepEqual({ ...row }, { owner_id: OWNER, kind: 'agent', status: 'active', display_name: 'Test Bot' });
  const key = (await ctx.pool.query(`SELECT key_id, public_key, status FROM endpoint_keys WHERE endpoint_id = 'ep_test_bot'`)).rows;
  assert.equal(key.length, 1);
  assert.equal(key[0].status, 'active');
  const wrapped = (await ctx.pool.query('SELECT wrapped_private_key FROM bot_signing_keys WHERE key_id = $1', [key[0].key_id])).rows[0].wrapped_private_key;
  const priv = unwrapPrivateKey({ wrapKey, endpointId: 'ep_test_bot', keyId: key[0].key_id, wrapped });
  const pub = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' });
  assert.ok(Buffer.from(pub).equals(key[0].public_key));
  const bot = (await ctx.pool.query('SELECT bot_id, endpoint_id, display_name, status FROM floor_warden_bots')).rows;
  assert.deepEqual(bot.map((b) => ({ ...b })), [{ bot_id: 'bot_test_one', endpoint_id: 'ep_test_bot', display_name: 'Test Bot', status: 'active' }]);

  const file = path.join(ctx.dir, 'ep_test_bot.json');
  const raw = fs.readFileSync(file, 'utf8');
  const identity = JSON.parse(raw);
  assert.equal(identity.endpoint_id, 'ep_test_bot');
  assert.equal(identity.owner_id, OWNER);
  assert.equal(identity.kind, 'agent');
  assert.equal(identity.receive_only, true);
  assert.ok(identity.relay_token && identity.relay_token.length >= 32);
  assert.ok(!raw.includes('private_key_pem'));
  assert.ok(!raw.includes('PRIVATE KEY'));

  const out = `${stdout}\n${stderr}`;
  assert.match(out, /bot_test_one/);
  assert.match(out, /ep_test_bot/);
  assert.ok(out.includes(file));
  assert.ok(out.includes('restart relay after `bot add` so it loads the new token'));
  assert.ok(!out.includes(identity.relay_token), 'token never printed');
  const registry = loadRegistryFile(path.join(ctx.dir, 'registry.json'));
  assert.equal(toTokenHashes(registry).get(hashBearerToken(identity.relay_token)), 'ep_test_bot');
  const entry = registry.endpoints.find((e) => e.endpoint_id === 'ep_test_bot');
  assert.equal(entry.public_key_pem, identity.public_key_pem);
  assert.ok(!JSON.stringify(registry).includes('PRIVATE KEY'));
  assert.ok(!out.includes('PRIVATE KEY'));
  assert.ok(!out.includes(priv.export({ type: 'pkcs8', format: 'der' }).toString('base64')));
});

test('bot add refuses a duplicate bot id and leaves nothing behind for the second endpoint', { skip: !connectionString }, async (t) => {
  const ctx = await setup(t);
  await run(process.execPath, addArgs(ctx), { env });
  await assert.rejects(
    run(process.execPath, addArgs(ctx, 'bot_test_one', 'ep_test_bot_two'), { env }),
    (error) => /already exists/.test(error.stderr),
  );
  for (const table of ['endpoints', 'endpoint_keys']) {
    const n = (await ctx.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE endpoint_id = 'ep_test_bot_two'`)).rows[0].n;
    assert.equal(n, 0, table);
  }
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM bot_signing_keys')).rows[0].n, 1);
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM floor_warden_bots')).rows[0].n, 1);
  assert.ok(!fs.existsSync(path.join(ctx.dir, 'ep_test_bot_two.json')), 'no identity file after a rolled-back add');
  const registry = loadRegistryFile(path.join(ctx.dir, 'registry.json'));
  assert.deepEqual(registry.endpoints.map((e) => e.endpoint_id), ['ep_test_bot'], 'no registry entry after a rolled-back add');
});

test('bot add refuses a duplicate endpoint with a clear message', { skip: !connectionString }, async (t) => {
  const ctx = await setup(t);
  await run(process.execPath, addArgs(ctx), { env });
  await assert.rejects(
    run(process.execPath, addArgs(ctx, 'bot_test_two', 'ep_test_bot'), { env }),
    (error) => /ep_test_bot/.test(error.stderr) && /already exists/.test(error.stderr),
  );
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM floor_warden_bots')).rows[0].n, 1);
});

test('bot add without a wrap key env var fails before any write', { skip: !connectionString }, async (t) => {
  const ctx = await setup(t);
  await assert.rejects(
    run(process.execPath, addArgs(ctx, 'bot_test_one', 'ep_test_bot', 'SIGIL_BOT_WRAP_KEY_UNSET'), { env }),
    (error) => /not set/.test(error.stderr),
  );
  assert.equal((await ctx.pool.query(`SELECT count(*)::int AS n FROM endpoints WHERE endpoint_id = 'ep_test_bot'`)).rows[0].n, 0);
  assert.ok(!fs.existsSync(path.join(ctx.dir, 'ep_test_bot.json')));
});

test('bot disable sets status disabled and is idempotent', { skip: !connectionString }, async (t) => {
  const ctx = await setup(t);
  await run(process.execPath, addArgs(ctx), { env });
  const args = [cli, 'bot', 'disable', '--bot-id', 'bot_test_one', '--database-url', connectionString];
  const first = await run(process.execPath, args, { env });
  assert.match(first.stdout, /bot_test_one/);
  assert.equal((await ctx.pool.query(`SELECT status FROM floor_warden_bots WHERE bot_id = 'bot_test_one'`)).rows[0].status, 'disabled');
  await run(process.execPath, args, { env });
  assert.equal((await ctx.pool.query(`SELECT status FROM floor_warden_bots WHERE bot_id = 'bot_test_one'`)).rows[0].status, 'disabled');
  await assert.rejects(
    run(process.execPath, [cli, 'bot', 'disable', '--bot-id', 'bot_nope', '--database-url', connectionString], { env }),
    (error) => /bot_nope/.test(error.stderr),
  );
});

test('bot add removes a partial identity file and rolls back when the write fails', { skip: !connectionString }, async (t) => {
  const ctx = await setup(t);
  const outPath = path.join(ctx.dir, 'ep_test_bot.json');
  const registryPath = path.join(ctx.dir, 'registry.json');
  const original = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, data, options) => {
    if (file === outPath) {
      original(file, '{"relay_token":"part', options);
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    return original(file, data, options);
  });
  t.mock.method(console, 'log', () => {});
  const saved = process.env.SIGIL_BOT_WRAP_KEY_TEST;
  process.env.SIGIL_BOT_WRAP_KEY_TEST = env.SIGIL_BOT_WRAP_KEY_TEST;
  t.after(() => { if (saved === undefined) delete process.env.SIGIL_BOT_WRAP_KEY_TEST; else process.env.SIGIL_BOT_WRAP_KEY_TEST = saved; });
  await assert.rejects(cmdBotAdd(addArgs(ctx).slice(3)), /disk full/);
  assert.ok(!fs.existsSync(outPath), 'partial identity file removed');
  assert.ok(!fs.existsSync(registryPath), 'no registry written');
  assert.equal((await ctx.pool.query(`SELECT count(*)::int AS n FROM endpoints WHERE endpoint_id = 'ep_test_bot'`)).rows[0].n, 0);
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM floor_warden_bots')).rows[0].n, 0);
});

test('bot add never deletes an identity file that already exists at --out', { skip: !connectionString }, async (t) => {
  const ctx = await setup(t);
  const outPath = path.join(ctx.dir, 'ep_test_bot.json');
  fs.writeFileSync(outPath, 'someone else');
  await assert.rejects(run(process.execPath, addArgs(ctx), { env }), (error) => /already exists/.test(error.stderr));
  assert.equal(fs.readFileSync(outPath, 'utf8'), 'someone else');
});
