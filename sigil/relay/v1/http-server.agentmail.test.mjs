import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayServer } from './http-server.mjs';

function request(port, path, body, { authorization } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(authorization ? { authorization } : {}) } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('AgentMail webhook route is opt-in and forwards raw body to the adapter', async () => {
  let captured;
  const server = createRelayServer({ registry: new Map(), agentmailIngress: { handle: async (input) => { captured = input; return { status: 202, body: { code: 'ACCEPTED', event_id: 'evt_1' } }; } } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await request(server.address().port, '/v1/agentmail/webhook/inbox_a', '{"synthetic":true}');
    assert.equal(result.status, 202);
    assert.equal(result.body.code, 'ACCEPTED');
    assert.equal(captured.inboxId, 'inbox_a');
    assert.equal(Buffer.isBuffer(captured.rawBody), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('AgentMail control route requires the existing authentication gate', async () => {
  const server = createRelayServer({ registry: new Map(), agentmailControl: { handle: async () => ({ state: 'disabled' }) } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { assert.equal((await request(server.address().port, '/v1/agentmail/control', JSON.stringify({ action: 'disable', requestId: 'req_1' }))).status, 404); }
  finally { await new Promise((resolve) => server.close(resolve)); }
});

test('authenticated AgentMail control calls do not accept or return secrets', async () => {
  let received;
  const server = createRelayServer({ registry: new Map(), authenticate: async () => ({ endpoint_id: 'ep_operator' }), agentmailControl: { handle: async (body, actor) => { received = { body, actor }; return { state: 'disabled', version: 2 }; } } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await request(server.address().port, '/v1/agentmail/control', JSON.stringify({ action: 'disable', requestId: 'req_1', reason: 'synthetic' }), { authorization: 'Bearer synthetic' });
    assert.equal(result.status, 200); assert.equal(received.actor.endpoint_id, 'ep_operator'); assert.equal(received.body.secret, undefined); assert.doesNotMatch(JSON.stringify(result.body), /synthetic-secret/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('AgentMail webhook route remains unavailable unless explicitly configured', async () => {
  const server = createRelayServer({ registry: new Map() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await request(server.address().port, '/v1/agentmail/webhook/inbox_a', '{}');
    assert.equal(result.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
