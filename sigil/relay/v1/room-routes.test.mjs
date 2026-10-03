// sigil/relay/v1/room-routes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

const principals = {
  'Bearer chris-web': { endpoint_id: 'ep_web', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer claude': { endpoint_id: 'ep_claude', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer stranger': { endpoint_id: 'ep_stranger', owner_id: 'usr_other', human_id: 'usr_other' },
};
const registry = new Map([
  ['ep_web', { owner_id: 'usr_chris', status: 'active' }],
  ['ep_claude', { owner_id: 'usr_chris', status: 'active' }],
  ['ep_other_agent', { owner_id: 'usr_other', status: 'active' }],
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
