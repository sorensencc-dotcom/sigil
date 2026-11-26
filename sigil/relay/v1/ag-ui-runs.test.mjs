import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelayServer } from './http-server.mjs';

const taskId = 'task_1';
const threadId = 'room_1';
const taskMessage = { room_seq: '1', envelope: { message_id: 'msg_task', conversation_id: threadId, message_type: 'task.request', sender: { endpoint_id: 'ep_human' }, body: { task_id: taskId, instruction: 'run' } } };
// Challenges expire a day after the test runs, so the fixtures never age out.
const challengeExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
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

async function dropPostAfterSnapshot(port, body) {
  return new Promise((resolve, reject) => {
    let streamed = '';
    const request = http.request({ port, method: 'POST', path: '/v1/ag-ui/runs', headers: { 'content-type': 'application/json', authorization: 'Bearer test' } }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        streamed += chunk;
        if (streamed.includes('MESSAGES_SNAPSHOT')) {
          request.destroy();
          resolve(streamed);
        }
      });
      response.on('error', () => resolve(streamed));
    });
    request.on('error', () => { if (streamed.includes('MESSAGES_SNAPSHOT')) resolve(streamed); else reject(new Error('AG-UI resume stream did not start')); });
    request.end(JSON.stringify(body));
    setTimeout(() => reject(new Error('AG-UI resume stream did not start')), 2000).unref();
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
    id: 'challenge_1', actionHash: 'a'.repeat(64), expiresAt: challengeExpiresAt, capabilities: ['filesystem/write'], status: 'pending', decisionStatus: null,
    envelope: { message_id: 'msg_action', conversation_id: threadId, context_refs: ['msg_task'], capabilities: ['filesystem/write'], body: { path: '/tmp/a' } },
  };
  let challengeReads = 0;
  const server = makeServer({ repository: { async listApprovalChallengesForConversation() { challengeReads += 1; return challengeReads === 1 ? [] : [challenge]; } } });
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

test('AG-UI resume covers multiple interrupts, refuses pending and partial resumes, and replays concurrent retries', async (t) => {
  const challenges = ['challenge_1', 'challenge_2'].map((id, index) => ({
    id, endpointId: 'ep_worker', actionHash: 'a'.repeat(64), expiresAt: challengeExpiresAt,
    capabilities: ['filesystem/write'], status: 'pending', decisionStatus: null,
    envelope: { message_id: `msg_action_${index + 1}`, conversation_id: threadId, context_refs: ['msg_task'], capabilities: ['filesystem/write'], body: { task_id: taskId, path: `/tmp/${index + 1}` } },
  }));
  let challengeReads = 0;
  let history = [taskMessage];
  const server = makeServer({ repository: {
    async listApprovalChallengesForConversation() { challengeReads += 1; return challengeReads === 1 ? [] : challenges; },
    async listRoomMessages(_room, afterSeq) { return history.filter((row) => BigInt(row.room_seq) > BigInt(afterSeq)); },
  } });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });

  const first = await post(port, input());
  const firstEvents = first.text.trim().split('\n\n').map((frame) => JSON.parse(frame.slice('data: '.length)));
  const interrupt = firstEvents.find((event) => event.type === 'RUN_FINISHED').outcome.interrupts;
  assert.deepEqual(interrupt.map((item) => item.id), ['challenge_1', 'challenge_2']);
  const entries = interrupt.map(({ id }) => ({ interruptId: id, status: 'resolved' }));
  const resume = (runId, resumeEntries = entries) => ({ threadId, runId, protocolVersion: '1.0', resume: resumeEntries });

  const partial = await post(port, resume('run_partial', entries.slice(0, 1)));
  assert.equal(partial.status, 200);
  assert.equal(JSON.parse(partial.text.split('\n\n').filter(Boolean).at(-1).slice('data: '.length)).code, 'INTERRUPT_COVERAGE');
  assert.equal((await post(port, input({ runId: 'run_without_resume' }))).status, 409);

  const pending = await post(port, resume('run_pending'));
  assert.equal(pending.status, 409);
  assert.equal(JSON.parse(pending.text).code, 'INTERRUPT_PENDING');

  challenges.forEach((challenge) => { challenge.status = 'consumed'; challenge.decisionStatus = 'approved'; });
  await dropPostAfterSnapshot(port, resume('run_dropped'));
  challenges.forEach((challenge) => { challenge.decisionStatus = 'consumed'; });
  const actionRows = challenges.map((challenge, index) => ({
    room_seq: String(index + 2), stream_seq: String(index + 12),
    envelope: {
      message_id: challenge.envelope.message_id, conversation_id: threadId, message_type: 'room.message',
      sender: { endpoint_id: 'ep_worker' }, body: { text: `accepted ${index + 1}` },
      signature: { value: `signed-${index + 1}` },
    },
  }));
  history = [taskMessage, ...actionRows, { ...resultMessage, room_seq: '4' }];
  const [retry1, retry2] = await Promise.all([post(port, resume('run_retry_1')), post(port, resume('run_retry_2'))]);
  for (const response of [retry1, retry2]) {
    assert.equal(response.status, 200);
    const events = response.text.trim().split('\n\n').map((frame) => JSON.parse(frame.slice('data: '.length)));
    assert.equal(events.filter((event) => event.type === 'TOOL_CALL_RESULT').length, 2);
    assert.deepEqual(events.filter((event) => event.name === 'sigil.receipt').map((event) => event.value.receipt_id), ['msg_action_1', 'msg_action_2']);
    assert.deepEqual(events.filter((event) => ['RUN_FINISHED', 'RUN_ERROR'].includes(event.type)).map((event) => event.type), ['RUN_FINISHED']);
  }
});

test('AG-UI cancellation calls the repository and reports the cancelled interrupt', async (t) => {
  const challenge = {
    id: 'challenge_cancel', endpointId: 'ep_worker', actionHash: 'a'.repeat(64), expiresAt: challengeExpiresAt,
    capabilities: ['filesystem/write'], status: 'pending', decisionStatus: null,
    envelope: { message_id: 'msg_action', conversation_id: threadId, context_refs: ['msg_task'], capabilities: ['filesystem/write'], body: { task_id: taskId, path: '/tmp/a' } },
  };
  let reads = 0;
  const cancelled = [];
  const server = makeServer({ repository: {
    async listApprovalChallengesForConversation() { reads += 1; return reads === 1 ? [] : [challenge]; },
    async cancelApprovalChallenge(args) { cancelled.push(args); challenge.status = 'cancelled'; return { status: 'cancelled' }; },
  } });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await post(port, input());
  const response = await post(port, { threadId, runId: 'run_cancel', protocolVersion: '1.0', resume: [{ interruptId: challenge.id, status: 'cancelled' }] });
  const events = response.text.trim().split('\n\n').map((frame) => JSON.parse(frame.slice('data: '.length)));
  assert.deepEqual(cancelled.map(({ challengeId, endpointId }) => [challengeId, endpointId]), [[challenge.id, 'ep_worker']]);
  assert.deepEqual(events.filter((event) => ['RUN_FINISHED', 'RUN_ERROR'].includes(event.type)).map((event) => [event.type, event.code]), [['RUN_ERROR', 'APPROVAL_CANCELLED']]);
});

test('AG-UI resume ends with APPROVAL_EXPIRED when an approved decision expires before the envelope arrives', async (t) => {
  let clockMs = Date.parse('2030-01-01T00:00:00.000Z');
  const expiresAt = new Date(clockMs + 60_000).toISOString();
  const challenge = {
    id: 'challenge_wait', endpointId: 'ep_worker', actionHash: 'a'.repeat(64), expiresAt,
    capabilities: ['filesystem/write'], status: 'pending', decisionStatus: null,
    envelope: { message_id: 'msg_action', conversation_id: threadId, context_refs: ['msg_task'], capabilities: ['filesystem/write'], body: { task_id: taskId, path: '/tmp/a' } },
  };
  let reads = 0;
  const server = makeServer({
    repository: { async listApprovalChallengesForConversation() { reads += 1; return reads === 1 ? [] : [challenge]; } },
    options: { now: () => new Date(clockMs) },
  });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await post(port, input());

  Object.assign(challenge, { status: 'consumed', decisionStatus: 'approved', decisionExpiresAt: expiresAt });
  setTimeout(() => { clockMs += 120_000; }, 100).unref();
  const response = await post(port, { threadId, runId: 'run_wait', protocolVersion: '1.0', resume: [{ interruptId: challenge.id, status: 'resolved' }] });
  assert.equal(response.status, 200);
  const events = response.text.trim().split('\n\n').map((frame) => JSON.parse(frame.slice('data: '.length)));
  assert.deepEqual(events.filter((event) => ['RUN_FINISHED', 'RUN_ERROR'].includes(event.type)).map((event) => [event.type, event.code]), [['RUN_ERROR', 'APPROVAL_EXPIRED']]);
});

test('AG-UI starts a new run once the last interrupted run has no open interrupt left', async (t) => {
  let clockMs = Date.parse('2030-01-01T00:00:00.000Z');
  const challenge = {
    id: 'challenge_stale', endpointId: 'ep_worker', actionHash: 'a'.repeat(64), expiresAt: new Date(clockMs + 60_000).toISOString(),
    capabilities: ['filesystem/write'], status: 'pending', decisionStatus: null,
    envelope: { message_id: 'msg_action', conversation_id: threadId, context_refs: ['msg_task'], capabilities: ['filesystem/write'], body: { task_id: taskId, path: '/tmp/a' } },
  };
  let reads = 0;
  let history = [taskMessage];
  const server = makeServer({
    repository: {
      async listApprovalChallengesForConversation() { reads += 1; return reads === 1 ? [] : [challenge]; },
      async listRoomMessages(_room, afterSeq) { return history.filter((row) => BigInt(row.room_seq) > BigInt(afterSeq)); },
    },
    options: { now: () => new Date(clockMs) },
  });
  const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await post(port, input());
  const blocked = await post(port, input({ runId: 'run_blocked' }));
  assert.equal(blocked.status, 409);
  assert.equal(JSON.parse(blocked.text).code, 'INTERRUPT_PENDING');

  clockMs += 120_000;
  history = [taskMessage, resultMessage];
  const response = await post(port, input({ runId: 'run_after_expiry' }));
  assert.equal(response.status, 200);
  const events = response.text.trim().split('\n\n').map((frame) => JSON.parse(frame.slice('data: '.length)));
  assert.deepEqual(events.filter((event) => ['RUN_FINISHED', 'RUN_ERROR'].includes(event.type)).map((event) => event.type), ['RUN_FINISHED']);
});
