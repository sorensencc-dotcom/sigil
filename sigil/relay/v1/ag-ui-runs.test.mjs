import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';

const taskId = 'task_1';
const threadId = 'room_1';
const taskMessage = { room_seq: '1', envelope: { message_id: 'msg_task', conversation_id: threadId, message_type: 'task.request', sender: { endpoint_id: 'ep_human' }, body: { task_id: taskId, instruction: 'run' } } };
const resultMessage = { room_seq: '2', envelope: { message_id: 'msg_result', conversation_id: threadId, message_type: 'task.result', sender: { endpoint_id: 'ep_worker' }, body: { task_id: taskId, status: 'completed', summary: 'done' } } };

function makeServer(overrides = {}) {
  const history = overrides.history ?? [taskMessage];
  const repository = {
    async isConversationMember() { return true; },
    async lookupTaskRequest() { return { message_id: 'msg_task', recipientEndpointId: 'ep_worker' }; },
    async listRoomMessages(_room, afterSeq) { return history.filter((row) => BigInt(row.room_seq) > BigInt(afterSeq)); },
    ...(overrides.repository ?? {}),
  };
  const server = createRelayServer({
    registry: new Map(), repository, relayOrigin: 'https://relay.example',
    authenticate: overrides.authenticate ?? (async () => ({ endpoint_id: 'ep_human', owner_id: 'human_1', human_id: 'human_1' })),
    ...overrides.options,
  });
  return server;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, resolve));
  return server.address().port;
}

async function post(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, method: 'POST', path: '/v1/ag-ui/runs', headers: { 'content-type': 'application/json', authorization: 'Bearer test' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const input = (extra = {}) => ({ threadId, runId: 'run_1', protocolVersion: '1.0', forwardedProps: { sigil: { task_id: taskId } }, ...extra });

test('AG-UI runs reject unauthenticated clients and malformed input', async (t) => {
  const unauthenticated = makeServer({ authenticate: async () => null });
  const port = await listen(unauthenticated);
  t.after(() => { unauthenticated.closeAllConnections(); unauthenticated.close(); });
  assert.equal((await post(port, input())).status, 401);
  const authenticated = makeServer();
  const authenticatedPort = await listen(authenticated);
  t.after(() => { authenticated.closeAllConnections(); authenticated.close(); });
  assert.equal((await post(authenticatedPort, { threadId, runId: 'run_2' })).status, 400);
});

test('AG-UI runs reject foreign conversations', async (t) => {
  const server = makeServer({ repository: { async isConversationMember() { return false; } } });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await post(port, input());
  assert.equal(response.status, 403);
  assert.equal(JSON.parse(response.text).code, 'FOREIGN_CONVERSATION');
});

test('AG-UI runs reuse the browser origin allowlist for preflight', async (t) => {
  const server = makeServer({ options: { allowedOrigins: ['https://rooms.example'] } });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const preflight = (origin) => new Promise((resolve, reject) => {
    const req = http.request({ port, method: 'OPTIONS', path: '/v1/ag-ui/runs', headers: { origin, 'access-control-request-method': 'POST' } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal((await preflight('https://rooms.example')).status, 204);
  assert.equal((await preflight('https://attacker.example')).status, 403);
});

test('AG-UI runs stream a snapshot and exactly one terminal event for a completed task', async (t) => {
  const server = makeServer({ history: [taskMessage, resultMessage] });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await post(port, input());
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/event-stream/);
  const events = response.text.trim().split('\n\n').map((frame) => JSON.parse(frame.slice('data: '.length)));
  assert.equal(events[0].type, 'RUN_STARTED');
  assert.equal(events[1].type, 'MESSAGES_SNAPSHOT');
  assert.deepEqual(events.filter((event) => ['RUN_FINISHED', 'RUN_ERROR'].includes(event.type)).map((event) => event.type), ['RUN_FINISHED']);
  const duplicate = await post(port, input());
  assert.equal(duplicate.status, 409);
  assert.equal(JSON.parse(duplicate.text).code, 'RUN_ID_REUSED');
});

test('AG-UI runs project a bound approval challenge into one interrupt terminal event', async (t) => {
  const challenge = {
    id: 'challenge_1', actionHash: 'a'.repeat(64), expiresAt: '2026-12-01T00:00:00.000Z', capabilities: ['filesystem/write'],
    envelope: { message_id: 'msg_action', conversation_id: threadId, context_refs: ['msg_task'], capabilities: ['filesystem/write'], body: { path: '/tmp/a' } },
  };
  const server = makeServer({ repository: { async listApprovalChallengesForConversation() { return [challenge]; } } });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await post(port, input());
  const events = response.text.trim().split('\n\n').map((frame) => JSON.parse(frame.slice('data: '.length)));
  const terminal = events.filter((event) => ['RUN_FINISHED', 'RUN_ERROR'].includes(event.type));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].outcome.type, 'interrupt');
  assert.equal(terminal[0].outcome.interrupts[0].id, 'challenge_1');
  assert.equal(new URL(terminal[0].outcome.interrupts[0].metadata.sigil.approval_url).origin, 'https://relay.example');
});

test('disconnecting an AG-UI stream emits no synthetic terminal event', async (t) => {
  const server = makeServer();
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  let streamed = '';
  await new Promise((resolve, reject) => {
    const req = http.request({ port, method: 'POST', path: '/v1/ag-ui/runs', headers: { 'content-type': 'application/json', authorization: 'Bearer test' } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        streamed += chunk;
        if (streamed.includes('MESSAGES_SNAPSHOT')) { req.destroy(); resolve(); }
      });
      res.on('error', () => resolve());
    });
    req.on('error', () => resolve());
    req.end(JSON.stringify(input()));
    setTimeout(() => reject(new Error('SSE stream did not start')), 2000).unref();
  });
  const events = streamed.split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.slice('data: '.length)));
  assert.equal(events.some((event) => ['RUN_FINISHED', 'RUN_ERROR'].includes(event.type)), false);
});
