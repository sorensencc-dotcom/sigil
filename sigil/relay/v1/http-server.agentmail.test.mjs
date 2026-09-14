import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayServer } from './http-server.mjs';

function request(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
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
