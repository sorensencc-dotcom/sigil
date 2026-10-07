import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const principals = {
  'Bearer web': { endpoint_id: 'ep_web', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer claude': { endpoint_id: 'ep_claude', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer stranger': { endpoint_id: 'ep_stranger', owner_id: 'usr_other', human_id: 'usr_other' },
};
const registry = new Map([
  ['ep_web', { owner_id: 'usr_chris', status: 'active', kind: 'human' }],
  ['ep_claude', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
  ['ep_stranger', { owner_id: 'usr_other', status: 'active', kind: 'human' }],
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

async function withRoom(fn, { wrap } = {}) {
  const repository = createMemoryRepository({ registry });
  const frames = [];
  const stream = { notify() {}, notifyReceipt: (endpointId, frame) => frames.push({ endpointId, ...frame }) };
  const logged = [];
  const logger = { error: (...args) => logged.push(args), warn() {}, info() {} };
  await repository.createRoom({ conversationId: 'room_1', workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_chris', now: NOW });
  for (let n = 1; n <= 4; n += 1) {
    const messageId = `msg_${n}`;
    const envelope = {
      message_id: messageId, conversation_id: 'room_1', message_type: 'room.message',
      sender: { endpoint_id: 'ep_web', owner_id: 'usr_chris' }, broadcast_scope: { conversation_id: 'room_1' },
      body: { text: 'hi' }, idempotency_key: `idem_${n}`, created_at: NOW.toISOString(), expires_at: '2026-10-02T13:00:00.000Z',
    };
    await repository.persistAcceptedEnvelope({ envelope, message_id: messageId, canonical_hash: 'h', canonical_bytes: Buffer.from('b'), roomSeq: BigInt(n), roomFanout: ['ep_claude'] });
  }
  const effective = wrap ? wrap(repository) : repository;
  const server = createRelayServer({ registry, repository: effective, stream, logger, authenticate: async (request) => principals[request.headers.authorization] ?? null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(server.address().port, { frames, logged }); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('a member acks up to a sequence and each moved row sends a receipt frame to its sender', async () => {
  await withRoom(async (port, { frames }) => {
    const res = await call(port, 'POST', '/v1/rooms/room_1/ack', 'Bearer claude', { up_to_room_seq: 3 });
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.code, res.body.acknowledged], ['OK', 3]);
    assert.equal(frames.length, 3);
    assert.ok(frames.every((f) => f.endpointId === 'ep_web' && f.state === 'acknowledged' && f.recipient_endpoint_id === 'ep_claude'));
  });
});

test('a non-member and an unknown room both answer 404 ROOM_NOT_FOUND', async () => {
  await withRoom(async (port) => {
    for (const [auth, room] of [['Bearer stranger', 'room_1'], ['Bearer claude', 'room_nope']]) {
      const res = await call(port, 'POST', `/v1/rooms/${room}/ack`, auth, { up_to_room_seq: 1 });
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'ROOM_NOT_FOUND');
    }
  });
});

test('a missing, non-integer, negative, or oversized up_to_room_seq answers 400', async () => {
  await withRoom(async (port) => {
    for (const body of [{}, { up_to_room_seq: 1.5 }, { up_to_room_seq: 'abc' }, { up_to_room_seq: -1 }, { up_to_room_seq: '9223372036854775808' }]) {
      const res = await call(port, 'POST', '/v1/rooms/room_1/ack', 'Bearer claude', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, 'INVALID_REQUEST');
    }
  });
});

test('a second identical call acknowledges nothing and sends no frames', async () => {
  await withRoom(async (port, { frames }) => {
    await call(port, 'POST', '/v1/rooms/room_1/ack', 'Bearer claude', { up_to_room_seq: 4 });
    frames.length = 0;
    const res = await call(port, 'POST', '/v1/rooms/room_1/ack', 'Bearer claude', { up_to_room_seq: 4 });
    assert.equal(res.status, 200);
    assert.equal(res.body.acknowledged, 0);
    assert.equal(frames.length, 0);
  });
});

test('a failed sender lookup for one row still answers 200, logs, and frames the other rows', async () => {
  const wrap = (repository) => new Proxy(repository, {
    get(target, prop) {
      if (prop !== 'lookupMessageSender') return target[prop];
      return async (messageId) => { if (messageId === 'msg_2') throw new Error('lookup failed'); return target.lookupMessageSender(messageId); };
    },
  });
  await withRoom(async (port, { frames, logged }) => {
    const res = await call(port, 'POST', '/v1/rooms/room_1/ack', 'Bearer claude', { up_to_room_seq: 3 });
    assert.equal(res.status, 200);
    assert.equal(res.body.acknowledged, 3);
    assert.deepEqual(frames.map((f) => f.message_id).sort(), ['msg_1', 'msg_3']);
    assert.equal(logged.length, 1);
  }, { wrap });
});

test('a repository failure answers non-200 and sends no frame', async () => {
  const wrap = (repository) => new Proxy(repository, {
    get(target, prop) {
      if (prop === 'acknowledgeRoomDeliveries') return async () => { throw new Error('db down'); };
      return target[prop];
    },
  });
  await withRoom(async (port, { frames }) => {
    const res = await call(port, 'POST', '/v1/rooms/room_1/ack', 'Bearer claude', { up_to_room_seq: 3 });
    assert.notEqual(res.status, 200);
    assert.equal(frames.length, 0);
  }, { wrap });
});
