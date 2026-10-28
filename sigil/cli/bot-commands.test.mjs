import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';
import { cmdBotTokenCreate, cmdBotTokenList, cmdBotTokenRevoke, cmdBotTokenRotate } from './bot-commands.mjs';
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
