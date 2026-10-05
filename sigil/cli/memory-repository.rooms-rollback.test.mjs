import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const invocation = (overrides = {}) => ({
  invocationId: 'inv_1', roomId: 'room_1', workspaceId: 'ws_1', triggerMessageId: 'msg_1', threadRootId: 'msg_1',
  endpointId: 'ep_claude', decidedBy: 'mention', status: 'running', now: NOW, ...overrides,
});

test('a throw inside withTransaction undoes room invocation, turn, and delivery writes', async () => {
  const repository = createMemoryRepository({});
  await assert.rejects(repository.withTransaction(async () => {
    await repository.resetAgentTurns('room_1', 'msg_1', { now: NOW });
    await repository.reserveAgentTurn('room_1', 'msg_1', 6, { now: NOW });
    await repository.createRoomInvocation(invocation());
    await repository.createRoomDelivery({ messageId: 'msg_1', endpointId: 'ep_claude', now: NOW });
    throw new Error('rejected after writes');
  }), /rejected after writes/);

  assert.equal(await repository.lookupRunningInvocation('room_1', 'ep_claude'), null);
  assert.deepEqual(await repository.listRoomInvocations('room_1'), []);
  const turn = await repository.reserveAgentTurn('room_1', 'msg_1', 1, { now: NOW });
  assert.deepEqual(turn, { allowed: true, agent_turns: 1 }, 'both turn writes were undone');
});

test('a throw undoes a finish and a stop of an invocation committed earlier', async () => {
  const repository = createMemoryRepository({});
  await repository.createRoomInvocation(invocation());
  await assert.rejects(repository.withTransaction(async () => {
    await repository.finishInvocation('inv_1', { status: 'completed', replyMessageId: 'msg_2', now: NOW });
    throw new Error('rejected after finish');
  }), /rejected after finish/);
  assert.equal((await repository.lookupRunningInvocation('room_1', 'ep_claude'))?.invocation_id, 'inv_1');

  await assert.rejects(repository.withTransaction(async () => {
    await repository.cancelRoomInvocations('room_1', { now: NOW });
    throw new Error('rejected after stop');
  }), /rejected after stop/);
  const [row] = await repository.listRoomInvocations('room_1');
  assert.equal(row.status, 'running');
  assert.equal(row.reply_message_id, null);
});

test('a committed transaction keeps its room writes', async () => {
  const repository = createMemoryRepository({});
  await repository.withTransaction(async () => {
    await repository.createRoomInvocation(invocation());
  });
  assert.equal((await repository.lookupRunningInvocation('room_1', 'ep_claude'))?.invocation_id, 'inv_1');
});
