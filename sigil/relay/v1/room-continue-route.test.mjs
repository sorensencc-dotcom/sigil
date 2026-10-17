// Rooms phase 6: POST /v1/rooms/{room_id}/continue.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';
import { createRoomHumanSigner } from './room-human-signer.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createIdentity } from '../../cli/identity.mjs';
import { entryFromRegistryRow } from './trusted-endpoint.mjs';
const withKeys = (row) => ({ ...row, keys: entryFromRegistryRow(row).keys });

const NOW = new Date('2026-10-02T12:01:00.000Z');
const principals = {
  'Bearer web': { endpoint_id: 'ep_web', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer web2': { endpoint_id: 'ep_web2', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer claude': { endpoint_id: 'ep_claude', owner_id: 'usr_chris' },
  'Bearer web2nohuman': { endpoint_id: 'ep_web2', owner_id: 'usr_chris' },
  'Bearer stranger': { endpoint_id: 'ep_stranger', owner_id: 'usr_other', human_id: 'usr_other' },
};

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

async function withWorld(fn, { signer = true } = {}) {
  const human = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_web', kind: 'human' });
  const web2 = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_web2', kind: 'human' });
  const registry = new Map([
    ['ep_web', withKeys({ owner_id: 'usr_chris', status: 'active', kind: 'human', key_id: human.key_id, public_key: crypto.createPublicKey(human.public_key_pem) })],
    ['ep_web2', withKeys({ owner_id: 'usr_chris', status: 'active', kind: 'human', key_id: web2.key_id, public_key: crypto.createPublicKey(web2.public_key_pem) })],
    ['ep_claude', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
    ['ep_stranger', { owner_id: 'usr_other', status: 'active', kind: 'human' }],
    ['ep_theirs', { owner_id: 'usr_other', status: 'active', kind: 'agent' }],
  ]);
  const repository = createMemoryRepository({ registry });
  for (const id of ['room_1', 'room_2']) {
    await repository.createRoom({ conversationId: id, workspaceId: 'ws_usr_chris', name: id, createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
    await repository.addRoomMember({ conversationId: id, endpointId: 'ep_web2', role: 'member', responseMode: null, addedByHumanId: 'usr_chris', now: NOW });
    await repository.addRoomMember({ conversationId: id, endpointId: 'ep_claude', role: 'member', responseMode: 'mentions_only', addedByHumanId: 'usr_chris', now: NOW });
    await repository.addRoomMember({ conversationId: id, endpointId: 'ep_theirs', role: 'member', responseMode: 'mentions_only', addedByHumanId: 'usr_chris', now: NOW });
  }
  const systemIdentity = createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' });
  await repository.ensureRoomSystemEndpoint({ identity: systemIdentity, now: NOW });
  const stream = { notify() {}, notifyReceipt() {}, notifyRoom: () => true };
  const humanSigner = signer ? createRoomHumanSigner({ identity: human, repository }) : null;
  const server = createRelayServer({ registry, repository, stream, now: () => NOW, roomSystemIdentity: systemIdentity, ...(humanSigner ? { humanSigner } : {}), authenticate: async (request) => principals[request.headers.authorization] ?? null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn({ port: server.address().port, repository }); } finally { await new Promise((resolve) => server.close(resolve)); }
}


const cont = (w, room, body, auth = 'Bearer web') => call(w.port, 'POST', `/v1/rooms/${room}/continue`, auth, body);
let seq = 0;
const refuse = (w, endpointId, threadRootId, extra = {}) => w.repository.createRoomInvocation({
  invocationId: `inv_cap_${++seq}`, roomId: 'room_1', workspaceId: 'ws_usr_chris', triggerMessageId: `msg_cap_${seq}`, threadRootId,
  endpointId, decidedBy: 'mention', reason: 'hop_budget', status: 'refused', subjectHumanId: 'usr_chris', now: new Date(NOW.getTime() + 1000), ...extra,
});
const roomMessages = async (w) => (await w.repository.listRoomMessages('room_1', 0n, 100)).filter((m) => m.envelope.message_type === 'room.message');
async function root(w) {
  const res = await call(w.port, 'POST', '/v1/rooms/room_1/messages', 'Bearer web', { text: 'start', idempotency_key: `root${++seq}` });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.message_id;
}

test('a non-member gets 404 ROOM_NOT_FOUND', async () => {
  await withWorld(async (w) => {
    const res = await cont(w, 'room_1', { thread_root_id: 'msg_x', idempotency_key: 'c1' }, 'Bearer stranger');
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'ROOM_NOT_FOUND');
  });
});

test('an agent caller gets 403 HUMAN_CONTEXT_REQUIRED', async () => {
  await withWorld(async (w) => {
    const res = await cont(w, 'room_1', { thread_root_id: 'msg_x', idempotency_key: 'c1' }, 'Bearer claude');
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'HUMAN_CONTEXT_REQUIRED');
  });
});

test('no configured human signer answers 503 NO_OPERATOR_IDENTITY', async () => {
  await withWorld(async (w) => {
    const res = await cont(w, 'room_1', { thread_root_id: 'msg_x', idempotency_key: 'c1' });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'NO_OPERATOR_IDENTITY');
  }, { signer: false });
});

test('a missing thread_root_id or idempotency_key answers 400 INVALID_REQUEST', async () => {
  await withWorld(async (w) => {
    for (const body of [{ idempotency_key: 'c1' }, { thread_root_id: '', idempotency_key: 'c1' }, { thread_root_id: 7, idempotency_key: 'c1' }, { thread_root_id: 'msg_x' }, { thread_root_id: 'msg_x', idempotency_key: '' }]) {
      const res = await cont(w, 'room_1', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, 'INVALID_REQUEST');
    }
  });
});

test('409 NOTHING_TO_CONTINUE when nothing was refused for the hop budget', async () => {
  await withWorld(async (w) => {
    const threadId = await root(w);
    await refuse(w, 'ep_claude', threadId, { reason: 'not_allowed' });
    const res = await cont(w, 'room_1', { thread_root_id: threadId, idempotency_key: 'c1' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'NOTHING_TO_CONTINUE');
  });
});

test('409 NOTHING_TO_CONTINUE when the refusal predates the last reset', async () => {
  await withWorld(async (w) => {
    const threadId = await root(w);
    await refuse(w, 'ep_claude', threadId, { now: new Date('2026-10-02T12:00:00.000Z') });
    await w.repository.resetAgentTurns('room_1', threadId, { now: NOW });
    const res = await cont(w, 'room_1', { thread_root_id: threadId, idempotency_key: 'c1' });
    assert.equal(res.status, 409);
  });
});

test('success posts a signed human Continue. mentioning the refused agents and dispatches them', async () => {
  await withWorld(async (w) => {
    const threadId = await root(w);
    await refuse(w, 'ep_claude', threadId);
    const res = await cont(w, 'room_1', { thread_root_id: threadId, idempotency_key: 'c1' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { envelope } = await w.repository.lookupRoomMessage('room_1', res.body.message_id);
    assert.equal(envelope.message_type, 'room.message');
    assert.equal(envelope.sender.endpoint_id, 'ep_web');
    assert.equal(envelope.body.text, 'Continue.');
    assert.equal(envelope.body.thread_root_id, threadId);
    assert.deepEqual(envelope.body.mentions, ['ep_claude']);
    assert.equal(envelope.signature.algorithm, 'Ed25519');
    const running = await w.repository.lookupRunningInvocation('room_1', 'ep_claude');
    assert.equal(running?.subject_human_id, 'usr_chris', 'the refused agent runs under the caller');
    assert.equal(running.thread_root_id, threadId);
  });
});

test('mentions cap at 10 refused endpoints', async () => {
  await withWorld(async (w) => {
    const threadId = await root(w);
    for (let i = 0; i < 12; i += 1) await refuse(w, `ep_ghost${i}`, threadId, { now: new Date(NOW.getTime() + 1000 + i) });
    const res = await cont(w, 'room_1', { thread_root_id: threadId, idempotency_key: 'c1' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { envelope } = await w.repository.lookupRoomMessage('room_1', res.body.message_id);
    assert.equal(envelope.body.mentions.length, 10);
  });
});

test('an agent the caller may not invoke yields a visible invocation_refused event, not an error', async () => {
  await withWorld(async (w) => {
    const threadId = await root(w);
    await refuse(w, 'ep_theirs', threadId);
    const res = await cont(w, 'room_1', { thread_root_id: threadId, idempotency_key: 'c1' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const events = (await w.repository.listRoomMessages('room_1', 0n, 100)).filter((m) => m.envelope.message_type === 'room.event');
    const refused = events.find((e) => e.envelope.body.kind === 'invocation_refused' && e.envelope.body.endpoint_ids?.includes('ep_theirs'));
    assert.ok(refused, 'an invocation_refused event names the agent');
    assert.equal(await w.repository.lookupRunningInvocation('room_1', 'ep_theirs'), null);
  });
});

test('a replay of the same idempotency_key returns the first result and posts nothing more', async () => {
  await withWorld(async (w) => {
    const threadId = await root(w);
    await refuse(w, 'ep_claude', threadId);
    const first = await cont(w, 'room_1', { thread_root_id: threadId, idempotency_key: 'c1' });
    assert.equal(first.status, 201);
    const before = (await roomMessages(w)).length;
    const second = await cont(w, 'room_1', { thread_root_id: threadId, idempotency_key: 'c1' });
    assert.equal(second.status, 200);
    assert.equal(second.body.message_id, first.body.message_id);
    assert.equal((await roomMessages(w)).length, before);
  });
});

function spyResets(w) {
  const resets = [];
  const original = w.repository.resetAgentTurns.bind(w.repository);
  w.repository.resetAgentTurns = (...args) => { resets.push(args); return original(...args); };
  return resets;
}

test('refills the thread budget when the caller is the subject of every active invocation', async () => {
  await withWorld(async (w) => {
    const threadId = await root(w);
    await refuse(w, 'ep_claude', threadId);
    const resets = spyResets(w);
    const res = await cont(w, 'room_1', { thread_root_id: threadId, idempotency_key: 'c1' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(resets.filter(([room, thread]) => room === 'room_1' && thread === threadId).length, 1);
  });
});

test('does not refill when another human is the subject of an active invocation in the thread', async () => {
  await withWorld(async (w) => {
    const threadId = await root(w);
    await refuse(w, 'ep_claude', threadId);
    await w.repository.createRoomInvocation({ invocationId: 'inv_other', roomId: 'room_1', workspaceId: 'ws_usr_chris', triggerMessageId: 'msg_other', threadRootId: threadId, endpointId: 'ep_theirs', decidedBy: 'mention', status: 'running', subjectHumanId: 'usr_other', now: NOW });
    const resets = spyResets(w);
    const res = await cont(w, 'room_1', { thread_root_id: threadId, idempotency_key: 'c1' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(resets.length, 0);
  });
});

test('a caller with no human_id gets 403 HUMAN_CONTEXT_REQUIRED', async () => {
  await withWorld(async (w) => {
    const res = await cont(w, 'room_1', { thread_root_id: 'msg_x', idempotency_key: 'c1' }, 'Bearer web2nohuman');
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'HUMAN_CONTEXT_REQUIRED');
  });
});
