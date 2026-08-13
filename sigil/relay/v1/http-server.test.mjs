import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { signedBytes } from './validate-envelope.mjs';
import { createRelayServer } from './http-server.mjs';

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

test('HTTP relay notifies recipient stream after acceptance', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../contracts/v1/envelope.example.json', import.meta.url)));
  envelope.created_at = '2026-08-13T12:00:00.000Z'; envelope.expires_at = '2026-08-14T00:00:00.000Z'; envelope.recipient.endpoint_id = 'ep_claude'; envelope.signature.value = crypto.sign(null, signedBytes(envelope), privateKey).toString('base64url');
  const notifications = []; const stream = { notify: (endpointId, messageId) => { notifications.push({ endpointId, messageId }); return true; } };
  const server = createRelayServer({ registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]), persist: () => {}, stream, now: new Date('2026-08-13T12:01:00Z') });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  await new Promise((resolve, reject) => { const request = http.request({ port, method: 'POST', path: '/v1/envelopes' }, (response) => { response.resume(); response.on('end', resolve); }); request.on('error', reject); request.end(JSON.stringify(envelope)); });
  await new Promise((resolve) => server.close(resolve));
  assert.deepEqual(notifications, [{ endpointId: 'ep_claude', messageId: 'msg_01JEXAMPLE' }]);
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

test('authenticated delivery route rejects invalid processing state', async () => {
  const server = createRelayServer({ repository: {}, authenticate: async () => ({ endpoint_id: 'ep_claude' }) });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/deliveries/del_1/processing', body: { state: 'processed' } });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 400); assert.equal(result.body.code, 'INVALID_ENVELOPE');
});

test('authenticated routes reject missing principal', async () => {
  const server = createRelayServer({ authenticate: async () => null });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const result = await request(port, { method: 'GET', path: '/v1/inbox' });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 401); assert.equal(result.body.code, 'UNAUTHENTICATED');
});

function request(port, { method, path, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ port, method, path, headers: { 'content-type': 'application/json' } }, (response) => {
      let text = ''; response.on('data', (chunk) => text += chunk); response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    request.on('error', reject); request.end(body ? JSON.stringify(body) : undefined);
  });
}
