import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

const registry = new Map([
  ['ep_web', { owner_id: 'usr_chris', status: 'active', kind: 'human' }],
  ['ep_report', { owner_id: 'usr_chris', status: 'active', kind: 'agent' }],
  ['ep_human', { owner_id: 'usr_chris', status: 'active', kind: 'human' }],
]);
const principals = {
  'Bearer web': { endpoint_id: 'ep_web', owner_id: 'usr_chris', human_id: 'usr_chris' },
};

function call(port, method, path, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method, path, headers: { authorization: 'Bearer web', 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

async function withRoom(fn) {
  const repository = createMemoryRepository({ registry });
  const server = createRelayServer({ registry, repository, humanSigner: { endpointId: 'ep_web', ownerId: 'usr_chris' }, authenticate: async (request) => principals[request.headers.authorization] ?? null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const roomId = (await call(port, 'POST', '/v1/rooms', { name: 'reports' })).body.room.conversation_id;
    await fn({ port, roomId });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('add-member accepts report_only only for an agent and restores a removed member', async () => {
  await withRoom(async ({ port, roomId }) => {
    const added = await call(port, 'POST', `/v1/rooms/${roomId}/members`, { endpoint_id: 'ep_report', response_mode: 'report_only' });
    assert.equal(added.status, 201);
    assert.equal(added.body.member.response_mode, 'report_only');
    const human = await call(port, 'POST', `/v1/rooms/${roomId}/members`, { endpoint_id: 'ep_human', response_mode: 'report_only' });
    assert.equal(human.status, 400);
    assert.equal(human.body.code, 'INVALID_REQUEST');
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members/ep_report/remove`)).status, 200);
    const restored = await call(port, 'POST', `/v1/rooms/${roomId}/members`, { endpoint_id: 'ep_report', response_mode: 'mentions_only' });
    assert.equal(restored.status, 201);
    assert.equal(restored.body.member.response_mode, 'mentions_only');
  });
});

test('response-mode cannot set or clear report_only', async () => {
  await withRoom(async ({ port, roomId }) => {
    assert.equal((await call(port, 'POST', `/v1/rooms/${roomId}/members`, { endpoint_id: 'ep_report', response_mode: 'mentions_only' })).status, 201);
    const toReport = await call(port, 'POST', `/v1/rooms/${roomId}/members/ep_report/response-mode`, { response_mode: 'report_only' });
    assert.deepEqual([toReport.status, toReport.body.code], [409, 'RESPONSE_MODE_LOCKED']);
    await call(port, 'POST', `/v1/rooms/${roomId}/members/ep_report/remove`);
    await call(port, 'POST', `/v1/rooms/${roomId}/members`, { endpoint_id: 'ep_report', response_mode: 'report_only' });
    const fromReport = await call(port, 'POST', `/v1/rooms/${roomId}/members/ep_report/response-mode`, { response_mode: 'joins' });
    assert.deepEqual([fromReport.status, fromReport.body.code], [409, 'RESPONSE_MODE_LOCKED']);
  });
});
