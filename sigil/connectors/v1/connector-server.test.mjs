import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createConnectorServer } from './connector-server.mjs';
import crypto from 'node:crypto';
import { canonicalManifest } from './plugin-manifest.mjs';

function request(port, token, { method, path, body, headers = {}, metadata = true } = {}) {
  const contractHeaders = metadata ? { 'x-sigil-request-id': 'request-1234', 'x-sigil-contract': 'sigil.connector/v1', 'x-sigil-caller': 'test-host', 'x-sigil-capability-scope': 'sigil.task/*' } : {};
  return new Promise((resolve, reject) => { const req = http.request({ port, method, path, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...contractHeaders, ...headers } }, (res) => { let text = ''; res.on('data', (chunk) => text += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) })); }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined); });
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

test('connector server replays idempotent result and rejects conflicting reuse', async () => {
  let calls = 0;
  const app = createConnectorServer({ connector: { async sendTask(input) { calls += 1; return { accepted: input.value }; } }, token: 'local-secret' }); await app.listen(); const port = app.address().port;
  const first = await request(port, 'local-secret', { method: 'POST', path: '/v1/tasks', body: { value: 'a' }, headers: { 'x-sigil-idempotency-key': 'k1' } });
  const replay = await request(port, 'local-secret', { method: 'POST', path: '/v1/tasks', body: { value: 'a' }, headers: { 'x-sigil-idempotency-key': 'k1' } });
  const second = await request(port, 'local-secret', { method: 'POST', path: '/v1/tasks', body: { value: 'b' }, headers: { 'x-sigil-idempotency-key': 'k1' } }); await app.close();
  assert.equal(first.status, 200); assert.equal(replay.status, 200); assert.equal(second.status, 409); assert.equal(calls, 1);
});

test('connector server rejects missing or downgraded contract metadata', async () => {
  const app = createConnectorServer({ connector: { async sendTask() { throw new Error('must not dispatch'); } }, token: 'local-secret' }); await app.listen(); const port = app.address().port;
  const missing = await request(port, 'local-secret', { method: 'POST', path: '/v1/tasks', body: {}, metadata: false });
  const downgraded = await request(port, 'local-secret', { method: 'POST', path: '/v1/tasks', body: {}, headers: { 'x-sigil-contract': 'sigil.connector/v0' } }); await app.close();
  assert.equal(missing.status, 400); assert.equal(missing.body.code, 'INVALID_REQUEST_ID');
  assert.equal(downgraded.status, 426); assert.equal(downgraded.body.code, 'VERSION_UNSUPPORTED');
});

test('connector server applies rate and in-flight capacity limits', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const app = createConnectorServer({ connector: { async sendTask() { await blocked; return { accepted: true }; } }, token: 'local-secret', maxInFlight: 1, maxRequestsPerWindow: 1, rateWindowMs: 60_000 }); await app.listen(); const port = app.address().port;
  const first = request(port, 'local-secret', { method: 'POST', path: '/v1/tasks', body: {}, headers: { 'x-sigil-request-id': 'request-first' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const capacity = await request(port, 'local-secret', { method: 'POST', path: '/v1/tasks', body: {}, headers: { 'x-sigil-request-id': 'request-second' } });
  release(); await first; const limited = await request(port, 'local-secret', { method: 'POST', path: '/v1/tasks', body: {}, headers: { 'x-sigil-request-id': 'request-third' } }); await app.close();
  assert.equal(capacity.status, 503); assert.equal(capacity.body.code, 'BACKPRESSURE'); assert.equal(limited.status, 429); assert.equal(limited.body.code, 'RATE_LIMITED');
});

test('connector server enforces verified package identity and caller allow-list', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const manifest = { package_id: 'sigil.codex.connector', contract: 'sigil.connector/v1', host: 'codex', permissions: ['sigil.task/*'], executable_digest: 'a'.repeat(64), publisher_key_id: 'publisher-1' };
  manifest.signature = crypto.sign(null, Buffer.from(canonicalManifest(manifest)), privateKey).toString('base64url');
  const app = createConnectorServer({ connector: { async sendTask() { return { accepted: true }; } }, token: 'local-secret', manifest, publisherKeys: new Map([['publisher-1', publicKey]]), allowedCallers: ['codex-host'] }); await app.listen(); const port = app.address().port;
  const deniedCaller = await request(port, 'local-secret', { method: 'POST', path: '/v1/tasks', body: {}, headers: { 'x-sigil-caller': 'other-host', 'x-sigil-package-id': manifest.package_id } });
  const deniedPackage = await request(port, 'local-secret', { method: 'POST', path: '/v1/tasks', body: {}, headers: { 'x-sigil-caller': 'codex-host', 'x-sigil-package-id': 'sigil.claude.connector' } });
  const allowed = await request(port, 'local-secret', { method: 'POST', path: '/v1/tasks', body: {}, headers: { 'x-sigil-caller': 'codex-host', 'x-sigil-package-id': manifest.package_id } }); await app.close();
  assert.equal(deniedCaller.status, 403); assert.equal(deniedCaller.body.code, 'CALLER_NOT_ALLOWED'); assert.equal(deniedPackage.status, 403); assert.equal(deniedPackage.body.code, 'PACKAGE_ID_MISMATCH'); assert.equal(allowed.status, 200);
});
