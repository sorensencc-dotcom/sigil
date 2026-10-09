import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

const principals = {
  'Bearer web': { endpoint_id: 'ep_web', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer alice': { endpoint_id: 'ep_alice', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer mgr': { endpoint_id: 'ep_mgr', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer claude': { endpoint_id: 'ep_claude', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer stranger': { endpoint_id: 'ep_stranger', owner_id: 'usr_other', human_id: 'usr_other' },
};
const registry = new Map([
  ['ep_web', { owner_id: 'usr_chris', status: 'active', kind: 'human' }],
  ['ep_alice', { owner_id: 'usr_chris', status: 'active', kind: 'human' }],
  ['ep_mgr', { owner_id: 'usr_chris', status: 'active', kind: 'human' }],
  ['ep_claude', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
  ['ep_codex', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
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

// A room named "build" owned by ep_web, with ep_alice (member), ep_mgr (room_manager), and ep_claude (agent, joins).
async function withRoom(fn) {
  const frames = [];
  const stream = { notifyRoom: (endpointId, frame) => { frames.push([endpointId, frame]); return true; } };
  const repository = createMemoryRepository({ registry });
  const server = createRelayServer({ registry, repository, stream, authenticate: async (request) => principals[request.headers.authorization] ?? null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer web', { name: 'build' })).body.room.conversation_id;
    await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer web', { endpoint_id: 'ep_alice', role: 'member' });
    await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer web', { endpoint_id: 'ep_mgr', role: 'room_manager' });
    await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer web', { endpoint_id: 'ep_claude', response_mode: 'joins' });
    frames.length = 0;
    await fn({ port, roomId, frames, repository });
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('rename: the owner renames, the list reflects it, and humans get one room frame', async () => {
  await withRoom(async ({ port, roomId, frames }) => {
    const renamed = await call(port, 'POST', `/v1/rooms/${roomId}/rename`, 'Bearer web', { name: '  shipping  ' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.room.name, 'shipping');
    assert.equal((await call(port, 'GET', '/v1/rooms', 'Bearer web')).body.items[0].name, 'shipping');
    assert.deepEqual(frames.map(([id]) => id).sort(), ['ep_alice', 'ep_mgr', 'ep_web']);
    assert.deepEqual(frames[0][1], { room_id: roomId, changed: 'room' });
  });
});

test('rename: a room_manager can rename; a plain member cannot', async () => {
  await withRoom(async ({ port, roomId }) => {
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/rename`, 'Bearer mgr', { name: 'by-manager' })).status, 200);
    const refused = await call(port, 'POST', `/v1/rooms/${roomId}/rename`, 'Bearer alice', { name: 'by-member' });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'ROUTE_NOT_AUTHORIZED');
    assert.equal((await call(port, 'GET', '/v1/rooms', 'Bearer web')).body.items[0].name, 'by-manager');
  });
});

test('rename: renaming to the current name answers 200 and sends no frame', async () => {
  await withRoom(async ({ port, roomId, frames }) => {
    const same = await call(port, 'POST', `/v1/rooms/${roomId}/rename`, 'Bearer web', { name: 'build' });
    assert.equal(same.status, 200);
    assert.equal(same.body.room.name, 'build');
    assert.deepEqual(frames, []);
  });
});

test('rename: a name another room holds answers 409 and sends no frame', async () => {
  await withRoom(async ({ port, roomId, frames }) => {
    await call(port, 'POST', '/v1/rooms', 'Bearer web', { name: 'ops' });
    const clash = await call(port, 'POST', `/v1/rooms/${roomId}/rename`, 'Bearer web', { name: 'ops' });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.code, 'ROOM_NAME_TAKEN');
    assert.deepEqual(frames, []);
  });
});

test('rename: non-members get 404, agent callers 403, and bad names 400', async () => {
  await withRoom(async ({ port, roomId }) => {
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/rename`, 'Bearer stranger', { name: 'x' })).status, 404);
    const agent = await call(port, 'POST', `/v1/rooms/${roomId}/rename`, 'Bearer claude', { name: 'x' });
    assert.equal(agent.status, 403);
    assert.equal(agent.body.code, 'HUMAN_CONTEXT_REQUIRED');
    for (const name of ['', '   ', 'x'.repeat(81), 7, undefined]) {
      const bad = await call(port, 'POST', `/v1/rooms/${roomId}/rename`, 'Bearer web', { name });
      assert.equal(bad.status, 400, `name ${JSON.stringify(name)}`);
      assert.equal(bad.body.code, 'INVALID_REQUEST');
    }
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/rename`, 'Bearer web', { name: 'x'.repeat(80) })).status, 200);
  });
});
