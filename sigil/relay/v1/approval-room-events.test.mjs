// sigil/relay/v1/approval-room-events.test.mjs -- rooms #269 signed hold events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createIdentity } from '../../cli/identity.mjs';
import { approvalEventBody, approvalEventKey, createApprovalRoomHook } from './approval-room-events.mjs';
import { runApprovalExpiryPass } from './approval-expiry-sweep.mjs';

const NOW = new Date('2026-11-28T12:00:00.000Z');

async function world() {
  const system = createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' });
  const registered = new Map([
    ['ep_web', { owner_id: 'usr_chris', status: 'active', kind: 'human', display_name: 'Chris' }],
    ['ep_claude', { owner_id: 'usr_chris', status: 'active', kind: 'agent', display_name: 'Claude' }],
  ]);
  const repository = createMemoryRepository({ registry: registered });
  await repository.ensureRoomSystemEndpoint({ identity: system, now: NOW });
  await repository.createRoom({ conversationId: 'room_1', workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_chris', now: NOW });
  const frames = [];
  const stream = { notifyRoom(endpointId, frame) { frames.push({ endpointId, frame }); } };
  const hook = (outcome, at = NOW) => createApprovalRoomHook({ outcome, repository, systemIdentity: system, registered, stream, now: at });
  return { system, repository, registered, stream, frames, hook };
}

function challengeFor(id, { expiresAt = new Date(NOW.getTime() + 60_000), conversationId = 'room_1', messageId = `msg_held_${id.replace("ch_", "")}` } = {}) {
  return {
    id, endpointId: 'ep_claude', actionHash: `hash_${id}`, webauthnChallenge: `wa_${id}`, callbackUrl: 'http://cb.test',
    token: `tok_${id}`, expiresAt: expiresAt.toISOString(), conversationId, messageId,
    capabilities: ['payments.send'], envelope: { message_id: messageId, body: { text: 'secret held content' } },
  };
}

async function events(repository) {
  return (await repository.listRoomMessages('room_1', 0n, 100)).filter((item) => item.envelope.message_type === 'room.event');
}

test('approvalEventBody names the held message and the capabilities, never the challenge id', () => {
  const body = approvalEventBody('granted', { challengeId: 'ch_secret', endpointId: 'ep_claude', messageId: 'msg_held', capabilities: ['payments.send', 'files.write'] });
  assert.deepEqual(body, { kind: 'approval_granted', endpoint_ids: ['ep_claude'], held_message_id: 'msg_held', reason: 'payments.send, files.write' });
  const key = approvalEventKey('granted', 'ch_secret');
  assert.doesNotMatch(key, /ch_secret/);
  assert.notEqual(key, approvalEventKey('granted', 'ch_other'));
  assert.notEqual(key, approvalEventKey('cancelled', 'ch_secret'));
});

test('create, approve: one signed event each, an approvals frame to humans only, no challenge id or held body', async () => {
  const { repository, frames, hook } = await world();
  await repository.createApprovalChallenge(challengeFor('ch_1'), { onChange: hook('requested') });
  await repository.finalizeApprovalDecision({ challengeId: 'ch_1', humanId: 'usr_chris', credentialId: 'cred_1', endpointId: 'ep_claude', now: NOW, onChange: hook('granted') });
  const rows = await events(repository);
  assert.deepEqual(rows.map((row) => row.envelope.body.kind), ['approval_requested', 'approval_granted']);
  for (const row of rows) {
    assert.equal(row.envelope.body.held_message_id, 'msg_held_1');
    assert.equal(row.envelope.sender.endpoint_id, 'ep_relay_system');
    const wire = JSON.stringify(row.envelope);
    assert.doesNotMatch(wire, /ch_1\b/);
    assert.doesNotMatch(wire, /secret held content/);
  }
  const approvals = frames.filter(({ frame }) => frame.changed === 'approvals');
  assert.deepEqual(approvals.map(({ endpointId }) => endpointId), ['ep_web', 'ep_web']);
});

test('cancel writes approval_cancelled once; a repeat cancel writes nothing', async () => {
  const { repository, hook } = await world();
  await repository.createApprovalChallenge(challengeFor('ch_2'), { onChange: hook('requested') });
  await repository.cancelApprovalChallenge({ challengeId: 'ch_2', endpointId: 'ep_claude', now: NOW, onChange: hook('cancelled') });
  const again = await repository.cancelApprovalChallenge({ challengeId: 'ch_2', endpointId: 'ep_claude', now: NOW, onChange: hook('cancelled') });
  assert.equal(again.duplicate, true);
  assert.deepEqual((await events(repository)).map((row) => row.envelope.body.kind), ['approval_requested', 'approval_cancelled']);
});

test('a failed emit rolls the state change back', async () => {
  const { repository, hook } = await world();
  const boom = async () => { throw new Error('emit failed'); };
  await assert.rejects(repository.createApprovalChallenge(challengeFor('ch_3'), { onChange: boom }), /emit failed/);
  assert.equal(await repository.getApprovalChallenge('ch_3'), null);

  await repository.createApprovalChallenge(challengeFor('ch_4'), { onChange: hook('requested') });
  await assert.rejects(repository.finalizeApprovalDecision({ challengeId: 'ch_4', humanId: 'usr_chris', credentialId: 'cred_1', endpointId: 'ep_claude', now: NOW, onChange: boom }), /emit failed/);
  assert.equal((await repository.getApprovalChallenge('ch_4')).status, 'pending');
  await assert.rejects(repository.cancelApprovalChallenge({ challengeId: 'ch_4', endpointId: 'ep_claude', now: NOW, onChange: boom }), /emit failed/);
  assert.equal((await repository.getApprovalChallenge('ch_4')).status, 'pending');
  assert.deepEqual((await events(repository)).map((row) => row.envelope.body.kind), ['approval_requested']);
});

test('a challenge outside a room writes no event and no frame', async () => {
  const { repository, frames, hook } = await world();
  const bare = { ...challengeFor('ch_5'), conversationId: undefined, messageId: undefined, envelope: undefined };
  await repository.createApprovalChallenge(bare, { onChange: hook('requested') });
  assert.equal((await events(repository)).length, 0);
  assert.equal(frames.length, 0);
});

test('the sweep records an expired hold once, in an idle room, even with two passes at once', async () => {
  const { system, repository, registered, stream, hook } = await world();
  await repository.createApprovalChallenge(challengeFor('ch_6', { expiresAt: new Date(NOW.getTime() + 1000) }), { onChange: hook('requested') });
  await repository.createApprovalChallenge(challengeFor('ch_7', { expiresAt: new Date(NOW.getTime() + 600_000) }), { onChange: hook('requested') });
  const later = new Date(NOW.getTime() + 5000);
  const pass = () => runApprovalExpiryPass({ repository, systemIdentity: system, registered, stream, now: later });
  const [a, b] = await Promise.all([pass(), pass()]);
  assert.equal(a.expired + b.expired, 1);
  assert.equal((await repository.getApprovalChallenge('ch_6')).status, 'expired');
  assert.equal((await repository.getApprovalChallenge('ch_7')).status, 'pending');
  const expired = (await events(repository)).filter((row) => row.envelope.body.kind === 'approval_expired');
  assert.equal(expired.length, 1);
  assert.equal(expired[0].envelope.body.held_message_id, 'msg_held_6');
  // An expired hold can't then be approved or cancelled.
  await assert.rejects(repository.finalizeApprovalDecision({ challengeId: 'ch_6', humanId: 'usr_chris', credentialId: 'cred_1', endpointId: 'ep_claude', now: later }), { code: 'APPROVAL_EXPIRED' });
  await assert.rejects(repository.cancelApprovalChallenge({ challengeId: 'ch_6', endpointId: 'ep_claude', now: later }), { code: 'APPROVAL_EXPIRED' });
});

test('a sweep row whose emit fails stays pending and is retried on the next pass', async () => {
  const { system, repository, registered, stream, hook } = await world();
  await repository.createApprovalChallenge(challengeFor('ch_8', { expiresAt: new Date(NOW.getTime() + 1000) }), { onChange: hook('requested') });
  const later = new Date(NOW.getTime() + 5000);
  const failing = { ...repository, lookupRoom: async () => { throw new Error('room read failed'); } };
  const first = await repository.expireRoomApprovalChallenges({ now: later, onChange: createApprovalRoomHook({ outcome: 'expired', repository: failing, systemIdentity: system, registered, stream, now: later }) });
  assert.deepEqual(first, { expired: 0, failed: 1 });
  assert.equal((await repository.getApprovalChallenge('ch_8')).status, 'pending');
  const second = await runApprovalExpiryPass({ repository, systemIdentity: system, registered, stream, now: later });
  assert.deepEqual(second, { expired: 1, failed: 0 });
});

test('a message held twice gets a record for each hold', async () => {
  const { repository, hook } = await world();
  await repository.createApprovalChallenge(challengeFor('ch_9', { messageId: 'msg_same' }), { onChange: hook('requested') });
  await repository.cancelApprovalChallenge({ challengeId: 'ch_9', endpointId: 'ep_claude', now: NOW, onChange: hook('cancelled') });
  await repository.createApprovalChallenge(challengeFor('ch_10', { messageId: 'msg_same' }), { onChange: hook('requested') });
  const kinds = (await events(repository)).map((row) => row.envelope.body.kind);
  assert.deepEqual(kinds, ['approval_requested', 'approval_cancelled', 'approval_requested']);
});

test('without a system identity the hook still sends the approvals frame', async () => {
  const { repository, registered, stream, frames } = await world();
  const onChange = createApprovalRoomHook({ outcome: 'requested', repository, systemIdentity: null, registered, stream, now: NOW });
  await repository.createApprovalChallenge(challengeFor('ch_11'), { onChange });
  assert.equal((await events(repository)).length, 0);
  assert.deepEqual(frames.map(({ frame }) => frame.changed), ['approvals']);
});
