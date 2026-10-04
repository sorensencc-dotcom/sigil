import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const registry = new Map([['ep_web', { owner_id: 'usr_chris', status: 'active' }], ['ep_claude', { owner_id: 'usr_chris', status: 'active' }]]);

async function setup() {
  const repository = createMemoryRepository({ registry });
  await repository.createRoom({ conversationId: 'room_1', workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
  return repository;
}

const base = { roomId: 'room_1', workspaceId: 'ws_usr_chris', threadRootId: 'msg_root', endpointId: 'ep_claude', decidedBy: 'mention', now: NOW };

test('lookupRoom carries max_agent_turns 6', async () => {
  const repository = await setup();
  assert.equal((await repository.lookupRoom('room_1')).max_agent_turns, 6);
});

test('running, queued, promotion, and finish', async () => {
  const repository = await setup();
  const running = await repository.createRoomInvocation({ ...base, invocationId: 'inv_1', triggerMessageId: 'msg_1', status: 'running', deliveryId: 'del_a' });
  assert.equal(running.status, 'running');
  assert.equal(running.started_at, NOW.toISOString());
  await repository.createRoomInvocation({ ...base, invocationId: 'inv_2', triggerMessageId: 'msg_2', status: 'queued' });
  assert.equal((await repository.lookupRunningInvocation('room_1', 'ep_claude')).invocation_id, 'inv_1');
  assert.equal((await repository.nextQueuedInvocation('room_1', 'ep_claude')).invocation_id, 'inv_2');
  const done = await repository.finishInvocation('inv_1', { status: 'completed', replyMessageId: 'msg_reply', now: NOW });
  assert.equal(done.reply_message_id, 'msg_reply');
  assert.equal(await repository.finishInvocation('inv_1', { status: 'failed', now: NOW }), null, 'a terminal row does not move');
  const started = await repository.startInvocation('inv_2', { deliveryId: 'del_b', now: NOW });
  assert.equal(started.status, 'running');
  assert.equal(started.delivery_id, 'del_b');
});

test('a second running invocation for the same agent and room is refused', async () => {
  const repository = await setup();
  await repository.createRoomInvocation({ ...base, invocationId: 'inv_1', triggerMessageId: 'msg_1', status: 'running' });
  await assert.rejects(
    repository.createRoomInvocation({ ...base, invocationId: 'inv_2', triggerMessageId: 'msg_2', status: 'running' }),
    { code: 'ROOM_INVOCATION_RUNNING' },
  );
});

test('the same trigger cannot invoke the same agent twice', async () => {
  const repository = await setup();
  await repository.createRoomInvocation({ ...base, invocationId: 'inv_1', triggerMessageId: 'msg_1', status: 'refused', reason: 'hop_budget' });
  await assert.rejects(
    repository.createRoomInvocation({ ...base, invocationId: 'inv_2', triggerMessageId: 'msg_1', status: 'queued' }),
    { code: 'ROOM_INVOCATION_EXISTS' },
  );
});

test('cancelRoomInvocations cancels queued and running rows only', async () => {
  const repository = await setup();
  await repository.createRoomInvocation({ ...base, invocationId: 'inv_1', triggerMessageId: 'msg_1', status: 'running' });
  await repository.createRoomInvocation({ ...base, invocationId: 'inv_2', triggerMessageId: 'msg_2', status: 'queued' });
  await repository.createRoomInvocation({ ...base, invocationId: 'inv_3', triggerMessageId: 'msg_3', status: 'refused', reason: 'hop_budget' });
  const cancelled = await repository.cancelRoomInvocations('room_1', { now: NOW });
  assert.deepEqual(cancelled.map((row) => row.invocation_id).sort(), ['inv_1', 'inv_2']);
  assert.equal(await repository.lookupRunningInvocation('room_1', 'ep_claude'), null);
  assert.deepEqual((await repository.listRoomInvocations('room_1', { status: 'refused' })).map((row) => row.invocation_id), ['inv_3']);
});

test('reserveAgentTurn stops at the limit and resetAgentTurns clears it', async () => {
  const repository = await setup();
  for (let turn = 1; turn <= 2; turn += 1) assert.deepEqual(await repository.reserveAgentTurn('room_1', 'msg_root', 2, { now: NOW }), { allowed: true, agent_turns: turn });
  assert.deepEqual(await repository.reserveAgentTurn('room_1', 'msg_root', 2, { now: NOW }), { allowed: false, agent_turns: 2 });
  await repository.resetAgentTurns('room_1', 'msg_root', { now: NOW });
  assert.equal((await repository.reserveAgentTurn('room_1', 'msg_root', 2, { now: NOW })).agent_turns, 1);
});

test('createRoomDelivery writes an open delivery for an existing message', async () => {
  const repository = await setup();
  const deliveryId = await repository.createRoomDelivery({ messageId: 'msg_1', endpointId: 'ep_claude', now: NOW });
  assert.equal(deliveryId, 'del_msg_1_ep_claude');
  assert.equal(await repository.countOpenDeliveries('ep_claude'), 1);
});
