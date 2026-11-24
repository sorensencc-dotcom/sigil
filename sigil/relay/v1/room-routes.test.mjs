// sigil/relay/v1/room-routes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';
import { handleRoomRoute } from './room-routes.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createIdentity } from '../../cli/identity.mjs';

const principals = {
  'Bearer chris-web': { endpoint_id: 'ep_web', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer claude': { endpoint_id: 'ep_claude', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer codex': { endpoint_id: 'ep_codex', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer other-agent': { endpoint_id: 'ep_other_agent', owner_id: 'usr_other' },
  'Bearer stranger': { endpoint_id: 'ep_stranger', owner_id: 'usr_other', human_id: 'usr_other' },
};
const registry = new Map([
  ['ep_web', { owner_id: 'usr_chris', status: 'active', kind: 'human' }],
  ['ep_claude', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
  ['ep_codex', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
  ['ep_router', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
  ['ep_other_agent', { owner_id: 'usr_other', status: 'active', kind: 'agent' }],
]);
// Room creation is operator-only: the operator owns ep_web (--room-human-identity).
const humanSigner = { endpointId: 'ep_web', ownerId: 'usr_chris' };

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

async function withServer(fn, serverOptions = {}) {
  const repository = createMemoryRepository({ registry });
  const server = createRelayServer({ ...serverOptions, registry, repository, humanSigner, authenticate: async (request) => principals[request.headers.authorization] ?? null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(server.address().port, repository); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('GET /v1/mentions returns a cursor for the next mention page', async () => {
  const items = [{ conversation_id: 'room_1', message_id: 'msg_1', room_seq: '1', sender_endpoint_id: 'ep_web', text: 'hi' }];
  let seen = null;
  const response = { status: 0, payload: null, setHeader() {}, writeHead(status) { this.status = status; }, end(text) { this.payload = text ? JSON.parse(text) : null; } };
  const handled = await handleRoomRoute({
    request: { method: 'GET' },
    response,
    parsedUrl: new URL('http://relay.test/v1/mentions?limit=10'),
    principal: { endpoint_id: 'ep_claude' },
    repository: { async listMentionsForEndpoint(endpointId, limit, cursor) { seen = { endpointId, limit, cursor }; return { items, hasMore: true }; } },
    requestId: 'req_mentions',
  });
  assert.equal(handled, true);
  assert.equal(response.status, 200);
  assert.deepEqual(seen, { endpointId: 'ep_claude', limit: 10, cursor: null });
  assert.deepEqual(response.payload.items, items);
  assert.deepEqual(JSON.parse(Buffer.from(response.payload.next_cursor, 'base64url').toString()), {
    room_seq: '1', conversation_id: 'room_1', message_id: 'msg_1',
  });
});

test('GET /v1/mentions rejects a malformed cursor before querying the repository', async () => {
  let queried = false;
  const response = { status: 0, payload: null, setHeader() {}, writeHead(status) { this.status = status; }, end(text) { this.payload = text ? JSON.parse(text) : null; } };
  const handled = await handleRoomRoute({
    request: { method: 'GET' },
    response,
    parsedUrl: new URL('http://relay.test/v1/mentions?cursor=not-a-cursor!'),
    principal: { endpoint_id: 'ep_claude' },
    repository: { async listMentionsForEndpoint() { queried = true; return { items: [], hasMore: false }; } },
    requestId: 'req_mentions',
  });
  assert.equal(handled, true);
  assert.equal(response.status, 400);
  assert.equal(response.payload.code, 'INVALID_REQUEST');
  assert.equal(queried, false);
});

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

test('agent invites are room-manager-created, endpoint-bound, revocable, short-lived, and single-use', async () => {
  let clock = new Date('2026-11-24T12:00:00.000Z');
  await withServer(async (port, repository) => {
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'agent-invites' })).body.room.conversation_id;
    await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_claude', response_mode: 'mentions_only' });
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/agent-invites`, 'Bearer claude', { endpoint_id: 'ep_codex' })).status, 403);
    assert.equal((await call(port, 'GET', `/v1/rooms/${roomId}/agent-invites`, 'Bearer stranger')).status, 404);

    const created = await call(port, 'POST', `/v1/rooms/${roomId}/agent-invites`, 'Bearer chris-web', { endpoint_id: 'ep_other_agent' });
    assert.equal(created.status, 201);
    assert.equal(created.body.invite.state, 'pending');
    assert.equal(created.body.invite.endpoint_id, 'ep_other_agent');
    assert.match(created.body.invite_code, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(created.body.url, undefined);
    const code = created.body.invite_code;
    const pending = await call(port, 'GET', `/v1/rooms/${roomId}/agent-invites`, 'Bearer chris-web');
    assert.deepEqual(pending.body.items.map(({ endpoint_id, state }) => ({ endpoint_id, state })), [{ endpoint_id: 'ep_other_agent', state: 'pending' }]);
    assert.equal(JSON.stringify(pending.body).includes(code), false);

    assert.equal((await call(port, 'POST', '/v1/room-agent-invites/redeem', 'Bearer claude', { code })).status, 404, 'another active agent cannot use the code');
    assert.equal((await call(port, 'POST', '/v1/room-agent-invites/redeem', 'Bearer other-agent', { code })).status, 200);
    const connected = await call(port, 'GET', `/v1/rooms/${roomId}/agent-invites`, 'Bearer chris-web');
    assert.deepEqual(connected.body.items.map(({ endpoint_id, state }) => ({ endpoint_id, state })), [{ endpoint_id: 'ep_other_agent', state: 'connected' }]);
    const joined = await repository.lookupRoomMember(roomId, 'ep_other_agent');
    assert.deepEqual([joined.role, joined.response_mode], ['member', 'mentions_only']);
    assert.equal((await call(port, 'POST', '/v1/room-agent-invites/redeem', 'Bearer other-agent', { code })).status, 404, 'a second redemption is rejected');

    const revoked = await call(port, 'POST', `/v1/rooms/${roomId}/agent-invites`, 'Bearer chris-web', { endpoint_id: 'ep_codex' });
    const revokeResult = await call(port, 'POST', `/v1/rooms/${roomId}/agent-invites/${revoked.body.invite.invite_id}/revoke`, 'Bearer chris-web');
    assert.equal(revokeResult.body.state, 'revoked');
    assert.equal((await call(port, 'POST', '/v1/room-agent-invites/redeem', 'Bearer codex', { code: revoked.body.invite_code })).status, 404);

    const expiring = await call(port, 'POST', `/v1/rooms/${roomId}/agent-invites`, 'Bearer chris-web', { endpoint_id: 'ep_router' });
    clock = new Date(clock.getTime() + 15 * 60_000);
    assert.equal((await call(port, 'POST', '/v1/room-agent-invites/redeem', 'Bearer claude', { code: expiring.body.invite_code })).status, 404);
    const expired = await call(port, 'GET', `/v1/rooms/${roomId}/agent-invites`, 'Bearer chris-web');
    assert.equal(expired.body.items.find((row) => row.endpoint_id === 'ep_router')?.state, 'expired');
  }, { now: () => clock });
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

test('bounded history and search pages are room-scoped and use exclusive cursors', async () => {
  await withServer(async (port, repository) => {
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'searchable' })).body.room.conversation_id;
    const addMessage = async (seq, text) => {
      const messageId = `msg_search_${seq}`;
      const envelope = {
        message_id: messageId, conversation_id: roomId, message_type: 'room.message',
        sender: { endpoint_id: 'ep_web', owner_id: 'usr_chris' }, broadcast_scope: { conversation_id: roomId },
        body: { text }, idempotency_key: `idem_search_${seq}`, created_at: `2026-10-02T12:00:0${seq}.000Z`, expires_at: '2026-10-02T13:00:00.000Z',
      };
      await repository.persistAcceptedEnvelope({ envelope, message_id: messageId, canonical_hash: `hash_${seq}`, canonical_bytes: Buffer.from(`signed_${seq}`), roomSeq: BigInt(seq), roomFanout: [] });
    };
    await addMessage(1, 'Deploy failed on node 7');
    await addMessage(2, 'A build completed');
    await addMessage(3, 'Deploy contains literal 100%_complete');

    const latest = await call(port, 'GET', `/v1/rooms/${roomId}/messages?before_seq=latest&limit=2`, 'Bearer chris-web');
    assert.deepEqual(latest.body.items.map((item) => item.room_seq), ['2', '3']);
    assert.equal(latest.body.has_older, true);
    assert.equal(latest.body.next_before_seq, '2');
    const older = await call(port, 'GET', `/v1/rooms/${roomId}/messages?before_seq=2&limit=2`, 'Bearer chris-web');
    assert.deepEqual(older.body.items.map((item) => item.room_seq), ['1']);
    assert.equal(older.body.has_older, false);

    const first = await call(port, 'GET', `/v1/rooms/${roomId}/messages/search?q=deploy&limit=1`, 'Bearer chris-web');
    assert.deepEqual(first.body.items.map((item) => item.room_seq), ['3']);
    assert.equal(first.body.items[0].snippet, 'Deploy contains literal 100%_complete');
    assert.equal('envelope' in first.body.items[0], false, 'search returns only the bounded display projection');
    assert.equal(first.body.has_more, true);
    const second = await call(port, 'GET', `/v1/rooms/${roomId}/messages/search?q=deploy&before_seq=${first.body.next_before_seq}&limit=1`, 'Bearer chris-web');
    assert.deepEqual(second.body.items.map((item) => item.room_seq), ['1']);
    const literal = await call(port, 'GET', `/v1/rooms/${roomId}/messages/search?q=${encodeURIComponent('100%_')}`, 'Bearer chris-web');
    assert.deepEqual(literal.body.items.map((item) => item.room_seq), ['3']);
    assert.equal((await call(port, 'GET', `/v1/rooms/${roomId}/messages/search?q=ab`, 'Bearer chris-web')).status, 400);
    assert.equal((await call(port, 'GET', `/v1/rooms/${roomId}/messages/search?q=deploy`, 'Bearer stranger')).status, 404);
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
    const base = { roomId, workspaceId: 'ws_usr_chris', threadRootId: 'msg_root', endpointId: 'ep_claude', decidedBy: 'mention', subjectHumanId: 'usr_chris', now: new Date() };
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
    const base = { roomId, workspaceId: 'ws_usr_chris', threadRootId: 'msg_root', endpointId: 'ep_claude', decidedBy: 'mention', subjectHumanId: 'usr_chris', now: new Date() };
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
  const server = createRelayServer({ registry, repository, roomSystemIdentity, humanSigner, authenticate: async (request) => principals[request.headers.authorization] ?? null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'r' })).body.room.conversation_id;
    await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_claude', response_mode: 'joins' });
    const base = { roomId, workspaceId: 'ws_usr_chris', threadRootId: 'msg_root', endpointId: 'ep_claude', decidedBy: 'mention', subjectHumanId: 'usr_chris', now: new Date() };
    await repository.createRoomInvocation({ ...base, invocationId: 'inv_1', triggerMessageId: 'msg_1', status: 'running' });
    await repository.createRoomInvocation({ ...base, invocationId: 'inv_2', triggerMessageId: 'msg_2', status: 'queued' });
    const stopped = await call(port, 'POST', `/v1/rooms/${roomId}/stop`, 'Bearer chris-web');
    assert.deepEqual([stopped.status, stopped.body.cancelled], [200, 2]);
    const events = (await repository.listRoomMessages(roomId, 0n, 100)).map((item) => item.envelope).filter((e) => e.message_type === 'room.event' && e.body.kind === 'invocation_stopped');
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
  const server = createRelayServer({ registry: localRegistry, repository, roomSystemIdentity, humanSigner, authenticate: async (request) => principals[request.headers.authorization] ?? null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'r' })).body.room.conversation_id;
    await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_claude', response_mode: 'joins' });
    const base = { roomId, workspaceId: 'ws_usr_chris', threadRootId: 'msg_root', endpointId: 'ep_claude', decidedBy: 'mention', subjectHumanId: 'usr_chris', now: new Date() };
    await repository.createRoomInvocation({ ...base, invocationId: 'inv_1', triggerMessageId: 'msg_1', status: 'running' });
    await repository.createRoomInvocation({ ...base, invocationId: 'inv_2', triggerMessageId: 'msg_2', status: 'queued' });
    // The agent goes inactive while inv_2 waits, so completing inv_1 promotes into a refusal.
    registry.get('ep_claude').status = 'revoked';
    const failed = await call(port, 'POST', `/v1/rooms/${roomId}/invocations/fail`, 'Bearer claude', { reason: 'cli exited 1' });
    assert.equal(failed.status, 200);
    const refused = (await repository.listRoomInvocations(roomId)).find((row) => row.invocation_id === 'inv_2');
    assert.deepEqual([refused.status, refused.reason], ['refused', 'endpoint_inactive']);
    const events = (await repository.listRoomMessages(roomId, 0n, 100)).map((item) => item.envelope).filter((e) => e.message_type === 'room.event' && e.body.kind === 'invocation_refused');
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].body.kind, events[0].body.invocation_id, events[0].body.reason], ['invocation_refused', 'inv_2', 'endpoint_inactive']);
    assert.deepEqual(events[0].body.endpoint_ids, ['ep_claude']);
  } finally {
    registry.get('ep_claude').status = 'active';
    await new Promise((resolve) => server.close(resolve));
  }
});

test('fail and stop take the room lock before touching invocation rows', async () => {
  await withServer(async (port, repository) => {
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer chris-web', { name: 'r' })).body.room.conversation_id;
    await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer chris-web', { endpoint_id: 'ep_claude', response_mode: 'joins' });
    const base = { roomId, workspaceId: 'ws_usr_chris', threadRootId: 'msg_root', endpointId: 'ep_claude', decidedBy: 'mention', subjectHumanId: 'usr_chris', now: new Date() };
    await repository.createRoomInvocation({ ...base, invocationId: 'inv_1', triggerMessageId: 'msg_1', status: 'running' });
    await repository.createRoomInvocation({ ...base, invocationId: 'inv_2', triggerMessageId: 'msg_2', status: 'running', endpointId: 'ep_codex' });
    const calls = [];
    for (const name of ['lockRoom', 'lookupRunningInvocation', 'finishInvocation', 'cancelRoomInvocations']) {
      const original = repository[name].bind(repository);
      repository[name] = async (...args) => { calls.push(name); return original(...args); };
    }
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/invocations/fail`, 'Bearer claude', { reason: 'cli exited 1' })).status, 200);
    assert.equal(calls[0], 'lockRoom', `fail route order: ${calls.join(',')}`);
    calls.length = 0;
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/stop`, 'Bearer chris-web')).status, 200);
    assert.equal(calls[0], 'lockRoom', `stop route order: ${calls.join(',')}`);
  });
});
