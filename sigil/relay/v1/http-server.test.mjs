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
