// Rooms phase 4a: POST /v1/rooms/{room_id}/messages (relay-signed human send).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';
import { createRoomHumanSigner } from './room-human-signer.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createIdentity } from '../../cli/identity.mjs';

const NOW = new Date('2026-10-02T12:01:00.000Z');
const principals = {
  'Bearer web': { endpoint_id: 'ep_web', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer web2': { endpoint_id: 'ep_web2', owner_id: 'usr_chris', human_id: 'usr_chris' },
  'Bearer claude': { endpoint_id: 'ep_claude', owner_id: 'usr_chris' },
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

async function withWorld(fn, { signer = true, spy = false } = {}) {
  const human = createIdentity({ ownerId: 'usr_chris', endpointId: 'ep_web', kind: 'human' });
  const registry = new Map([
    ['ep_web', { owner_id: 'usr_chris', status: 'active', kind: 'human', key_id: human.key_id, public_key: crypto.createPublicKey(human.public_key_pem) }],
    ['ep_web2', { owner_id: 'usr_chris', status: 'active', kind: 'human' }],
    ['ep_claude', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
    ['ep_stranger', { owner_id: 'usr_other', status: 'active', kind: 'human' }],
  ]);
  const repository = createMemoryRepository({ registry });
  for (const id of ['room_1', 'room_2']) {
    await repository.createRoom({ conversationId: id, workspaceId: 'ws_usr_chris', name: id, createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
    await repository.addRoomMember({ conversationId: id, endpointId: 'ep_web2', role: 'member', responseMode: null, addedByHumanId: 'usr_chris', now: NOW });
    await repository.addRoomMember({ conversationId: id, endpointId: 'ep_claude', role: 'member', responseMode: 'mentions_only', addedByHumanId: 'usr_chris', now: NOW });
  }
  const systemIdentity = createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' });
  await repository.ensureRoomSystemEndpoint({ identity: systemIdentity, now: NOW });
  const frames = [];
  const stream = { notify() {}, notifyReceipt() {}, notifyRoom: (id, frame) => { frames.push([id, frame]); return true; } };
  const calls = [];
  let humanSigner = signer ? createRoomHumanSigner({ identity: human, registry }) : null;
  if (humanSigner && spy) {
    const real = humanSigner;
    humanSigner = { ...real, signForEndpoint: (id) => { calls.push(id); return real.signForEndpoint(id); } };
  }
  const server = createRelayServer({ registry, repository, stream, now: () => NOW, roomSystemIdentity: systemIdentity, ...(humanSigner ? { humanSigner } : {}), authenticate: async (request) => principals[request.headers.authorization] ?? null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn({ port: server.address().port, repository, registry, frames, calls, human }); } finally { await new Promise((resolve) => server.close(resolve)); }
}

const send = (w, room, body, auth = 'Bearer web') => call(w.port, 'POST', `/v1/rooms/${room}/messages`, auth, body);

test('a human member posts a message the relay signs as the human endpoint', async () => {
  await withWorld(async (w) => {
    const res = await send(w, 'room_1', { text: 'hello', idempotency_key: 'k1' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.message_id);
    assert.equal(res.body.room_seq, '1');
    const history = await call(w.port, 'GET', '/v1/rooms/room_1/messages', 'Bearer web');
    assert.equal(history.status, 200);
    assert.ok(JSON.stringify(history.body).includes(res.body.message_id));
    const row = await w.repository.lookupRoomMessage('room_1', res.body.message_id);
    assert.equal(row.envelope.sender.endpoint_id, 'ep_web');
    const publicKey = w.registry.get('ep_web').public_key;
    assert.equal(crypto.verify(null, signedBytes(row.envelope), publicKey, Buffer.from(row.envelope.signature.value, 'base64url')), true);
    assert.equal(JSON.stringify(res.body).includes('PRIVATE'), false);
  });
});

test('the same idempotency_key answers 200 with the same message and stores one', async () => {
  await withWorld(async (w) => {
    const first = await send(w, 'room_1', { text: 'hello', idempotency_key: 'k1' });
    const again = await send(w, 'room_1', { text: 'hello', idempotency_key: 'k1' });
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.body.message_id, first.body.message_id);
    assert.equal(again.body.room_seq, first.body.room_seq);
    assert.equal((await w.repository.listRoomMessages('room_1')).filter((r) => r.envelope.message_type === 'room.message').length, 1);
  });
});

test('two concurrent posts with one new key store one message', async () => {
  await withWorld(async (w) => {
    const [a, b] = await Promise.all([send(w, 'room_1', { text: 'race', idempotency_key: 'kr' }), send(w, 'room_1', { text: 'race', idempotency_key: 'kr' })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201], JSON.stringify([a.body, b.body]));
    assert.equal(a.body.message_id, b.body.message_id);
    assert.equal((await w.repository.listRoomMessages('room_1')).length, 1);
  });
});

test('one idempotency_key in two rooms creates two messages', async () => {
  await withWorld(async (w) => {
    const a = await send(w, 'room_1', { text: 'hi', idempotency_key: 'same' });
    const b = await send(w, 'room_2', { text: 'hi', idempotency_key: 'same' });
    assert.deepEqual([a.status, b.status], [201, 201]);
    assert.notEqual(a.body.message_id, b.body.message_id);
  });
});

test('an invalid body answers 400 INVALID_ENVELOPE and a body sender cannot change the sender', async () => {
  await withWorld(async (w) => {
    for (const extra of [{ text: 'x', bogus: 1 }, { text: '' }, { text: 'x', thread_root_id: '' }, { text: 'x', thread_root_id: 5 }]) {
      const res = await send(w, 'room_1', { ...extra, idempotency_key: `k_${crypto.randomUUID()}` });
      assert.equal(res.status, 400, JSON.stringify(extra));
      assert.equal(res.body.code, 'INVALID_ENVELOPE');
    }
    const res = await send(w, 'room_1', { text: 'x', idempotency_key: 'ks', sender: { endpoint_id: 'ep_claude', owner_id: 'usr_other' } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await w.repository.lookupRoomMessage('room_1', res.body.message_id)).envelope.sender.endpoint_id, 'ep_web');
  });
});

test('a missing or oversized idempotency_key answers 400 INVALID_REQUEST', async () => {
  await withWorld(async (w) => {
    for (const key of [undefined, '', 'k'.repeat(129), 7]) {
      const res = await send(w, 'room_1', { text: 'x', ...(key === undefined ? {} : { idempotency_key: key }) });
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'INVALID_REQUEST');
    }
  });
});

test('a non-member gets 404 and an agent gets 403 HUMAN_CONTEXT_REQUIRED', async () => {
  await withWorld(async (w) => {
    const stranger = await send(w, 'room_1', { text: 'x', idempotency_key: 'k' }, 'Bearer stranger');
    assert.equal(stranger.status, 404);
    assert.equal(stranger.body.code, 'ROOM_NOT_FOUND');
    const agent = await send(w, 'room_1', { text: 'x', idempotency_key: 'k' }, 'Bearer claude');
    assert.equal(agent.status, 403);
    assert.equal(agent.body.code, 'HUMAN_CONTEXT_REQUIRED');
  });
});

test('a human endpoint that is not the loaded identity gets 403 and the signer is never called', async () => {
  await withWorld(async (w) => {
    const res = await send(w, 'room_1', { text: 'x', idempotency_key: 'k' }, 'Bearer web2');
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'NO_SIGNING_KEY');
    assert.deepEqual(w.calls, []);
  }, { spy: true });
});

test('no humanSigner answers 503', async () => {
  await withWorld(async (w) => {
    const res = await send(w, 'room_1', { text: 'x', idempotency_key: 'k' });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'ROOM_SEND_UNAVAILABLE');
  }, { signer: false });
});

test('a post sends one room.updated per human member and a rolled-back accept sends none', async () => {
  await withWorld(async (w) => {
    const res = await send(w, 'room_1', { text: 'x', idempotency_key: 'k1' });
    assert.equal(res.status, 201);
    assert.deepEqual(w.frames.map(([id]) => id).sort(), ['ep_web', 'ep_web2']);
    w.frames.length = 0;
    w.repository.resetAgentTurns = async () => { throw new Error('boom'); };
    const failed = await send(w, 'room_1', { text: 'y', idempotency_key: 'k2' });
    assert.notEqual(failed.status, 201);
    assert.equal(w.frames.length, 0);
  });
});

test('policy runs: a mention invokes the agent as for a CLI-posted message', async () => {
  await withWorld(async (w) => {
    const res = await send(w, 'room_1', { text: '@claude look', mentions: ['ep_claude'], idempotency_key: 'km' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const invocations = await w.repository.listRoomInvocations('room_1', { endpointId: 'ep_claude' });
    assert.equal(invocations.filter((i) => i.trigger_message_id === res.body.message_id).length, 1);
  });
});
