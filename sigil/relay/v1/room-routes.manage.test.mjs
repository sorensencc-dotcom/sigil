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
  'Bearer guest': { endpoint_id: 'ep_guest', owner_id: 'usr_guest', human_id: 'usr_guest' },
};
const registry = new Map([
  ['ep_web', { owner_id: 'usr_chris', status: 'active', kind: 'human' }],
  ['ep_alice', { owner_id: 'usr_chris', status: 'active', kind: 'human' }],
  ['ep_mgr', { owner_id: 'usr_chris', status: 'active', kind: 'human' }],
  ['ep_claude', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
  ['ep_codex', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
  ['ep_guest', { owner_id: 'usr_guest', status: 'active', kind: 'human' }],
  ['ep_guest_agent', { owner_id: 'usr_guest', status: 'active', kind: 'agent' }],
]);
// The operator is the human owning the --room-human-identity endpoint (ep_web).
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

// A room named "build" owned by ep_web, with ep_alice (member), ep_mgr (room_manager), and ep_claude (agent, joins).
async function withRoom(fn) {
  const frames = [];
  const stream = { notifyRoom: (endpointId, frame) => { frames.push([endpointId, frame]); return true; } };
  const repository = createMemoryRepository({ registry });
  const server = createRelayServer({ registry, repository, stream, humanSigner, authenticate: async (request) => principals[request.headers.authorization] ?? null });
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

const modePath = (roomId, endpointId) => `/v1/rooms/${roomId}/members/${endpointId}/response-mode`;

test('response mode: the owner changes an agent mode and humans get a members frame', async () => {
  await withRoom(async ({ port, roomId, frames }) => {
    const changed = await call(port, 'POST', modePath(roomId, 'ep_claude'), 'Bearer web', { response_mode: 'mentions_only' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.member.endpoint_id, 'ep_claude');
    assert.equal(changed.body.member.response_mode, 'mentions_only');
    const members = (await call(port, 'GET', `/v1/rooms/${roomId}/members`, 'Bearer web')).body.items;
    assert.equal(members.find((m) => m.endpoint_id === 'ep_claude').response_mode, 'mentions_only');
    assert.deepEqual(frames.map(([id]) => id).sort(), ['ep_alice', 'ep_mgr', 'ep_web']);
    assert.deepEqual(frames[0][1], { room_id: roomId, changed: 'members' });
  });
});

test('response mode: a percent-encoded endpoint ID in the path resolves to the member', async () => {
  await withRoom(async ({ port, roomId }) => {
    const changed = await call(port, 'POST', modePath(roomId, 'ep%5Fclaude'), 'Bearer web', { response_mode: 'router' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.member.endpoint_id, 'ep_claude');
    const malformed = await call(port, 'POST', modePath(roomId, '%E0%A4%A'), 'Bearer web', { response_mode: 'router' });
    assert.equal(malformed.status, 400);
  });
});

test('response mode: managers only, humans only as callers, valid modes only', async () => {
  await withRoom(async ({ port, roomId }) => {
    assert.equal((await call(port, 'POST', modePath(roomId, 'ep_claude'), 'Bearer mgr', { response_mode: 'router' })).status, 200);
    const member = await call(port, 'POST', modePath(roomId, 'ep_claude'), 'Bearer alice', { response_mode: 'joins' });
    assert.equal(member.status, 403);
    assert.equal(member.body.code, 'ROUTE_NOT_AUTHORIZED');
    const agent = await call(port, 'POST', modePath(roomId, 'ep_claude'), 'Bearer claude', { response_mode: 'joins' });
    assert.equal(agent.status, 403);
    assert.equal(agent.body.code, 'HUMAN_CONTEXT_REQUIRED');
    assert.equal((await call(port, 'POST', modePath(roomId, 'ep_claude'), 'Bearer stranger', { response_mode: 'joins' })).status, 404);
    for (const response_mode of ['always', '', null, 7, undefined]) {
      const bad = await call(port, 'POST', modePath(roomId, 'ep_claude'), 'Bearer web', { response_mode });
      assert.equal(bad.status, 400, `mode ${JSON.stringify(response_mode)}`);
      assert.equal(bad.body.code, 'INVALID_REQUEST');
    }
  });
});

test('response mode: human targets answer 400 and non-members 404', async () => {
  await withRoom(async ({ port, roomId }) => {
    const human = await call(port, 'POST', modePath(roomId, 'ep_alice'), 'Bearer web', { response_mode: 'joins' });
    assert.equal(human.status, 400);
    assert.equal(human.body.code, 'INVALID_REQUEST');
    const owner = await call(port, 'POST', modePath(roomId, 'ep_web'), 'Bearer web', { response_mode: 'joins' });
    assert.equal(owner.status, 400);
    const missing = await call(port, 'POST', modePath(roomId, 'ep_codex'), 'Bearer web', { response_mode: 'joins' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'ROOM_MEMBER_NOT_FOUND');
  });
});

test('response mode: a phase 1 agent with a null mode can be given one, and a second router is allowed like on add', async () => {
  await withRoom(async ({ port, roomId, repository }) => {
    await repository.addRoomMember({ conversationId: roomId, endpointId: 'ep_codex', role: 'member', responseMode: null, addedByHumanId: 'usr_chris' });
    assert.equal((await call(port, 'POST', modePath(roomId, 'ep_codex'), 'Bearer web', { response_mode: 'router' })).status, 200);
    assert.equal((await call(port, 'POST', modePath(roomId, 'ep_claude'), 'Bearer web', { response_mode: 'router' })).status, 200);
    const routers = (await call(port, 'GET', `/v1/rooms/${roomId}/members`, 'Bearer web')).body.items.filter((m) => m.response_mode === 'router');
    assert.deepEqual(routers.map((m) => m.endpoint_id).sort(), ['ep_claude', 'ep_codex']);
  });
});

// Task 4 (multi-human foundation): addRoomMember reads owner, status, and kind
// from repository.lookupTrustedEndpoint, not the startup registry Map. The
// repository below knows endpoints the server's `registry` Map does not.
test('add member: an endpoint known only to the repository is added; system and other-owner endpoints get 403', async () => {
  const repoRegistry = new Map([
    ...registry,
    ['ep_pgonly_agent', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
    ['ep_pgonly_human', { owner_id: 'usr_chris', status: 'active', kind: 'human' }],
    ['ep_sys', { owner_id: 'usr_chris', status: 'active', kind: 'system' }],
    ['ep_foreign', { owner_id: 'usr_other', status: 'active', kind: 'agent' }],
  ]);
  const repository = createMemoryRepository({ registry: repoRegistry });
  const server = createRelayServer({ registry, repository, humanSigner, authenticate: async (request) => principals[request.headers.authorization] ?? null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const roomId = (await call(port, 'POST', '/v1/rooms', 'Bearer web', { name: 'pgonly' })).body.room.conversation_id;
    const agent = await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer web', { endpoint_id: 'ep_pgonly_agent', response_mode: 'joins' });
    assert.equal(agent.status, 201, JSON.stringify(agent.body));
    const human = await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer web', { endpoint_id: 'ep_pgonly_human', role: 'member' });
    assert.equal(human.status, 201, JSON.stringify(human.body));
    for (const endpointId of ['ep_sys', 'ep_foreign', 'ep_missing']) {
      const refused = await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer web', { endpoint_id: endpointId, role: 'member' });
      assert.equal(refused.status, 403, `${endpointId}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.code, 'ROUTE_NOT_AUTHORIZED');
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

// Invocation policy (Task 13, case 8): only the agent's owner sets invokable_by.
const invokablePath = (roomId, endpointId) => `/v1/rooms/${roomId}/members/${encodeURIComponent(endpointId)}/invokable-by`;

test('invokable-by: a guest room_manager gets 403, the agent owner succeeds, and humans get one members frame', async () => {
  await withRoom(async ({ port, roomId, frames, repository }) => {
    await repository.addRoomMember({ conversationId: roomId, endpointId: 'ep_guest', role: 'room_manager', addedByHumanId: 'usr_chris' });
    const guest = await call(port, 'POST', invokablePath(roomId, 'ep_claude'), 'Bearer guest', { invokable_by: 'members' });
    assert.deepEqual([guest.status, guest.body.code], [403, 'ROUTE_NOT_AUTHORIZED']);
    assert.equal((await repository.lookupRoomMember(roomId, 'ep_claude')).invokable_by, 'owner');
    frames.length = 0;
    const owner = await call(port, 'POST', invokablePath(roomId, 'ep_claude'), 'Bearer web', { invokable_by: 'members' });
    assert.equal(owner.status, 200, JSON.stringify(owner.body));
    assert.deepEqual([owner.body.member.endpoint_id, owner.body.member.invokable_by, owner.body.member.owner_id], ['ep_claude', 'members', 'usr_chris']);
    assert.equal((await repository.lookupRoomMember(roomId, 'ep_claude')).invokable_by, 'members');
    assert.ok(frames.length > 0 && frames.every(([, frame]) => frame.changed === 'members'));
  });
});

test('invokable-by: bad mode 400, human target 400, non-member 404, agent caller 403', async () => {
  await withRoom(async ({ port, roomId }) => {
    assert.equal((await call(port, 'POST', invokablePath(roomId, 'ep_claude'), 'Bearer web', { invokable_by: 'everyone' })).status, 400);
    assert.equal((await call(port, 'POST', invokablePath(roomId, 'ep_alice'), 'Bearer web', { invokable_by: 'members' })).status, 400);
    assert.equal((await call(port, 'POST', invokablePath(roomId, 'ep_codex'), 'Bearer web', { invokable_by: 'members' })).status, 404);
    assert.equal((await call(port, 'POST', invokablePath(roomId, 'ep_claude'), 'Bearer claude', { invokable_by: 'members' })).status, 403);
  });
});

test('invokable-by: removing and re-adding an agent resets it to owner', async () => {
  await withRoom(async ({ port, roomId }) => {
    assert.equal((await call(port, 'POST', invokablePath(roomId, 'ep_claude'), 'Bearer web', { invokable_by: 'members' })).status, 200);
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members/ep_claude/remove`, 'Bearer web')).status, 200);
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members`, 'Bearer web', { endpoint_id: 'ep_claude', response_mode: 'joins' })).status, 201);
    const claude = (await call(port, 'GET', `/v1/rooms/${roomId}/members`, 'Bearer web')).body.items.find((m) => m.endpoint_id === 'ep_claude');
    assert.equal(claude.invokable_by, 'owner');
  });
});

// Task 14: owner-scoped agent controls. A room_manager role alone grants no
// control over another human's agent; removing humans stays manager-only.
async function addGuestWithAgent(repository, roomId, role = 'room_manager') {
  await repository.addRoomMember({ conversationId: roomId, endpointId: 'ep_guest', role, addedByHumanId: 'usr_chris' });
  await repository.addRoomMember({ conversationId: roomId, endpointId: 'ep_guest_agent', role: 'member', responseMode: 'mentions_only', addedByHumanId: 'usr_guest' });
}

test('agent controls: a guest room_manager cannot change response-mode of or remove an agent they do not own; the owner can', async () => {
  await withRoom(async ({ port, roomId, repository }) => {
    await addGuestWithAgent(repository, roomId);
    const mode = await call(port, 'POST', modePath(roomId, 'ep_claude'), 'Bearer guest', { response_mode: 'router' });
    assert.deepEqual([mode.status, mode.body.code], [403, 'ROUTE_NOT_AUTHORIZED']);
    assert.equal((await repository.lookupRoomMember(roomId, 'ep_claude')).response_mode, 'joins');
    const removed = await call(port, 'POST', `/v1/rooms/${roomId}/members/ep_claude/remove`, 'Bearer guest');
    assert.deepEqual([removed.status, removed.body.code], [403, 'ROUTE_NOT_AUTHORIZED']);
    assert.ok(await repository.lookupRoomMember(roomId, 'ep_claude'));
    // The operator, a manager too, does not own the guest's agent.
    const operatorMode = await call(port, 'POST', modePath(roomId, 'ep_guest_agent'), 'Bearer web', { response_mode: 'router' });
    assert.deepEqual([operatorMode.status, operatorMode.body.code], [403, 'ROUTE_NOT_AUTHORIZED']);
    const operatorRemove = await call(port, 'POST', `/v1/rooms/${roomId}/members/ep_guest_agent/remove`, 'Bearer web');
    assert.deepEqual([operatorRemove.status, operatorRemove.body.code], [403, 'ROUTE_NOT_AUTHORIZED']);
    // Each owner controls their own agent.
    assert.equal((await call(port, 'POST', modePath(roomId, 'ep_guest_agent'), 'Bearer guest', { response_mode: 'joins' })).status, 200);
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members/ep_guest_agent/remove`, 'Bearer guest')).status, 200);
    assert.equal((await call(port, 'POST', modePath(roomId, 'ep_claude'), 'Bearer web', { response_mode: 'router' })).status, 200);
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members/ep_claude/remove`, 'Bearer web')).status, 200);
  });
});

test('agent controls: removing a human member stays manager-only', async () => {
  await withRoom(async ({ port, roomId, repository }) => {
    await addGuestWithAgent(repository, roomId);
    const member = await call(port, 'POST', `/v1/rooms/${roomId}/members/ep_mgr/remove`, 'Bearer alice');
    assert.deepEqual([member.status, member.body.code], [403, 'ROUTE_NOT_AUTHORIZED']);
    // A guest manager removes a human they do not own: humans are not agents.
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members/ep_alice/remove`, 'Bearer guest')).status, 200);
  });
});

// Task 14: guest-scoped stop. Stop cancels rows on agents the caller owns plus
// rows whose subject is the caller, and nothing else.
async function seedStopRows(repository, roomId) {
  const rows = [
    ['inv_op_on_claude', 'ep_claude', 'usr_chris', 'running'],
    ['inv_guest_on_claude', 'ep_claude', 'usr_guest', 'queued'],
    ['inv_guest_on_guest_agent', 'ep_guest_agent', 'usr_guest', 'running'],
    ['inv_op_on_guest_agent', 'ep_guest_agent', 'usr_chris', 'queued'],
  ];
  for (const [invocationId, endpointId, subjectHumanId, status] of rows) {
    await repository.createRoomInvocation({ invocationId, roomId, workspaceId: 'ws', triggerMessageId: `msg_${invocationId}`, threadRootId: 'msg_root', endpointId, decidedBy: 'mention', status, subjectHumanId });
  }
}
const statuses = async (repository, roomId) => Object.fromEntries((await repository.listRoomInvocations(roomId, { limit: 50 })).map((row) => [row.invocation_id, row.status]));

test('stop: a guest cancels what they started and their own agents, none of the operator-started work on operator agents', async () => {
  await withRoom(async ({ port, roomId, repository }) => {
    await addGuestWithAgent(repository, roomId, 'member');
    await seedStopRows(repository, roomId);
    const stopped = await call(port, 'POST', `/v1/rooms/${roomId}/stop`, 'Bearer guest', {});
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.equal(stopped.body.cancelled, 3);
    assert.deepEqual(await statuses(repository, roomId), {
      inv_op_on_claude: 'running', inv_guest_on_claude: 'cancelled', inv_guest_on_guest_agent: 'cancelled', inv_op_on_guest_agent: 'cancelled',
    });
  });
});

test('stop: the operator cancels everything on their agents plus anything they started', async () => {
  await withRoom(async ({ port, roomId, repository }) => {
    await addGuestWithAgent(repository, roomId, 'member');
    await seedStopRows(repository, roomId);
    const stopped = await call(port, 'POST', `/v1/rooms/${roomId}/stop`, 'Bearer web', {});
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.equal(stopped.body.cancelled, 3);
    assert.deepEqual(await statuses(repository, roomId), {
      inv_op_on_claude: 'cancelled', inv_guest_on_claude: 'cancelled', inv_guest_on_guest_agent: 'running', inv_op_on_guest_agent: 'cancelled',
    });
  });
});

// Task 14: operator-only room creation. The operator is resolved through the
// --room-human-identity endpoint's owner_id, so any endpoint of that human qualifies.
async function withBareServer(signer, fn) {
  const repository = createMemoryRepository({ registry });
  const server = createRelayServer({ registry, repository, humanSigner: signer, authenticate: async (request) => principals[request.headers.authorization] ?? null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(server.address().port, repository); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('create room: a non-operator endpoint gets 403; the operator and a second endpoint of the operator get 201', async () => {
  await withBareServer(humanSigner, async (port, repository) => {
    const guest = await call(port, 'POST', '/v1/rooms', 'Bearer guest', { name: 'guest-room' });
    assert.deepEqual([guest.status, guest.body.code], [403, 'ROUTE_NOT_AUTHORIZED']);
    assert.equal((await call(port, 'POST', '/v1/rooms', 'Bearer web', { name: 'operator-room' })).status, 201);
    const second = await call(port, 'POST', '/v1/rooms', 'Bearer alice', { name: 'second-endpoint-room' });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.deepEqual(await repository.listRoomsForEndpoint('ep_guest'), []);
  });
});

test('create room: the operator id comes from the identity endpoint row, not the signer field', async () => {
  await withBareServer({ endpointId: 'ep_web', ownerId: 'usr_guest' }, async (port) => {
    assert.equal((await call(port, 'POST', '/v1/rooms', 'Bearer guest', { name: 'g' })).status, 403);
    assert.equal((await call(port, 'POST', '/v1/rooms', 'Bearer alice', { name: 'a' })).status, 201);
  });
});

test('create room: without --room-human-identity nobody creates rooms (503 NO_OPERATOR_IDENTITY)', async () => {
  await withBareServer(null, async (port) => {
    const refused = await call(port, 'POST', '/v1/rooms', 'Bearer web', { name: 'no-operator' });
    assert.deepEqual([refused.status, refused.body.code], [503, 'NO_OPERATOR_IDENTITY']);
  });
});
