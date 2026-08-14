import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createConnectorServer } from './connector-server.mjs';

function request(port, token, { method, path, body } = {}) {
  return new Promise((resolve, reject) => { const req = http.request({ port, method, path, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => { let text = ''; res.on('data', (chunk) => text += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) })); }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined); });
}

test('connector server authenticates and exposes connector RPCs', async () => {
  const calls = []; const connector = { async sendTask(input) { calls.push(input); return { accepted: true }; }, async checkInbox() { return { items: [] }; }, async getResult(id) { return { id }; }, async requestApproval() { return { approved: false }; }, async resolveContext() { return { found: true }; }, async processDelivery(input) { return { state: 'processed', input }; }, async submitResult(input) { return { accepted: true, input }; } };
  const token = 'local-secret'; const app = createConnectorServer({ connector, token }); await app.listen(); const port = app.address().port;
  const denied = await request(port, 'wrong', { method: 'POST', path: '/v1/tasks', body: {} });
  const sent = await request(port, token, { method: 'POST', path: '/v1/tasks', body: { envelope: { message_id: 'm1' } } });
  const result = await request(port, token, { method: 'GET', path: '/v1/results?task_id=t1' }); await app.close();
  assert.equal(denied.status, 401); assert.equal(sent.status, 200); assert.deepEqual(calls, [{ envelope: { message_id: 'm1' } }]); assert.deepEqual(result.body.result, { id: 't1' });
  assert.equal(app.address(), null);
});

test('connector server dispatches Claude process and result operations', async () => {
  const connector = { async processDelivery(input) { return { state: 'processed', input }; }, async submitResult(input) { return { accepted: true, input }; } };
  const app = createConnectorServer({ connector, token: 'local-secret' }); await app.listen(); const port = app.address().port;
  const processed = await request(port, 'local-secret', { method: 'POST', path: '/v1/process', body: { deliveryId: 'd1', task: { message_id: 'm1' } } });
  const submitted = await request(port, 'local-secret', { method: 'POST', path: '/v1/results', body: { task_id: 't1', status: 'processed' } }); await app.close();
  assert.deepEqual(processed.body.result, { state: 'processed', input: { deliveryId: 'd1', task: { message_id: 'm1' } } });
  assert.deepEqual(submitted.body.result, { accepted: true, input: { task_id: 't1', status: 'processed' } });
});

test('connector server returns structured malformed JSON errors', async () => {
  const app = createConnectorServer({ connector: { async sendTask() {} }, token: 'local-secret' }); await app.listen(); const port = app.address().port;
  const result = await new Promise((resolve, reject) => { const req = http.request({ port, method: 'POST', path: '/v1/tasks', headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' } }, (res) => { let text = ''; res.on('data', (chunk) => text += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) })); }); req.on('error', reject); req.end('{bad'); }); await app.close();
  assert.equal(result.status, 400); assert.equal(result.body.code, 'INVALID_ENVELOPE');
});

test('connector server rejects oversized RPC bodies', async () => {
  const connector = { async sendTask() { throw new Error('must not dispatch'); } };
  const app = createConnectorServer({ connector, token: 'local-secret' }); await app.listen(); const port = app.address().port;
  const result = await request(port, 'local-secret', { method: 'POST', path: '/v1/tasks', body: { data: 'x'.repeat(1024 * 1024 + 1) } }); await app.close();
  assert.equal(result.status, 413); assert.equal(result.body.code, 'REQUEST_TOO_LARGE');
});
