import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

test('memory repository preserves report_only for an agent member', async () => {
  const repository = createMemoryRepository({
    registry: new Map([
      ['ep_report', { owner_id: 'usr_owner', status: 'active', kind: 'agent' }],
    ]),
  });

  await repository.createRoom({
    conversationId: 'room_report_only',
    workspaceId: 'ws_report_only',
    name: 'reports',
    createdByHumanId: 'usr_owner',
    ownerEndpointId: 'ep_report',
  });

  const member = await repository.addRoomMember({
    conversationId: 'room_report_only',
    endpointId: 'ep_report_2',
    role: 'member',
    responseMode: 'report_only',
    addedByHumanId: 'usr_owner',
  });

  assert.equal(member.response_mode, 'report_only');
  assert.equal(
    (await repository.lookupRoomMember('room_report_only', 'ep_report_2')).response_mode,
    'report_only',
  );
});
