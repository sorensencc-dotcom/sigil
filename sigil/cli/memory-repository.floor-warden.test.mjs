import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const LATER = new Date('2026-10-16T12:00:05.000Z');
const EARLIER = new Date('2026-10-16T11:59:55.000Z');
const registry = new Map([['ep_web', { owner_id: 'usr_chris', status: 'active' }], ['ep_claude', { owner_id: 'usr_chris', status: 'active' }]]);

async function setup() {
  const repository = createMemoryRepository({ registry });
  await repository.createRoom({ conversationId: 'room_1', workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
  return repository;
}

const botRow = { bot_id: 'bot_a', endpoint_id: 'ep_bot_a', display_name: 'Bot A', status: 'active', created_at: NOW.toISOString() };
const refusalBase = { roomId: 'room_1', workspaceId: 'ws_usr_chris', threadRootId: 'msg_root', decidedBy: 'mention', subjectHumanId: 'usr_chris' };

test('insertFloorWardenBot then lookupFloorWardenBot round trip', async () => {
  const repository = await setup();
  await repository.insertFloorWardenBot(botRow);
  assert.deepEqual(await repository.lookupFloorWardenBot('bot_a'), { bot_id: 'bot_a', endpoint_id: 'ep_bot_a', display_name: 'Bot A', status: 'active' });
  assert.equal(await repository.lookupFloorWardenBot('bot_missing'), null);
});

test('duplicate bot_id throws BOT_EXISTS', async () => {
  const repository = await setup();
  await repository.insertFloorWardenBot(botRow);
  await assert.rejects(repository.insertFloorWardenBot({ ...botRow, endpoint_id: 'ep_bot_other' }), { code: 'BOT_EXISTS' });
});

test('duplicate endpoint_id throws BOT_EXISTS', async () => {
  const repository = await setup();
  await repository.insertFloorWardenBot(botRow);
  await assert.rejects(repository.insertFloorWardenBot({ ...botRow, bot_id: 'bot_other' }), { code: 'BOT_EXISTS' });
});

test('a disabled bot still returns with status disabled', async () => {
  const repository = await setup();
  await repository.insertFloorWardenBot({ ...botRow, status: 'disabled' });
  assert.equal((await repository.lookupFloorWardenBot('bot_a')).status, 'disabled');
});

test('insertBotSigningKey then loadWrappedBotSigningKey; unknown key is null', async () => {
  const repository = await setup();
  const wrapped = Buffer.from('wrapped-bytes');
  await repository.insertBotSigningKey({ keyId: 'key_bot_a', wrapped, now: NOW });
  assert.deepEqual(await repository.loadWrappedBotSigningKey('key_bot_a'), wrapped);
  assert.equal(await repository.loadWrappedBotSigningKey('key_unknown'), null);
});

test('resetAgentTurns bumps cap_epoch by one and returns it', async () => {
  const repository = await setup();
  assert.equal(await repository.resetAgentTurns('room_1', 'msg_root', { now: NOW }), 1);
  assert.equal(await repository.resetAgentTurns('room_1', 'msg_root', { now: LATER }), 2);
});

test('listCapRefusedEndpoints returns hop_budget refusals after last_reset_at, de-duplicated', async () => {
  const repository = await setup();
  const mk = (n, extra) => repository.createRoomInvocation({ ...refusalBase, invocationId: `inv_${n}`, triggerMessageId: `msg_${n}`, status: 'refused', reason: 'hop_budget', ...extra });
  await mk('old', { endpointId: 'ep_old', now: EARLIER });
  await repository.resetAgentTurns('room_1', 'msg_root', { now: NOW });
  await mk(1, { endpointId: 'ep_claude', now: LATER });
  await mk(2, { endpointId: 'ep_claude', now: LATER });
  await mk(3, { endpointId: 'ep_other_reason', reason: 'not_a_member', now: LATER });
  await mk(4, { endpointId: 'ep_other_thread', threadRootId: 'msg_other', now: LATER });
  assert.deepEqual(await repository.listCapRefusedEndpoints('room_1', 'msg_root'), ['ep_claude']);
});

test('listCapRefusedEndpoints counts all refusals when the thread was never reset', async () => {
  const repository = await setup();
  await repository.createRoomInvocation({ ...refusalBase, invocationId: 'inv_1', triggerMessageId: 'msg_1', endpointId: 'ep_claude', status: 'refused', reason: 'hop_budget', now: NOW });
  assert.deepEqual(await repository.listCapRefusedEndpoints('room_1', 'msg_root'), ['ep_claude']);
});
