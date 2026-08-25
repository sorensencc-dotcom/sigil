import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { signedBytes } from './validate-envelope.mjs';
import { createRelayServer } from './http-server.mjs';
import { hashBearerToken } from './transport-auth.mjs';
import { parseAttestationObject } from './approval-ceremony.mjs';

function cborInt(value) { return value >= 0 ? Buffer.from([value]) : Buffer.from([0x20 + (-1 - value)]); }
function cborMap(entries) { return Buffer.concat([Buffer.from([0xa0 + entries.length]), ...entries.flatMap(([key, value]) => [typeof key === 'string' ? Buffer.concat([Buffer.from([0x60 + key.length]), Buffer.from(key)]) : cborInt(key), value])]); }
function cborBytes(value) { return Buffer.concat([Buffer.from([0x58, value.length]), value]); }

test('relay clock function is evaluated for each request', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  envelope.created_at = '2026-08-19T15:00:00.000Z'; envelope.expires_at = '2026-08-19T16:00:00.000Z';
  envelope.sender.endpoint_id = 'ep_codex'; envelope.sender.owner_id = 'usr_codex_owner'; envelope.sender.key_id = 'key_01JEXAMPLE'; envelope.recipient = { endpoint_id: 'ep_codex', owner_id: 'usr_codex_owner' };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  const repository = {
    async withTransaction(fn) { return fn(null); }, async lookupIdempotency() { return null; },
    async lookupAcceptedMessageId() { return null; }, async lookupCapabilityRegistration(capability) { return { capability, namespace: capability.split('/')[0], risk_tier: 'standard' }; },
    async lookupActiveCapabilityGrants() { return []; }, async reserveRateLimit() { return { count: 1, allowed: true }; },
    async countOpenDeliveries() { return 0; }, async persistAcceptedEnvelope(row) { return { message_id: row.envelope.message_id }; },
  };
  let calls = 0;
  const server = createRelayServer({
    registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]),
    repository, now: () => (++calls === 1 ? new Date('2026-08-18T15:00:00.000Z') : new Date('2026-08-19T15:00:01.000Z')),
  });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const first = await request(port, { method: 'POST', path: '/v1/envelopes', body: envelope });
  const second = await request(port, { method: 'POST', path: '/v1/envelopes', body: envelope });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(first.status, 400);
  assert.equal(first.body.code, 'INVALID_ENVELOPE');
  assert.match(first.body.message, /clock-skew tolerance/);
  assert.equal(second.status, 202);
  assert.equal(calls, 2);
});
test('GET /v1/health returns 200 with status ok and requires no authentication', async () => {
  const server = createRelayServer({ registry: new Map(), tokenHashes: new Map([['nonexistent', 'ep_someone']]) });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const result = await request(port, { method: 'GET', path: '/v1/health' });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { status: 'ok' });
});

test('HTTP relay accepts signed envelope and returns request ID', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  envelope.created_at = '2026-08-13T12:00:00.000Z'; envelope.expires_at = '2026-08-14T00:00:00.000Z';
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  const server = createRelayServer({ registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]), persist: () => {}, now: new Date('2026-08-13T12:01:00Z') });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const result = await new Promise((resolve, reject) => {
    const request = http.request({ port, method: 'POST', path: '/v1/envelopes', headers: { 'content-type': 'application/json', 'x-sigil-request-id': 'req_http_1' } }, (response) => { let body = ''; response.on('data', (chunk) => body += chunk); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(body) })); });
    request.on('error', reject); request.end(JSON.stringify(envelope));
  });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 202); assert.equal(result.body.request_id, 'req_http_1');
});

test('HTTP relay defaults to repository persistence with canonical acceptance data', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  envelope.created_at = '2026-08-13T12:00:00.000Z'; envelope.expires_at = '2026-08-14T00:00:00.000Z';
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  const persisted = [];
  const repository = {
    async withTransaction(fn) { return fn(null); },
    async lookupIdempotency() { return null; },
    async lookupAcceptedMessageId() { return null; },
    async lookupCapabilityRegistration(capability) { return { capability, namespace: capability.split('/')[0], risk_tier: 'standard' }; },
    async lookupActiveCapabilityGrants() { return []; },
    async reserveRateLimit() { return { count: 1, allowed: true }; },
    async countOpenDeliveries() { return 0; },
    async persistAcceptedEnvelope(row) { persisted.push(row); return { message_id: row.envelope.message_id }; }
  };
  const server = createRelayServer({
    registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]),
    repository, now: new Date('2026-08-13T12:01:00Z')
  });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/envelopes', body: envelope });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 202);
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0].canonical_bytes, signedBytes(envelope));
  assert.equal(persisted[0].action_hash, persisted[0].canonical_hash);
});

test('HTTP relay does not notify when durable persistence fails', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  envelope.created_at = '2026-08-13T12:00:00.000Z'; envelope.expires_at = '2026-08-14T00:00:00.000Z';
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  const notifications = [];
  const server = createRelayServer({
    registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]),
    repository: { async withTransaction(fn) { return fn(null); }, async lookupIdempotency() { return null; }, async lookupAcceptedMessageId() { return null; }, async lookupCapabilityRegistration(capability) { return { capability, namespace: capability.split('/')[0], risk_tier: 'standard' }; }, async lookupActiveCapabilityGrants() { return []; }, async reserveRateLimit() { return { count: 1, allowed: true }; }, async countOpenDeliveries() { return 0; }, async persistAcceptedEnvelope() { throw new Error('database unavailable'); } },
    stream: { notify(...args) { notifications.push(args); } }, now: new Date('2026-08-13T12:01:00Z')
  });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/envelopes', body: envelope });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 400);
  assert.equal(result.body.message, 'database unavailable');
  assert.deepEqual(notifications, []);
});

test('HTTP relay returns prior acceptance for duplicate idempotency retry', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  envelope.created_at = '2026-08-13T12:00:00.000Z'; envelope.expires_at = '2026-08-14T00:00:00.000Z';
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  const persisted = []; const notifications = []; const canonicalHash = crypto.createHash('sha256').update(signedBytes(envelope)).digest('hex');
  const repository = {
    async withTransaction(fn) { return fn(null); },
    async lookupIdempotency() { return persisted.length ? { message_id: envelope.message_id, canonical_hash: canonicalHash } : null; },
    async lookupAcceptedMessageId() { return null; },
    async lookupCapabilityRegistration(capability) { return { capability, namespace: capability.split('/')[0], risk_tier: 'standard' }; },
    async lookupActiveCapabilityGrants() { return []; },
    async reserveRateLimit() { return { count: 1, allowed: true }; },
    async countOpenDeliveries() { return 0; },
    async persistAcceptedEnvelope(row) { persisted.push(row); return { message_id: row.envelope.message_id }; }
  };
  const server = createRelayServer({
    registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]),
    repository, stream: { notify(...args) { notifications.push(args); } }, now: new Date('2026-08-13T12:01:00Z')
  });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const first = await request(port, { method: 'POST', path: '/v1/envelopes', body: envelope });
  const second = await request(port, { method: 'POST', path: '/v1/envelopes', body: envelope });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(first.status, 202); assert.equal(first.body.duplicate, false);
  assert.equal(second.status, 202); assert.equal(second.body.duplicate, true);
  assert.equal(second.body.message_id, first.body.message_id);
  assert.equal(persisted.length, 1); assert.equal(notifications.length, 1);
});

test('HTTP relay rejects conflicting idempotency retry', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  envelope.created_at = '2026-08-13T12:00:00.000Z'; envelope.expires_at = '2026-08-14T00:00:00.000Z';
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  const originalHash = crypto.createHash('sha256').update(signedBytes(envelope)).digest('hex');
  const repository = {
    async withTransaction(fn) { return fn(null); },
    async lookupIdempotency() { return { message_id: envelope.message_id, canonical_hash: originalHash }; },
    async lookupAcceptedMessageId() { return null; },
    async lookupCapabilityRegistration(capability) { return { capability, namespace: capability.split('/')[0], risk_tier: 'standard' }; },
    async lookupActiveCapabilityGrants() { return []; },
    async reserveRateLimit() { return { count: 1, allowed: true }; },
    async countOpenDeliveries() { return 0; },
    async persistAcceptedEnvelope() { throw new Error('must not persist conflicting retry'); }
  };
  const server = createRelayServer({
    registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]),
    repository, now: new Date('2026-08-13T12:01:00Z')
  });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const retry = { ...envelope, body: { ...envelope.body, changed: true } };
  retry.signature = { ...retry.signature, value: crypto.sign(null, signedBytes(retry), privateKey).toString('base64url') };
  const result = await request(port, { method: 'POST', path: '/v1/envelopes', body: retry });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 409); assert.equal(result.body.code, 'DUPLICATE_MESSAGE');
});

test('HTTP relay notifies recipient stream after acceptance', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  envelope.created_at = '2026-08-13T12:00:00.000Z'; envelope.expires_at = '2026-08-14T00:00:00.000Z'; envelope.recipient.endpoint_id = 'ep_claude'; envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  const notifications = []; const stream = { notify: (endpointId, messageId) => { notifications.push({ endpointId, messageId }); return true; } };
  const repository = {
    async withTransaction(fn) { return fn(null); },
    async lookupIdempotency() { return null; },
    async lookupAcceptedMessageId() { return null; },
    async lookupCapabilityRegistration(capability) { return { capability, namespace: capability.split('/')[0], risk_tier: 'standard' }; },
    async lookupActiveCapabilityGrants() { return []; },
    async reserveRateLimit() { return { count: 1, allowed: true }; },
    async countOpenDeliveries() { return 0; },
    async persistAcceptedEnvelope(row) { return { message_id: row.envelope.message_id, duplicate: false }; }
  };
  const server = createRelayServer({ registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]), repository, stream, now: new Date('2026-08-13T12:01:00Z') });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  await new Promise((resolve, reject) => { const request = http.request({ port, method: 'POST', path: '/v1/envelopes' }, (response) => { response.resume(); response.on('end', resolve); }); request.on('error', reject); request.end(JSON.stringify(envelope)); });
  await new Promise((resolve) => server.close(resolve));
  assert.deepEqual(notifications, [{ endpointId: 'ep_claude', messageId: 'msg_01JEXAMPLE' }]);
});

test('HTTP relay pushes the sender a delivered receipt via stream.notifyReceipt at accept time', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  envelope.created_at = '2026-08-13T12:00:00.000Z'; envelope.expires_at = '2026-08-14T00:00:00.000Z'; envelope.recipient.endpoint_id = 'ep_claude'; envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  const receipts = [];
  const stream = { notify() { return true; }, notifyReceipt: (endpointId, receipt) => { receipts.push({ endpointId, receipt }); return true; } };
  const repository = {
    async withTransaction(fn) { return fn(null); },
    async lookupIdempotency() { return null; },
    async lookupAcceptedMessageId() { return null; },
    async lookupCapabilityRegistration(capability) { return { capability, namespace: capability.split('/')[0], risk_tier: 'standard' }; },
    async lookupActiveCapabilityGrants() { return []; },
    async reserveRateLimit() { return { count: 1, allowed: true }; },
    async countOpenDeliveries() { return 0; },
    async persistAcceptedEnvelope(row) { return { message_id: row.envelope.message_id, duplicate: false }; }
  };
  const server = createRelayServer({ registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]), repository, stream, now: new Date('2026-08-13T12:01:00Z') });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  await new Promise((resolve, reject) => { const request = http.request({ port, method: 'POST', path: '/v1/envelopes' }, (response) => { response.resume(); response.on('end', resolve); }); request.on('error', reject); request.end(JSON.stringify(envelope)); });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].endpointId, envelope.sender.endpoint_id);
  assert.equal(receipts[0].receipt.message_id, 'msg_01JEXAMPLE');
  assert.equal(receipts[0].receipt.delivery_id, 'del_msg_01JEXAMPLE');
  assert.equal(receipts[0].receipt.state, 'delivered');
  assert.equal(receipts[0].receipt.at, envelope.created_at);
});

test('HTTP relay suppresses duplicate notification when persistence detects a concurrent race', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  envelope.created_at = '2026-08-13T12:00:00.000Z'; envelope.expires_at = '2026-08-14T00:00:00.000Z'; envelope.recipient.endpoint_id = 'ep_claude';
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  const notifications = [];
  const repository = {
    async withTransaction(fn) { return fn(null); },
    async lookupIdempotency() { return null; },
    async lookupAcceptedMessageId() { return null; },
    async lookupCapabilityRegistration(capability) { return { capability, namespace: capability.split('/')[0], risk_tier: 'standard' }; },
    async lookupActiveCapabilityGrants() { return []; },
    async reserveRateLimit() { return { count: 1, allowed: true }; },
    async countOpenDeliveries() { return 0; },
    async persistAcceptedEnvelope() { return { message_id: 'msg_won_the_race', duplicate: true }; }
  };
  const server = createRelayServer({
    registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]),
    repository, stream: { notify(...args) { notifications.push(args); } }, now: new Date('2026-08-13T12:01:00Z')
  });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/envelopes', body: envelope });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 202);
  assert.equal(result.body.message_id, 'msg_won_the_race');
  assert.equal(result.body.duplicate, true);
  assert.deepEqual(notifications, []);
});

test('ack route uses persistent acknowledgeDelivery when the repository supports it, and replays idempotently', async () => {
  const calls = [];
  const repository = {
    async acknowledgeDelivery({ deliveryId, endpointId }) {
      calls.push([deliveryId, endpointId]);
      return calls.length === 1 ? { duplicate: false, delivery: { state: 'acknowledged' } } : { duplicate: true, acknowledged_at: '2026-08-13T12:00:00Z' };
    }
  };
  const server = createRelayServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_claude' }) });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const first = await request(port, { method: 'POST', path: '/v1/deliveries/del_1/ack' });
  const replay = await request(port, { method: 'POST', path: '/v1/deliveries/del_1/ack' });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(first.status, 204); assert.equal(replay.status, 204);
  assert.deepEqual(calls, [['del_1', 'ep_claude'], ['del_1', 'ep_claude']]);
});

test('ack route surfaces a conflicting acknowledgement as 409', async () => {
  const repository = { async acknowledgeDelivery() { throw Object.assign(new Error('Delivery already acknowledged by a different endpoint'), { code: 'DELIVERY_UNAVAILABLE' }); } };
  const server = createRelayServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_other' }) });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/deliveries/del_1/ack' });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 409); assert.equal(result.body.code, 'DELIVERY_UNAVAILABLE');
});

test('authenticated inbox route returns only principal deliveries and acknowledges them', async () => {
  const calls = [];
  const repository = {
    async listInbox(endpointId, since) { calls.push(['list', endpointId, since]); return [{ delivery_id: 'del_1', message_id: 'msg_1' }]; },
    async getDelivery(deliveryId, endpointId) { calls.push(['get', deliveryId, endpointId]); return { delivery_id: deliveryId, recipient_endpoint_id: endpointId, state: 'delivered', attempts: 1 }; },
    async transitionDelivery(deliveryId, endpointId, state, { next }) { calls.push(['transition', deliveryId, endpointId, state, next.state]); return next; }
  };
  const server = createRelayServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_claude' }) });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const get = await request(port, { method: 'GET', path: '/v1/inbox?since=cursor_1' });
  const ack = await request(port, { method: 'POST', path: '/v1/deliveries/del_1/ack' });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(get.status, 200); assert.deepEqual(get.body.items, [{ delivery_id: 'del_1', message_id: 'msg_1' }]);
  assert.equal(ack.status, 204); assert.deepEqual(calls, [['list', 'ep_claude', 'cursor_1'], ['get', 'del_1', 'ep_claude'], ['transition', 'del_1', 'ep_claude', 'acknowledged', 'acknowledged']]);
});

test('inbox route passes the principal owner_id through to listInbox for viewer-scoped sender_unverified', async () => {
  const calls = [];
  const repository = { async listInbox(endpointId, since, viewerOwnerId) { calls.push([endpointId, since, viewerOwnerId]); return [{ delivery_id: 'del_1', message_id: 'msg_1', sender_unverified: true }]; } };
  const server = createRelayServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_claude', owner_id: 'usr_claude_owner' }) });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const get = await request(port, { method: 'GET', path: '/v1/inbox' });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(get.status, 200);
  assert.deepEqual(calls, [['ep_claude', '', 'usr_claude_owner']]);
  assert.equal(get.body.items[0].sender_unverified, true);
});

test('POST /v1/endpoint-acknowledgements records an acknowledgement scoped to the authenticated viewer', async () => {
  const calls = [];
  const repository = { async acknowledgeEndpoint({ viewerOwnerId, acknowledgedEndpointId }) { calls.push([viewerOwnerId, acknowledgedEndpointId]); return { viewer_owner_id: viewerOwnerId, acknowledged_endpoint_id: acknowledgedEndpointId, acknowledged_at: '2026-08-16T00:00:00.000Z' }; } };
  const server = createRelayServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_claude', owner_id: 'usr_claude_owner' }) });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/endpoint-acknowledgements', body: { acknowledged_endpoint_id: 'ep_codex' } });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 201);
  assert.deepEqual(calls, [['usr_claude_owner', 'ep_codex']]);
  assert.equal(result.body.acknowledgement.acknowledged_endpoint_id, 'ep_codex');
});

test('POST /v1/endpoint-acknowledgements rejects a body missing acknowledged_endpoint_id', async () => {
  const server = createRelayServer({ repository: {}, authenticate: async () => ({ endpoint_id: 'ep_claude', owner_id: 'usr_claude_owner' }) });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/endpoint-acknowledgements', body: {} });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'INVALID_ENVELOPE');
});

test('POST /v1/endpoint-acknowledgements returns 503 when the repository does not support acknowledgements', async () => {
  const server = createRelayServer({ repository: {}, authenticate: async () => ({ endpoint_id: 'ep_claude', owner_id: 'usr_claude_owner' }) });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/endpoint-acknowledgements', body: { acknowledged_endpoint_id: 'ep_codex' } });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 503);
});

test('ack route pushes an acknowledged receipt to the sender via stream.notifyReceipt', async () => {
  const receipts = [];
  const repository = {
    async acknowledgeDelivery({ deliveryId }) { return { delivery_id: deliveryId, message_id: 'msg_1' }; },
    async lookupMessageSender(messageId) { return messageId === 'msg_1' ? { endpoint_id: 'ep_codex' } : null; },
  };
  const stream = { notifyReceipt: (endpointId, receipt) => { receipts.push({ endpointId, receipt }); return true; } };
  const server = createRelayServer({ repository, stream, authenticate: async () => ({ endpoint_id: 'ep_claude' }), now: new Date('2026-08-16T00:00:00.000Z') });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const ack = await request(port, { method: 'POST', path: '/v1/deliveries/del_1/ack' });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(ack.status, 204);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].endpointId, 'ep_codex');
  assert.equal(receipts[0].receipt.state, 'acknowledged');
  assert.equal(receipts[0].receipt.delivery_id, 'del_1');
});

test('authenticated delivery route rejects invalid processing state', async () => {
  const server = createRelayServer({ repository: {}, authenticate: async () => ({ endpoint_id: 'ep_claude' }) });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/deliveries/del_1/processing', body: { state: 'unknown_state' } });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 400); assert.equal(result.body.code, 'INVALID_ENVELOPE');
});

test('authenticated delivery route transitions acknowledged delivery to processing_failed with reason and pushes receipt', async () => {
  const receipts = [];
  const transitions = [];
  const repository = {
    async getDelivery(deliveryId, endpointId) {
      return { delivery_id: deliveryId, recipient_endpoint_id: endpointId, message_id: 'msg_ack_fail', state: 'acknowledged', attempts: 0 };
    },
    async transitionDelivery(deliveryId, endpointId, state, { next }) {
      transitions.push({ deliveryId, endpointId, state, next });
      return next;
    },
    async lookupMessageSender(messageId) {
      return messageId === 'msg_ack_fail' ? { endpoint_id: 'ep_codex' } : null;
    }
  };
  const stream = { notifyReceipt: (endpointId, receipt) => { receipts.push({ endpointId, receipt }); return true; } };
  const server = createRelayServer({ repository, stream, authenticate: async () => ({ endpoint_id: 'ep_claude' }), now: new Date('2026-08-16T00:00:00.000Z') });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const result = await request(port, {
    method: 'POST',
    path: '/v1/deliveries/del_1/processing',
    body: { state: 'processing_failed', reason: 'task runner timed out' }
  });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 204);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].next.state, 'processing_failed');
  assert.equal(transitions[0].next.failure_reason, 'task runner timed out');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].endpointId, 'ep_codex');
  assert.equal(receipts[0].receipt.state, 'processing_failed');
});

test('authenticated approval challenge route returns public metadata only', async () => {
  const challenges = new Map();
  const server = createRelayServer({
    relayOrigin: 'https://relay.example', approvalChallenges: challenges,
    authenticate: async () => ({ endpoint_id: 'ep_codex' })
  });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/approval-challenges', body: { action_hash: 'sha256:abc', callback_url: 'http://127.0.0.1:4567/callback' } });
  const rejected = await request(port, { method: 'POST', path: '/v1/approval-challenges', body: { action_hash: 'sha256:abc', callback_url: 'http://evil.example/callback' } });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 201);
  assert.equal(result.body.code, 'OK');
  assert.equal(result.body.approval_url.startsWith('https://relay.example/approve?'), true);
  assert.equal(Object.hasOwn(result.body, 'token'), false);
  assert.equal(challenges.get(result.body.challenge_id).endpointId, 'ep_codex');
  assert.equal(rejected.status, 400); assert.equal(rejected.body.code, 'APPROVAL_REQUIRED');
});

test('approval challenge recomputes canonical action hash and rejects mismatches', async () => {
  const challenges = new Map();
  const server = createRelayServer({ relayOrigin: 'https://relay.example', approvalChallenges: challenges, authenticate: async () => ({ endpoint_id: 'ep_codex' }) });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const action = { action_type: 'tool.invoke', target: 'calendar:event-1', requested_capabilities: ['calendar/read'], arguments: {}, contract_version: 'sigil.connector/v1' };
  const rejected = await request(port, { method: 'POST', path: '/v1/approval-challenges', body: { action, action_hash: 'sha256:wrong', callback_url: 'http://127.0.0.1:4567/callback' } });
  const accepted = await request(port, { method: 'POST', path: '/v1/approval-challenges', body: { action, callback_url: 'http://127.0.0.1:4567/callback' } }); await new Promise((resolve) => server.close(resolve));
  assert.equal(rejected.status, 409); assert.equal(accepted.status, 201); assert.match(challenges.get(accepted.body.challenge_id).actionHash, /^sha256:jcs-sigil-action-v1:/);
});

test('approval challenge route bounds pending approval queue', async () => {
  const challenges = new Map([['existing', { used: false }]]);
  const server = createRelayServer({ relayOrigin: 'https://relay.example', approvalChallenges: challenges, maxPendingApprovals: 1, authenticate: async () => ({ endpoint_id: 'ep_codex' }) });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/approval-challenges', body: { action_hash: 'sha256:abc', callback_url: 'http://127.0.0.1:4567/callback' } }); await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 429); assert.equal(result.body.code, 'RATE_LIMITED');
});

test('approval assertion route verifies credential server-side and is single-use', async () => {
  const challenges = new Map();
  const server = createRelayServer({
    relayOrigin: 'https://relay.example', rpId: 'relay.example', approvalChallenges: challenges,
    authenticate: async () => ({ endpoint_id: 'ep_codex' }),
    lookupHumanCredential: async (credentialId) => ({ credentialId, endpointId: 'ep_codex', humanId: 'usr_1', type: 'webauthn', status: 'active' }),
    verifyAssertion: async () => true
  });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const created = await request(port, { method: 'POST', path: '/v1/approval-challenges', body: { action_hash: 'sha256:abc', callback_url: 'http://127.0.0.1:4567/callback' } });
  const challenge = challenges.get(created.body.challenge_id);
  const assertion = { credential_id: 'cred_1', challenge: challenge.id, actionHash: 'sha256:abc', origin: 'https://relay.example', rpId: 'relay.example', userVerified: true, endpointId: 'ep_codex' };
  const verified = await request(port, { method: 'POST', path: `/v1/approval-challenges/${challenge.id}/assertion`, body: assertion });
  const replay = await request(port, { method: 'POST', path: `/v1/approval-challenges/${challenge.id}/assertion`, body: assertion });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(verified.status, 200); assert.equal(verified.body.actorId, 'usr_1');
  assert.equal(replay.status, 409); assert.equal(replay.body.code, 'APPROVAL_EXPIRED');
});

test('approval assertion route accepts a correctly signed default WebAuthn assertion', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const challenges = new Map();
  const server = createRelayServer({ relayOrigin: 'https://relay.example', rpId: 'relay.example', approvalChallenges: challenges, authenticate: async () => ({ endpoint_id: 'ep_codex' }), lookupHumanCredential: async (credentialId) => ({ credentialId, endpointId: 'ep_codex', humanId: 'usr_1', type: 'webauthn', status: 'active', publicKey }) });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const created = await request(port, { method: 'POST', path: '/v1/approval-challenges', body: { action_hash: 'sha256:abc', callback_url: 'http://127.0.0.1:4567/callback' } });
  const challenge = challenges.get(created.body.challenge_id);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: challenge.webauthnChallenge, origin: 'https://relay.example' })).toString('base64url');
  const authenticatorData = Buffer.concat([crypto.createHash('sha256').update('relay.example').digest(), Buffer.from([0x05, 0, 0, 0, 1])]).toString('base64url');
  const signedBytes = Buffer.concat([Buffer.from(authenticatorData, 'base64url'), crypto.createHash('sha256').update(Buffer.from(clientDataJSON, 'base64url')).digest()]);
  const signature = crypto.sign(null, signedBytes, privateKey).toString('base64url');
  const result = await request(port, { method: 'POST', path: `/v1/approval-challenges/${challenge.id}/assertion`, body: { credential_id: 'cred_1', challenge: challenge.id, actionHash: 'sha256:abc', origin: 'https://relay.example', rpId: 'relay.example', userVerified: true, endpointId: 'ep_codex', clientDataJSON, authenticatorData, signature } });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 200); assert.equal(result.body.actorId, 'usr_1');
});

test('approval assertion route accepts a correctly signed ES256 assertion', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const challenges = new Map();
  const server = createRelayServer({ relayOrigin: 'https://relay.example', rpId: 'relay.example', approvalChallenges: challenges, authenticate: async () => ({ endpoint_id: 'ep_codex' }), lookupHumanCredential: async (credentialId) => ({ credentialId, endpointId: 'ep_codex', humanId: 'usr_1', type: 'webauthn', algorithm: 'ES256', status: 'active', publicKey }) });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const created = await request(port, { method: 'POST', path: '/v1/approval-challenges', body: { action_hash: 'sha256:abc', callback_url: 'http://127.0.0.1:4567/callback' } });
  const challenge = challenges.get(created.body.challenge_id);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: challenge.webauthnChallenge, origin: 'https://relay.example' })).toString('base64url');
  const authenticatorData = Buffer.concat([crypto.createHash('sha256').update('relay.example').digest(), Buffer.from([0x05, 0, 0, 0, 1])]).toString('base64url');
  const signedBytes = Buffer.concat([Buffer.from(authenticatorData, 'base64url'), crypto.createHash('sha256').update(Buffer.from(clientDataJSON, 'base64url')).digest()]);
  const signature = crypto.sign('sha256', signedBytes, privateKey).toString('base64url');
  const result = await request(port, { method: 'POST', path: `/v1/approval-challenges/${challenge.id}/assertion`, body: { credential_id: 'cred_1', challenge: challenge.id, actionHash: 'sha256:abc', origin: 'https://relay.example', rpId: 'relay.example', userVerified: true, endpointId: 'ep_codex', clientDataJSON, authenticatorData, signature } });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 200); assert.equal(result.body.actorId, 'usr_1');
});

test('approval assertion route rejects unsigned assertion without injected verifier', async () => {
  const challenges = new Map();
  const server = createRelayServer({ relayOrigin: 'https://relay.example', rpId: 'relay.example', approvalChallenges: challenges, authenticate: async () => ({ endpoint_id: 'ep_codex' }), lookupHumanCredential: async (credentialId) => ({ credentialId, endpointId: 'ep_codex', humanId: 'usr_1', type: 'webauthn', status: 'active', publicKey: 'not-a-key' }) });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const created = await request(port, { method: 'POST', path: '/v1/approval-challenges', body: { action_hash: 'sha256:abc', callback_url: 'http://127.0.0.1:4567/callback' } });
  const challenge = challenges.get(created.body.challenge_id);
  const result = await request(port, { method: 'POST', path: `/v1/approval-challenges/${challenge.id}/assertion`, body: { credential_id: 'cred_1', challenge: challenge.id, actionHash: 'sha256:abc', origin: 'https://relay.example', rpId: 'relay.example', userVerified: true, endpointId: 'ep_codex', signedData: 'ZmFrZQ', signature: 'ZmFrZQ' } });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 409); assert.equal(result.body.code, 'APPROVAL_REQUIRED');
});

test('authenticated credential enrollment persists parsed attestation key', async () => {
  const saved = [];
  const server = createRelayServer({ authenticate: async () => ({ endpoint_id: 'ep_codex', human_id: 'usr_1' }), repository: { async registerHumanCredential(row) { saved.push(row); } } });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/webauthn/credentials', body: { attestation_object: 'bad' } });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 400);
  assert.equal(saved.length, 0);
});

test('credential enrollment rejects oversized request bodies', async () => {
  const server = createRelayServer({ authenticate: async () => ({ endpoint_id: 'ep_codex', human_id: 'usr_1' }), repository: { async registerHumanCredential() { throw new Error('must not persist'); } } });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/webauthn/credentials', body: { attestation_object: 'x'.repeat(1024 * 1024 + 1) } });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 413); assert.equal(result.body.code, 'REQUEST_TOO_LARGE');
});

test('envelope and delivery routes reject oversized request bodies', async () => {
  const server = createRelayServer({
    authenticate: async () => ({ endpoint_id: 'ep_codex' }),
    repository: { async getDelivery() { throw new Error('must not read'); } }
  });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const oversized = 'x'.repeat(1024 * 1024 + 1);
  const envelope = await request(port, { method: 'POST', path: '/v1/envelopes', body: oversized });
  const delivery = await request(port, { method: 'POST', path: '/v1/deliveries/del_1/processing', body: oversized });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(envelope.status, 413); assert.equal(envelope.body.code, 'REQUEST_TOO_LARGE');
  assert.equal(delivery.status, 413); assert.equal(delivery.body.code, 'REQUEST_TOO_LARGE');
});

test('credential enrollment persists attested ID and rejects spoofed ID', async () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const rawKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const cose = cborMap([[1, cborInt(1)], [3, cborInt(-8)], [-1, cborInt(6)], [-2, cborBytes(rawKey)]]);
  const authData = Buffer.concat([crypto.randomBytes(32), Buffer.from([0x41, 0, 0, 0, 1]), crypto.randomBytes(16), Buffer.from([0, 4]), Buffer.from('cred'), cose, Buffer.from([0])]);
  const text = (value) => Buffer.concat([Buffer.from([0x60 + value.length]), Buffer.from(value)]);
  const attestation = cborMap([['fmt', text('none')], ['authData', cborBytes(authData)], ['attStmt', Buffer.from([0xa0])]]).toString('base64url');
  const parsed = parseAttestationObject(attestation);
  assert.ok(parsed, attestation);
  const saved = []; const server = createRelayServer({ authenticate: async () => ({ endpoint_id: 'ep_codex', human_id: 'usr_1' }), repository: { async registerHumanCredential(row) { saved.push(row); } } });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const ok = await request(port, { method: 'POST', path: '/v1/webauthn/credentials', body: { attestation_object: attestation } });
  const bad = await request(port, { method: 'POST', path: '/v1/webauthn/credentials', body: { attestation_object: attestation, credential_id: 'spoofed' } });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(ok.status, 201, JSON.stringify(ok.body)); assert.equal(ok.body.credential_id, Buffer.from('cred').toString('base64url')); assert.equal(saved[0].credentialId, ok.body.credential_id);
  assert.equal(bad.status, 409); assert.equal(bad.body.code, 'INVALID_ATTESTATION');
});

test('authenticated routes reject missing principal', async () => {
  const server = createRelayServer({ authenticate: async () => null });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const result = await request(port, { method: 'GET', path: '/v1/inbox' });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 401); assert.equal(result.body.code, 'UNAUTHENTICATED');
});

test('GET /v1/audit requires conversation_id and membership, then returns the conversation timeline', async () => {
  const calls = [];
  const repository = {
    async isConversationMember(endpointId, conversationId) { calls.push(['isConversationMember', endpointId, conversationId]); return conversationId === 'conv_1'; },
    async listAuditEventsForConversation(conversationId) { calls.push(['listAuditEventsForConversation', conversationId]); return [{ event_id: 'audit_1', event_type: 'delivery.acknowledged' }]; }
  };
  const server = createRelayServer({ repository, authenticate: async () => ({ endpoint_id: 'ep_claude' }) });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const missingParam = await request(port, { method: 'GET', path: '/v1/audit' });
  const notMember = await request(port, { method: 'GET', path: '/v1/audit?conversation_id=conv_2' });
  const ok = await request(port, { method: 'GET', path: '/v1/audit?conversation_id=conv_1' });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(missingParam.status, 400); assert.equal(missingParam.body.code, 'INVALID_ENVELOPE');
  assert.equal(notMember.status, 403); assert.equal(notMember.body.code, 'ROUTE_NOT_AUTHORIZED');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.code, 'OK');
  assert.deepEqual(ok.body.events, [{ event_id: 'audit_1', event_type: 'delivery.acknowledged' }]);
  assert.deepEqual(calls, [['isConversationMember', 'ep_claude', 'conv_2'], ['isConversationMember', 'ep_claude', 'conv_1'], ['listAuditEventsForConversation', 'conv_1']]);
});

test('POST /v1/directory/invites requires an authenticated human context', async () => {
  const { server, baseUrl } = await startServer({ authenticate: async () => ({ endpoint_id: 'ep_a' }) });
  try {
    const response = await request(baseUrl, 'POST', '/v1/directory/invites', {});
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'HUMAN_CONTEXT_REQUIRED');
  } finally { server.close(); }
});

test('POST /v1/directory/invites issues a code once', async () => {
  const repository = { createDirectoryInvite: async () => ({ invite_id: 'invite_1', code: 'plaintext-code', expires_at: '2026-08-22T00:00:00Z' }), recordAuditEvent: async () => {} };
  const { server, baseUrl } = await startServer({ authenticate: async () => ({ endpoint_id: 'ep_a', human_id: 'usr_a' }), repository, relayOrigin: 'https://relay.local' });
  try {
    const response = await request(baseUrl, 'POST', '/v1/directory/invites', {});
    assert.equal(response.status, 201);
    assert.equal(response.body.code, 'OK');
    assert.equal(response.body.invite.code, 'plaintext-code');
  } finally { server.close(); }
});

test('POST /v1/directory/invites/redeem maps INVITE_UNAVAILABLE to a generic 404', async () => {
  const repository = { redeemDirectoryInvite: async () => { throw Object.assign(new Error('Invite code is invalid or expired'), { code: 'INVITE_UNAVAILABLE' }); } };
  const { server, baseUrl } = await startServer({ authenticate: async () => ({ endpoint_id: 'ep_b', human_id: 'usr_b' }), repository });
  try {
    const response = await request(baseUrl, 'POST', '/v1/directory/invites/redeem', { code: 'wrong' });
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'INVITE_UNAVAILABLE');
  } finally { server.close(); }
});

test('POST /v1/directory/links/:linkId/confirm requires human context and forwards actor mismatch', async () => {
  const repository = { confirmDirectoryLink: async () => { throw Object.assign(new Error('Confirming human is not a party to this link'), { code: 'CONFIRMATION_ACTOR_MISMATCH' }); } };
  const { server, baseUrl } = await startServer({ authenticate: async () => ({ endpoint_id: 'ep_c', human_id: 'usr_c' }), repository });
  try {
    const response = await request(baseUrl, 'POST', '/v1/directory/links/link_1/confirm', {});
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'CONFIRMATION_ACTOR_MISMATCH');
  } finally { server.close(); }
});

test('POST /v1/directory/links/:linkId/revoke succeeds for either party', async () => {
  const repository = { revokeDirectoryLink: async () => ({ link_id: 'link_1', status: 'revoked' }), recordAuditEvent: async () => {} };
  const { server, baseUrl } = await startServer({ authenticate: async () => ({ endpoint_id: 'ep_a', human_id: 'usr_a' }), repository });
  try {
    const response = await request(baseUrl, 'POST', '/v1/directory/links/link_1/revoke', {});
    assert.equal(response.status, 200);
    assert.equal(response.body.link.status, 'revoked');
  } finally { server.close(); }
});

test('POST /v1/directory/invites is rate-limited per issuing endpoint/human', async () => {
  const reservations = [];
  const repository = {
    createDirectoryInvite: async () => ({ invite_id: 'invite_1', code: 'x', expires_at: '2026-08-22T00:00:00Z' }),
    reserveRateLimit: async (scopeKind, scopeId) => { reservations.push({ scopeKind, scopeId }); return { count: 21, allowed: false }; },
    recordAuditEvent: async () => {}
  };
  const { server, baseUrl } = await startServer({ authenticate: async () => ({ endpoint_id: 'ep_a', human_id: 'usr_a' }), repository });
  try {
    const response = await request(baseUrl, 'POST', '/v1/directory/invites', {});
    assert.equal(response.status, 429);
    assert.equal(response.body.code, 'RATE_LIMITED');
    assert.equal(reservations[0].scopeKind, 'directory_invite_create');
  } finally { server.close(); }
});

test('POST /v1/directory/invites is reachable under the CLI\'s real bearer authenticator, with human_id resolved from the registry', async () => {
  const repository = { createDirectoryInvite: async () => ({ invite_id: 'invite_1', code: 'plaintext-code', expires_at: '2026-08-22T00:00:00Z' }), recordAuditEvent: async () => {} };
  const tokenHashes = new Map([[hashBearerToken('token_a'), 'ep_a']]);
  const registry = new Map([['ep_a', { owner_id: 'usr_a', endpoint_id: 'ep_a', status: 'active' }]]);
  const { server, baseUrl } = await startServer({ tokenHashes, registry, repository });
  try {
    const url = new URL(baseUrl);
    const response = await new Promise((resolve, reject) => {
      const req = http.request({ port: url.port, method: 'POST', path: '/v1/directory/invites', headers: { 'content-type': 'application/json', authorization: 'Bearer token_a' } }, (res) => {
        let text = ''; res.on('data', (chunk) => text += chunk); res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
      });
      req.on('error', reject); req.end('{}');
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.code, 'OK');
  } finally { server.close(); }
});

test('POST /v1/directory/invites/redeem consumes quota on a guessed (invalid) code, not on infra failure', async () => {
  const reservations = [];
  const repository = {
    reserveRateLimit: async (scopeKind, scopeId) => { reservations.push({ scopeKind, scopeId }); return { count: 1, allowed: true }; },
    redeemDirectoryInvite: async () => { throw Object.assign(new Error('Invite code is invalid or expired'), { code: 'INVITE_UNAVAILABLE' }); }
  };
  const { server, baseUrl } = await startServer({ authenticate: async () => ({ endpoint_id: 'ep_b', human_id: 'usr_b' }), repository });
  try {
    await request(baseUrl, 'POST', '/v1/directory/invites/redeem', { code: 'guess' });
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0].scopeKind, 'directory_invite_redeem');
  } finally { server.close(); }
});

test('a relay with --domain configured rejects a foreign-domain recipient with RECIPIENT_NOT_LOCAL', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  envelope.created_at = '2026-08-25T12:00:00.000Z'; envelope.expires_at = '2026-08-25T13:00:00.000Z';
  envelope.recipient = { endpoint_id: 'ep_claude@other.example.com', owner_id: 'usr_claude_owner' };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  const server = createRelayServer({
    registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]),
    persist: () => {}, now: new Date('2026-08-25T12:01:00Z'), relayDomain: 'relay.example.com',
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/envelopes', body: envelope });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'RECIPIENT_NOT_LOCAL');
  assert.equal(result.body.details.recipientDomain, 'other.example.com');
  assert.equal(result.body.details.relayDomain, 'relay.example.com');
});

test('a relay with --domain configured rejects a bare recipient with MALFORMED_FEDERATED_ID', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  envelope.created_at = '2026-08-25T12:00:00.000Z'; envelope.expires_at = '2026-08-25T13:00:00.000Z';
  envelope.recipient = { endpoint_id: 'ep_claude', owner_id: 'usr_claude_owner' };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  const server = createRelayServer({
    registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]),
    persist: () => {}, now: new Date('2026-08-25T12:01:00Z'), relayDomain: 'relay.example.com',
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/envelopes', body: envelope });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'MALFORMED_FEDERATED_ID');
});

test('a relay with no --domain still accepts a bare legacy recipient unchanged (regression)', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  envelope.created_at = '2026-08-25T12:00:00.000Z'; envelope.expires_at = '2026-08-25T13:00:00.000Z';
  envelope.recipient = { endpoint_id: 'ep_claude', owner_id: 'usr_claude_owner' };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  const server = createRelayServer({
    registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]),
    persist: () => {}, now: new Date('2026-08-25T12:01:00Z'),
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/envelopes', body: envelope });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 202);
});

test('local-part case is significant: ep_Foo@x.com and ep_foo@x.com are distinct recipients through the real accept path', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  envelope.created_at = '2026-08-25T12:00:00.000Z'; envelope.expires_at = '2026-08-25T13:00:00.000Z';
  envelope.recipient = { endpoint_id: 'ep_Foo@relay.example.com', owner_id: 'usr_claude_owner' };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  let persistedRecipient;
  const server = createRelayServer({
    registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]),
    persist: ({ envelope: accepted }) => { persistedRecipient = accepted.recipient.endpoint_id; },
    now: new Date('2026-08-25T12:01:00Z'), relayDomain: 'relay.example.com',
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/envelopes', body: envelope });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 202);
  // proves the exact-case string reached persistence unmodified -- a lowercased
  // "ep_foo@relay.example.com" here would silently merge two distinct endpoints.
  assert.equal(persistedRecipient, 'ep_Foo@relay.example.com');
});

function startServer({ authenticate, repository, relayOrigin, oidcIssuerAllowList = new Set(), tokenHashes, registry } = {}) {
  return new Promise((resolve) => {
    const server = createRelayServer({ authenticate, repository, relayOrigin, oidcIssuerAllowList, tokenHashes, registry, now: new Date('2026-08-22T00:00:00Z') });
    server.listen(0, () => {
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({ server, baseUrl });
    });
  });
}

function request(portOrBaseUrl, methodOrOptions, path, body) {
  // Handle both signatures:
  // 1. (port, { method, path, body }) - original
  // 2. (baseUrl, method, path, body) - directory tests
  if (typeof portOrBaseUrl === 'string' && portOrBaseUrl.startsWith('http')) {
    // New signature: (baseUrl, method, path, body)
    const url = new URL(portOrBaseUrl);
    return new Promise((resolve, reject) => {
      const req = http.request({ port: parseInt(url.port, 10), method: methodOrOptions, path, headers: { 'content-type': 'application/json' } }, (response) => {
        let text = ''; response.on('data', (chunk) => text += chunk); response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
      });
      req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  // Original signature: (port, { method, path, body })
  const { method, path: p, body: b } = methodOrOptions;
  return new Promise((resolve, reject) => {
    const req = http.request({ port: portOrBaseUrl, method, path: p, headers: { 'content-type': 'application/json' } }, (response) => {
      let text = ''; response.on('data', (chunk) => text += chunk); response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); req.end(b ? (typeof b === 'string' ? b : JSON.stringify(b)) : undefined);
  });
}
