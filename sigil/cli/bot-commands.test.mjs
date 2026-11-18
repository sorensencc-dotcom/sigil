import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIdentity, saveIdentity } from './identity.mjs';
import { loadRegistryFile } from './registry-store.mjs';
import { createMemoryRepository } from './memory-repository.mjs';
import { cmdBotAdd, cmdBotTokenCreate, cmdBotTokenList, cmdBotTokenRevoke, cmdBotTokenRotate } from './bot-commands.mjs';
import { isReplyTokenShape } from '../relay/v1/reply-token.mjs';

const NOW = new Date('2026-10-28T12:00:00.000Z');

async function botRepository() {
  const repository = createMemoryRepository();
  await repository.insertFloorWardenBot({
    bot_id: 'bot_a',
    endpoint_id: 'ep_a',
    display_name: 'Bot A',
    status: 'active',
    created_at: NOW,
  });
  return repository;
}

function captureWrite() {
  const lines = [];
  return { lines, write: (line) => lines.push(String(line)) };
}

test('bot token create --canary stores status canary and list shows it', async () => {
  const repository = await botRepository();
  const created = captureWrite();
  await cmdBotTokenCreate(['--bot-id', 'bot_a', '--canary'], { repository, write: created.write });
  assert.equal(created.lines.length, 1);
  assert.equal(isReplyTokenShape(created.lines[0]), true);
  const listed = await repository.listReplyTokens('bot_a');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, 'canary');
  const out = captureWrite();
  await cmdBotTokenList(['--bot-id', 'bot_a'], { repository, write: out.write });
  assert.match(out.lines[0], /^frt_[0-9a-f]{32}\tcanary\t/);
});

test('bot token create without --canary still stores active', async () => {
  const repository = await botRepository();
  await cmdBotTokenCreate(['--bot-id', 'bot_a'], { repository, write: () => {} });
  assert.equal((await repository.listReplyTokens('bot_a'))[0].status, 'active');
});

test('bot token revoke works on a canary token', async () => {
  const repository = await botRepository();
  await cmdBotTokenCreate(['--bot-id', 'bot_a', '--canary'], { repository, write: () => {} });
  const tokenId = (await repository.listReplyTokens('bot_a'))[0].token_id;
  await cmdBotTokenRevoke(['--bot-id', 'bot_a', '--token-id', tokenId], { repository, write: () => {} });
  assert.equal((await repository.listReplyTokens('bot_a'))[0].status, 'revoked');
});

test('bot token rotate does not retire or promote canaries', async () => {
  const repository = await botRepository();
  await cmdBotTokenCreate(['--bot-id', 'bot_a'], { repository, write: () => {} });
  await cmdBotTokenCreate(['--bot-id', 'bot_a', '--canary'], { repository, write: () => {} });
  await cmdBotTokenRotate(['--bot-id', 'bot_a'], { repository, write: () => {} });
  const statuses = (await repository.listReplyTokens('bot_a')).map((row) => row.status).sort();
  assert.deepEqual(statuses, ['active', 'canary', 'retired']);
});

function createFakeBotAddRepo({ ownerStatus = 'active', onTxBeforeCommit = null, commitError = null } = {}) {
  const queries = [];
  const bots = [];
  const keys = [];
  return {
    queries,
    bots,
    keys,
    async withTransaction(fn) {
      const client = {
        async query(sql, params) {
          queries.push({ sql, params });
          if (sql.includes('FROM humans')) {
            return { rows: ownerStatus == null ? [] : [{ status: ownerStatus }] };
          }
          return { rows: [] };
        },
      };
      const result = await fn(client);
      if (onTxBeforeCommit) await onTxBeforeCommit();
      if (commitError) throw commitError;
      return result;
    },
    async insertBotSigningKey(entry) {
      keys.push(entry);
    },
    async insertFloorWardenBot(entry) {
      bots.push(entry);
    },
  };
}

function setupBotAddFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-bot-add-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const identityPath = path.join(dir, 'operator.json');
  saveIdentity(identityPath, createIdentity({ ownerId: 'hum_test_owner', endpointId: 'ep_test_owner', kind: 'human' }));
  const wrapKeyEnv = 'SIGIL_BOT_WRAP_KEY_UNIT_TEST';
  const saved = process.env[wrapKeyEnv];
  process.env[wrapKeyEnv] = crypto.randomBytes(32).toString('base64');
  t.after(() => {
    if (saved === undefined) delete process.env[wrapKeyEnv];
    else process.env[wrapKeyEnv] = saved;
  });
  return { dir, identityPath, wrapKeyEnv, registryPath: path.join(dir, 'registry.json') };
}

test('bot add checks active owner inside the transaction and refuses inactive or missing owner without writing files', async (t) => {
  for (const [ownerStatus, expected] of [['suspended', /not active/], [null, /not a provisioned human/]]) {
    const fx = setupBotAddFixture(t);
    const outPath = path.join(fx.dir, 'ep_test_bot.json');
    const repository = createFakeBotAddRepo({ ownerStatus });
    await assert.rejects(
      cmdBotAdd([
        '--bot-id', 'bot_test', '--endpoint', 'ep_test_bot', '--name', 'Test Bot',
        '--identity', fx.identityPath, '--out', outPath, '--registry', fx.registryPath,
        '--room-bot-key-wrap-key', fx.wrapKeyEnv,
      ], { repository, write: () => {} }),
      expected,
    );
    assert.ok(repository.queries.some((q) => /FROM humans WHERE human_id = \$1 FOR SHARE/i.test(q.sql)));
    assert.equal(repository.bots.length, 0);
    assert.equal(fs.existsSync(outPath), false);
    assert.equal(fs.existsSync(fx.registryPath), false);
  }
});

test('bot add writes identity and registry files only after the transaction commits', async (t) => {
  const fx = setupBotAddFixture(t);
  const outPath = path.join(fx.dir, 'ep_test_bot.json');
  let existedBeforeCommit = null;
  const failingRepo = createFakeBotAddRepo({
    onTxBeforeCommit: () => {
      existedBeforeCommit = fs.existsSync(outPath) || fs.existsSync(fx.registryPath);
    },
    commitError: new Error('commit failed'),
  });
  await assert.rejects(
    cmdBotAdd([
      '--bot-id', 'bot_test', '--endpoint', 'ep_test_bot', '--name', 'Test Bot',
      '--identity', fx.identityPath, '--out', outPath, '--registry', fx.registryPath,
      '--room-bot-key-wrap-key', fx.wrapKeyEnv,
    ], { repository: failingRepo, write: () => {} }),
    /commit failed/,
  );
  assert.equal(existedBeforeCommit, false, 'no files written before commit');
  assert.equal(fs.existsSync(outPath), false);
  assert.equal(fs.existsSync(fx.registryPath), false);

  const okRepo = createFakeBotAddRepo({
    onTxBeforeCommit: () => {
      assert.equal(fs.existsSync(outPath), false);
      assert.equal(fs.existsSync(fx.registryPath), false);
    },
  });
  await cmdBotAdd([
    '--bot-id', 'bot_test', '--endpoint', 'ep_test_bot', '--name', 'Test Bot',
    '--identity', fx.identityPath, '--out', outPath, '--registry', fx.registryPath,
    '--room-bot-key-wrap-key', fx.wrapKeyEnv,
  ], { repository: okRepo, write: () => {} });
  assert.equal(fs.existsSync(outPath), true);
  assert.deepEqual(loadRegistryFile(fx.registryPath).endpoints.map((e) => e.endpoint_id), ['ep_test_bot']);
});

test('concurrent bot add calls preserve all entries in registry', async (t) => {
  const fx = setupBotAddFixture(t);
  await Promise.all([
    cmdBotAdd([
      '--bot-id', 'bot_test', '--endpoint', 'ep_test_bot', '--name', 'Test Bot',
      '--identity', fx.identityPath, '--out', path.join(fx.dir, 'ep_test_bot.json'), '--registry', fx.registryPath,
      '--room-bot-key-wrap-key', fx.wrapKeyEnv,
    ], { repository: createFakeBotAddRepo(), write: () => {} }),
    cmdBotAdd([
      '--bot-id', 'bot_test_other', '--endpoint', 'ep_test_other', '--name', 'Other Bot',
      '--identity', fx.identityPath, '--out', path.join(fx.dir, 'ep_test_other.json'), '--registry', fx.registryPath,
      '--room-bot-key-wrap-key', fx.wrapKeyEnv,
    ], { repository: createFakeBotAddRepo(), write: () => {} }),
  ]);
  const ids = loadRegistryFile(fx.registryPath).endpoints.map((e) => e.endpoint_id).sort();
  assert.deepEqual(ids, ['ep_test_bot', 'ep_test_other']);
});
