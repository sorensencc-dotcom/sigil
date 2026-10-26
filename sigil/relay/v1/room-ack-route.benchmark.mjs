import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const principals = {
  'Bearer claude': { endpoint_id: 'ep_claude', owner_id: 'usr_chris', human_id: 'usr_chris' },
};
const registry = new Map([
  ['ep_web', { owner_id: 'usr_chris', status: 'active', kind: 'human' }],
  ['ep_claude', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
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

async function withRoom(fn, numMessages) {
  const repository = createMemoryRepository({ registry });
  const frames = [];
  const stream = { notify() {}, notifyReceipt: (endpointId, frame) => frames.push({ endpointId, ...frame }) };
  const logged = [];
  const logger = { error: (...args) => logged.push(args), warn() {}, info() {} };
  await repository.createRoom({ conversationId: 'room_1', workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_chris', now: NOW });

  for (let n = 1; n <= numMessages; n += 1) {
    const messageId = `msg_${n}`;
    const envelope = {
      message_id: messageId, conversation_id: 'room_1', message_type: 'room.message',
      sender: { endpoint_id: 'ep_web', owner_id: 'usr_chris' }, broadcast_scope: { conversation_id: 'room_1' },
      body: { text: 'hi' }, idempotency_key: `idem_${n}`, created_at: NOW.toISOString(), expires_at: '2026-10-02T13:00:00.000Z',
    };
    await repository.persistAcceptedEnvelope({ envelope, message_id: messageId, canonical_hash: `h${n}`, canonical_bytes: Buffer.from('b'), roomSeq: BigInt(n), roomFanout: ['ep_claude'] });
  }

  // wrap repository to add some delay to sendReceiptFrame inner calls
  const effective = new Proxy(repository, {
    get(target, prop) {
      if (prop === 'lookupMessageSender') {
        return async (messageId) => {
          await new Promise(resolve => setTimeout(resolve, 5));
          return target.lookupMessageSender(messageId);
        };
      }
      return target[prop];
    }
  });

  const server = createRelayServer({ registry, repository: effective, stream, logger, authenticate: async (request) => principals[request.headers.authorization] ?? null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(server.address().port, { frames, logged }); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('benchmark acks up to a large sequence', async () => {
  const numMessages = 100;
  await withRoom(async (port, { frames }) => {
    const start = performance.now();
    const res = await call(port, 'POST', '/v1/rooms/room_1/ack', 'Bearer claude', { up_to_room_seq: numMessages });
    const end = performance.now();
    console.log(`Ack of ${numMessages} messages took ${(end - start).toFixed(2)} ms`);
    assert.equal(res.status, 200);
    assert.equal(frames.length, numMessages);
  }, numMessages);
});
