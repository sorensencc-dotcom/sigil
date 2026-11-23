import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import pg from 'pg';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { PostgresRepository } from './postgres-repository.mjs';
import { createRelayServer } from './http-server.mjs';
import { signedBytes } from './validate-envelope.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

function envelope({ id, conversationId, sender, recipient, messageType, body, contextRefs = [], capabilities = [] }) {
  const value = {
    protocol: 'sigil/1', message_id: id, conversation_id: conversationId, message_type: messageType,
    sender: { endpoint_id: sender.endpointId, owner_id: sender.ownerId },
    ...(recipient ? { recipient: { endpoint_id: recipient.endpointId } } : {}),
    ...(!recipient ? { broadcast_scope: { conversation_id: conversationId } } : {}), body, context_refs: contextRefs,
    capabilities, correlation_id: null, idempotency_key: `idem_${id}`,
    created_at: '2026-11-22T12:00:00.000Z', expires_at: '2026-11-22T13:00:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: sender.keyId, value: '' },
  };
  value.signature.value = crypto.sign(null, signedBytes(value), sender.keys.privateKey).toString('base64url');
  return value;
}

async function post(port, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ port, method: 'POST', path: '/v1/ag-ui/runs', headers: { 'content-type': 'application/json', authorization: 'Bearer test' } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

async function dropAfterSnapshot(port, body) {
  return new Promise((resolve, reject) => {
    let text = '';
    const request = http.request({ port, method: 'POST', path: '/v1/ag-ui/runs', headers: { 'content-type': 'application/json', authorization: 'Bearer test' } }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        text += chunk;
        if (text.includes('MESSAGES_SNAPSHOT')) {
          request.destroy();
          resolve(text);
        }
      });
      response.on('error', () => resolve(text));
    });
    request.on('error', () => { if (text.includes('MESSAGES_SNAPSHOT')) resolve(text); else reject(new Error('resume stream did not start')); });
    request.end(JSON.stringify(body));
    setTimeout(() => reject(new Error('resume stream did not start')), 3000).unref();
  });
}

test('AG-UI resumes after a dropped stream and concurrent Postgres clients replay one consumed action', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const repository = new PostgresRepository({ pool });
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = `usr_agui_${suffix}`;
  const conversationId = `room_agui_${suffix}`;
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [humanId]);
  const endpoints = {};
  for (const name of ['web', 'worker']) {
    const endpointId = `ep_${name}_${suffix}`;
    const keyId = `key_${name}_${suffix}`;
    const keys = crypto.generateKeyPairSync('ed25519');
    await pool.query(
      `INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $3, 'active', NOW())`,
      [endpointId, humanId, name, name === 'web' ? 'human' : 'agent', `install_${endpointId}`],
    );
    endpoints[name] = { endpointId, ownerId: humanId, keyId, keys };
  }
  await repository.registerHumanCredential({ humanId, endpointId: endpoints.web.endpointId, credentialId: `cred_${suffix}`, publicKey: 'test-public-key' });
  await repository.createRoom({ conversationId, workspaceId: `ws_${suffix}`, name: `agui_${suffix}`, createdByHumanId: humanId, ownerEndpointId: endpoints.web.endpointId });
  await repository.addRoomMember({ conversationId, endpointId: endpoints.worker.endpointId, role: 'member', addedByHumanId: humanId });

  const persistRoomMessage = (value, client) => repository.withTransaction(async (client) => {
    const streamSeq = await repository.assignStreamSequence(client, value.sender.endpoint_id, conversationId);
    const roomSeq = await repository.assignRoomSequence(client, conversationId);
    return repository.persistAcceptedEnvelope({
      envelope: value, canonical_bytes: signedBytes(value), canonical_hash: crypto.createHash('sha256').update(signedBytes(value)).digest('hex'),
      streamSeq, roomSeq, federation_hop: false, reportPost: false,
    }, client);
  }, client);

  const taskId = `task_${suffix}`;
  const taskMessage = envelope({
    id: `msg_task_${suffix}`, conversationId, sender: endpoints.web, recipient: endpoints.worker,
    messageType: 'task.request', body: { task_id: taskId, instruction: 'run' },
  });
  await persistRoomMessage(taskMessage);
  const action = envelope({
    id: `msg_action_${suffix}`, conversationId, sender: endpoints.worker,
    messageType: 'room.message', body: { task_id: taskId, text: 'accepted' }, contextRefs: [taskMessage.message_id], capabilities: ['filesystem/write'],
  });
  const actionHash = crypto.createHash('sha256').update(signedBytes(action)).digest('hex');
  const challengeId = `challenge_${suffix}`;
  let createChallengeOnNextPoll = true;
  const routeRepository = new Proxy(repository, {
    get(target, property) {
      if (property === 'listApprovalChallengesForConversation') return async (id) => {
        if (createChallengeOnNextPoll) {
          createChallengeOnNextPoll = false;
          await target.listApprovalChallengesForConversation(id);
          await target.createApprovalChallenge({
            id: challengeId, endpointId: endpoints.worker.endpointId, actionHash,
            webauthnChallenge: `webauthn_${suffix}`, callbackUrl: 'https://relay.example/callback', token: `token_${suffix}`,
            expiresAt: '2026-12-01T00:00:00.000Z', conversationId, messageId: action.message_id,
            capabilities: action.capabilities, envelope: action,
          });
          return [];
        }
        return target.listApprovalChallengesForConversation(id);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const server = createRelayServer({
    registry: new Map(), repository: routeRepository, relayOrigin: 'https://relay.example',
    authenticate: async () => ({ endpoint_id: endpoints.web.endpointId, owner_id: humanId, human_id: humanId }),
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const initial = await post(port, { threadId: conversationId, runId: 'run_initial', protocolVersion: '1.0', forwardedProps: { sigil: { task_id: taskId } } });
  const initialEvents = initial.text.trim().split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.slice('data: '.length)));
  assert.deepEqual(initialEvents.find((event) => event.type === 'RUN_FINISHED').outcome.interrupts.map((item) => item.id), [challengeId]);

  await repository.finalizeApprovalDecision({ challengeId, humanId, credentialId: `cred_${suffix}`, endpointId: endpoints.worker.endpointId });
  const resume = { threadId: conversationId, protocolVersion: '1.0', resume: [{ interruptId: challengeId, status: 'resolved' }] };
  await dropAfterSnapshot(port, { ...resume, runId: 'run_dropped' });

  await repository.withTransaction(async (client) => {
    const decision = await repository.consumeApprovalDecision({ endpointId: endpoints.worker.endpointId, actionHash, client });
    assert.equal(decision?.status, 'consumed');
    await persistRoomMessage(action, client);
  });
  const taskResult = envelope({
    id: `msg_result_${suffix}`, conversationId, sender: endpoints.worker,
    messageType: 'task.result', body: { task_id: taskId, status: 'completed', summary: 'done' }, contextRefs: [taskMessage.message_id],
  });
  await persistRoomMessage(taskResult);

  const [first, second] = await Promise.all([
    post(port, { ...resume, runId: 'run_retry_1' }),
    post(port, { ...resume, runId: 'run_retry_2' }),
  ]);
  for (const response of [first, second]) {
    assert.equal(response.status, 200);
    const events = response.text.trim().split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.slice('data: '.length)));
    assert.equal(events.filter((event) => event.type === 'TOOL_CALL_RESULT').length, 1);
    assert.equal(events.find((event) => event.name === 'sigil.receipt')?.value.receipt_id, action.message_id);
    assert.deepEqual(events.filter((event) => ['RUN_FINISHED', 'RUN_ERROR'].includes(event.type)).map((event) => event.type), ['RUN_FINISHED']);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM envelopes WHERE message_id = $1', [action.message_id])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT status FROM approval_decisions WHERE nonce = $1', [challengeId])).rows[0].status, 'consumed');
  assert.equal(await repository.consumeApprovalDecision({ endpointId: endpoints.worker.endpointId, actionHash }), null);
});
