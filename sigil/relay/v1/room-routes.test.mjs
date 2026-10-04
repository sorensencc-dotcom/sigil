// sigil/relay/v1/room-routes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createIdentity } from '../../cli/identity.mjs';

const principals = {
  'Bearer chris-web': { endpoint_id: 'ep_web', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer claude': { endpoint_id: 'ep_claude', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer codex': { endpoint_id: 'ep_codex', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer stranger': { endpoint_id: 'ep_stranger', owner_id: 'usr_other', human_id: 'usr_other' },
};
const registry = new Map([
  ['ep_web', { owner_id: 'usr_chris', status: 'active', kind: 'human' }],
  ['ep_claude', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
  ['ep_codex', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
  ['ep_router', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
  ['ep_other_agent', { owner_id: 'usr_other', status: 'active', kind: 'agent' }],
]);

function call(port, method, path, authorization, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(authorization ? { authorization } : {}) } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function withServer(fn) {
  const repository = createMemoryRepository({ registry });
  const server = createRelayServer({ registry, repository, authenticate: async (request) => principals[request.headers.authorization] ?? null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(server.address().port, repository); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('create, list, add member, read history, remove member', async () => {
  await withServer(async (port) => {
    const created = await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'build', description: 'agents' });
    assert.equal(created.status, 201);
    const roomId = created.body.room.conversation_id;
    assert.match(roomId, /^room_/);
    assert.equal((await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'build' })).body.code, 'ROOM_NAME_TAKEN');

    const added = await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_claude', response_mode: 'joins' });
    assert.equal(added.status, 201);
    assert.equal(added.body.member.role, 'member');

    const listed = await call(port, 'GET', '/v1/rooms', 'Bearer claude');
    assert.deepEqual(listed.body.items.map((r) => r.conversation_id), [roomId]);
    const members = await call(port, 'GET', `/v1/rooms/${roomId}/members`, 'Bearer claude');
    assert.deepEqual(members.body.items.map((m) => m.endpoint_id), ['ep_web', 'ep_claude']);

    const history = await call(port, 'GET', `/v1/rooms/${roomId}/messages?after_seq=0`, 'Bearer claude');
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.items, []);
    assert.equal(history.body.next_after_seq, '0');

    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members/ep_web/remove`, 'Bearer chris-web')).body.code, 'ROUTE_NOT_AUTHORIZED', 'the owner cannot be removed');
    const removed = await call(port, 'POST', `/v1/rooms/${roomId}/members/ep_claude/remove`, 'Bearer chris-web');
    assert.equal(removed.status, 200);
    assert.equal((await call(port, 'GET', `/v1/rooms/${roomId}/messages`, 'Bearer claude')).status, 404);
  });
});

test('authorization rules', async () => {
  await withServer(async (port) => {
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'ops' })).body.room.conversation_id;
    assert.equal((await call(port, 'GET', `/v1/rooms/${roomId}/messages`, 'Bearer stranger')).status, 404, 'non-members cannot see the room');
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer stranger', { endpoint_id: 'ep_other_agent' })).status, 404);
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_other_agent' })).body.code, 'ROUTE_NOT_AUTHORIZED', 'v1 adds only endpoints you own');
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_missing' })).body.code, 'ROUTE_NOT_AUTHORIZED');
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_claude', role: 'owner' })).body.code, 'INVALID_REQUEST', 'owner cannot be granted');
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_claude', response_mode: 'always' })).body.code, 'INVALID_REQUEST');
    assert.equal((await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: '' })).body.code, 'INVALID_REQUEST');
    assert.equal((await call(port, 'GET', `/v1/rooms/${roomId}/messages?after_seq=-1`, 'Bearer chris-web')).body.code, 'INVALID_REQUEST');
    const overflow = await call(port, 'GET', `/v1/rooms/${roomId}/messages?after_seq=9223372036854775808`, 'Bearer chris-web');
    assert.equal(overflow.status, 400, 'after_seq above the int8 max is refused before reaching the database');
    assert.equal(overflow.body.code, 'INVALID_REQUEST');
    assert.equal((await call(port, 'GET', `/v1/rooms/${roomId}/messages?after_seq=9223372036854775807`, 'Bearer chris-web')).status, 200, 'the int8 max itself is valid');
  });
});

test('repository failure maps to 503 DATABASE_UNAVAILABLE and the server keeps serving', async () => {
  await withServer(async (port, repository) => {
    const original = repository.listRoomsForEndpoint;
    repository.listRoomsForEndpoint = async () => { throw new Error('connection terminated: secret-detail'); };
    const failed = await call(port, 'GET', '/v1/rooms', 'Bearer chris-web');
    assert.equal(failed.status, 503);
    assert.equal(failed.body.code, 'DATABASE_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(failed.body), /secret-detail/);
    repository.listRoomsForEndpoint = original;
    const next = await call(port, 'GET', '/v1/rooms', 'Bearer chris-web');
    assert.equal(next.status, 200);
  });
});

test('history items carry canonical_bytes unchanged from the repository', async () => {
  await withServer(async (port, repository) => {
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'history' })).body.room.conversation_id;
    const envelope = {
      message_id: 'msg_hist_1', conversation_id: roomId, message_type: 'room.message',
      sender: { endpoint_id: 'ep_web', owner_id: 'usr_chris' }, broadcast_scope: { conversation_id: roomId },
      body: { text: 'hi' }, idempotency_key: 'idem_hist_1', created_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-02T13:00:00.000Z',
    };
    await repository.persistAcceptedEnvelope({ envelope, message_id: 'msg_hist_1', canonical_hash: 'h', canonical_bytes: Buffer.from('stored-signed-bytes'), roomSeq: 1n, roomFanout: [] });
    const history = await call(port, 'GET', `/v1/rooms/${roomId}/messages?after_seq=0`, 'Bearer chris-web');
    assert.equal(history.status, 200);
    assert.equal(history.body.items.length, 1);
    assert.equal(history.body.items[0].canonical_bytes, Buffer.from('stored-signed-bytes').toString('base64url'));
    assert.deepEqual(history.body.items, JSON.parse(JSON.stringify(await repository.listRoomMessages(roomId, 0n, 100))));
  });
});

test('agent tokens cannot create or manage rooms', async () => {
  await withServer(async (port) => {
    assert.equal((await call(port, 'POST', '/v1/rooms', 'Bearer claude', { name: 'agent-room' })).body.code, 'HUMAN_CONTEXT_REQUIRED');
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'r' })).body.room.conversation_id;
    await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_claude', response_mode: 'joins', role: 'room_manager' });
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer claude', { endpoint_id: 'ep_codex', response_mode: 'joins' })).body.code, 'HUMAN_CONTEXT_REQUIRED');
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members/ep_claude/remove`, 'Bearer claude')).body.code, 'HUMAN_CONTEXT_REQUIRED');
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/stop`, 'Bearer claude')).body.code, 'HUMAN_CONTEXT_REQUIRED');
  });
});

test('an agent-kind member with response_mode null cannot Stop the room', async () => {
  await withServer(async (port, repository) => {
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'r' })).body.room.conversation_id;
    await repository.addRoomMember({ conversationId: roomId, endpointId: 'ep_codex', role: 'member', responseMode: null, addedByHumanId: 'usr_chris', now: new Date() });
    const stopped = await call(port, 'POST', `/v1/rooms/${roomId}/stop`, 'Bearer codex');
    assert.deepEqual([stopped.status, stopped.body.code], [403, 'HUMAN_CONTEXT_REQUIRED']);
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/stop`, 'Bearer chris-web')).status, 200);
  });
});

test('member add requires response_mode for agents and refuses it for humans', async () => {
  await withServer(async (port) => {
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'r' })).body.room.conversation_id;
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_claude' })).body.code, 'INVALID_REQUEST');
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_web', response_mode: 'joins' })).body.code, 'INVALID_REQUEST');
  });
});

test('invocations list, fail, and stop', async () => {
  await withServer(async (port, repository) => {
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'r' })).body.room.conversation_id;
    await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_claude', response_mode: 'joins' });
    const base = { roomId, workspaceId: 'ws_usr_chris', threadRootId: 'msg_root', endpointId: 'ep_claude', decidedBy: 'mention', now: new Date() };
    await repository.createRoomInvocation({ ...base, invocationId: 'inv_1', triggerMessageId: 'msg_1', status: 'running' });
    await repository.createRoomInvocation({ ...base, invocationId: 'inv_2', triggerMessageId: 'msg_2', status: 'queued' });

    const listed = await call(port, 'GET', `/v1/rooms/${roomId}/invocations?endpoint_id=ep_claude&status=running`, 'Bearer claude');
    assert.deepEqual(listed.body.items.map((i) => i.invocation_id), ['inv_1']);

    const failed = await call(port, 'POST', `/v1/rooms/${roomId}/invocations/fail`, 'Bearer claude', { reason: 'cli exited 1' });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.invocation.status, 'failed');
    assert.equal((await repository.lookupRunningInvocation(roomId, 'ep_claude')).invocation_id, 'inv_2', 'fail promotes the queued invocation');
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/invocations/fail`, 'Bearer chris-web', {})).body.code, 'INVOCATION_NOT_FOUND');

    const stopped = await call(port, 'POST', `/v1/rooms/${roomId}/stop`, 'Bearer chris-web');
    assert.deepEqual([stopped.status, stopped.body.cancelled], [200, 1]);
    assert.equal(await repository.lookupRunningInvocation(roomId, 'ep_claude'), null);
  });
});

test('fail with invocation_id only fails the matching running invocation', async () => {
  await withServer(async (port, repository) => {
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'r' })).body.room.conversation_id;
    await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_claude', response_mode: 'joins' });
    const base = { roomId, workspaceId: 'ws_usr_chris', threadRootId: 'msg_root', endpointId: 'ep_claude', decidedBy: 'mention', now: new Date() };
    await repository.createRoomInvocation({ ...base, invocationId: 'inv_new', triggerMessageId: 'msg_1', status: 'running' });

    const stale = await call(port, 'POST', `/v1/rooms/${roomId}/invocations/fail`, 'Bearer claude', { invocation_id: 'inv_old', reason: 'late' });
    assert.deepEqual([stale.status, stale.body.code], [404, 'INVOCATION_NOT_FOUND']);
    assert.equal((await repository.lookupRunningInvocation(roomId, 'ep_claude')).invocation_id, 'inv_new', 'a mismatched id changes nothing');

    const matched = await call(port, 'POST', `/v1/rooms/${roomId}/invocations/fail`, 'Bearer claude', { invocation_id: 'inv_new', reason: 'cli exited 1' });
    assert.equal(matched.status, 200);
    assert.equal(matched.body.invocation.invocation_id, 'inv_new');
    assert.equal(matched.body.invocation.status, 'failed');

    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/invocations/fail`, 'Bearer claude', { invocation_id: 42 })).body.code, 'INVALID_REQUEST');
  });
});

test('a human room manager can add an agent endpoint with response_mode router', async () => {
  await withServer(async (port) => {
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'r' })).body.room.conversation_id;
    const added = await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_router', response_mode: 'router' });
    assert.equal(added.status, 201);
    assert.equal(added.body.member.response_mode, 'router');
  });
});

test('response_mode router is refused for a human endpoint', async () => {
  await withServer(async (port) => {
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'r' })).body.room.conversation_id;
    const refused = await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_web', response_mode: 'router' });
    assert.deepEqual([refused.status, refused.body.code], [400, 'INVALID_REQUEST']);
  });
});

test('Stop emits one invocation_stopped event per cancelled invocation', async () => {
  const roomSystemIdentity = createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' });
  const repository = createMemoryRepository({ registry });
  await repository.ensureRoomSystemEndpoint({ identity: roomSystemIdentity, now: new Date() });
  const server = createRelayServer({ registry, repository, roomSystemIdentity, authenticate: async (request) => principals[request.headers.authorization] ?? null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'r' })).body.room.conversation_id;
    await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_claude', response_mode: 'joins' });
    const base = { roomId, workspaceId: 'ws_usr_chris', threadRootId: 'msg_root', endpointId: 'ep_claude', decidedBy: 'mention', now: new Date() };
    await repository.createRoomInvocation({ ...base, invocationId: 'inv_1', triggerMessageId: 'msg_1', status: 'running' });
    await repository.createRoomInvocation({ ...base, invocationId: 'inv_2', triggerMessageId: 'msg_2', status: 'queued' });
    const stopped = await call(port, 'POST', `/v1/rooms/${roomId}/stop`, 'Bearer chris-web');
    assert.deepEqual([stopped.status, stopped.body.cancelled], [200, 2]);
    const events = (await repository.listRoomMessages(roomId, 0n, 100)).map((item) => item.envelope).filter((e) => e.message_type === 'room.event');
    assert.deepEqual(events.map((e) => e.body.kind), ['invocation_stopped', 'invocation_stopped']);
    assert.deepEqual(events.map((e) => e.body.invocation_id).sort(), ['inv_1', 'inv_2']);
    for (const event of events) assert.deepEqual(event.body.endpoint_ids, ['ep_claude']);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('a queued invocation refused on promotion emits invocation_refused', async () => {
  const roomSystemIdentity = createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' });
  const localRegistry = new Map(registry);
  localRegistry.delete('ep_relay_system');
  const repository = createMemoryRepository({ registry: localRegistry });
  await repository.ensureRoomSystemEndpoint({ identity: roomSystemIdentity, now: new Date() });
  const server = createRelayServer({ registry: localRegistry, repository, roomSystemIdentity, authenticate: async (request) => principals[request.headers.authorization] ?? null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'r' })).body.room.conversation_id;
    await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_claude', response_mode: 'joins' });
    const base = { roomId, workspaceId: 'ws_usr_chris', threadRootId: 'msg_root', endpointId: 'ep_claude', decidedBy: 'mention', now: new Date() };
    await repository.createRoomInvocation({ ...base, invocationId: 'inv_1', triggerMessageId: 'msg_1', status: 'running' });
    await repository.createRoomInvocation({ ...base, invocationId: 'inv_2', triggerMessageId: 'msg_2', status: 'queued' });
    // The agent goes inactive while inv_2 waits, so completing inv_1 promotes into a refusal.
    registry.get('ep_claude').status = 'revoked';
    const failed = await call(port, 'POST', `/v1/rooms/${roomId}/invocations/fail`, 'Bearer claude', { reason: 'cli exited 1' });
    assert.equal(failed.status, 200);
    const refused = (await repository.listRoomInvocations(roomId)).find((row) => row.invocation_id === 'inv_2');
    assert.deepEqual([refused.status, refused.reason], ['refused', 'endpoint_inactive']);
    const events = (await repository.listRoomMessages(roomId, 0n, 100)).map((item) => item.envelope).filter((e) => e.message_type === 'room.event');
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].body.kind, events[0].body.invocation_id, events[0].body.reason], ['invocation_refused', 'inv_2', 'endpoint_inactive']);
    assert.deepEqual(events[0].body.endpoint_ids, ['ep_claude']);
  } finally {
    registry.get('ep_claude').status = 'active';
    await new Promise((resolve) => server.close(resolve));
  }
});
