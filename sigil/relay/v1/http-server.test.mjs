import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { signedBytes } from './validate-envelope.mjs';
import { createRelayServer } from './http-server.mjs';
import { parseAttestationObject } from './approval-ceremony.mjs';

function cborInt(value) { return value >= 0 ? Buffer.from([value]) : Buffer.from([0x20 + (-1 - value)]); }
function cborMap(entries) { return Buffer.concat([Buffer.from([0xa0 + entries.length]), ...entries.flatMap(([key, value]) => [typeof key === 'string' ? Buffer.concat([Buffer.from([0x60 + key.length]), Buffer.from(key)]) : cborInt(key), value])]); }
function cborBytes(value) { return Buffer.concat([Buffer.from([0x58, value.length]), value]); }

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
    repository: { async withTransaction(fn) { return fn(null); }, async lookupIdempotency() { return null; }, async persistAcceptedEnvelope() { throw new Error('database unavailable'); } },
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
    async persistAcceptedEnvelope(row) { return { message_id: row.envelope.message_id, duplicate: false }; }
  };
  const server = createRelayServer({ registry: new Map([['ep_codex', { owner_id: 'usr_codex_owner', status: 'active', key_id: 'key_01JEXAMPLE', public_key: publicKey }]]), repository, stream, now: new Date('2026-08-13T12:01:00Z') });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  await new Promise((resolve, reject) => { const request = http.request({ port, method: 'POST', path: '/v1/envelopes' }, (response) => { response.resume(); response.on('end', resolve); }); request.on('error', reject); request.end(JSON.stringify(envelope)); });
  await new Promise((resolve) => server.close(resolve));
  assert.deepEqual(notifications, [{ endpointId: 'ep_claude', messageId: 'msg_01JEXAMPLE' }]);
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

test('authenticated delivery route rejects invalid processing state', async () => {
  const server = createRelayServer({ repository: {}, authenticate: async () => ({ endpoint_id: 'ep_claude' }) });
  await new Promise((resolve) => server.listen(0, resolve)); const { port } = server.address();
  const result = await request(port, { method: 'POST', path: '/v1/deliveries/del_1/processing', body: { state: 'processed' } });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, 400); assert.equal(result.body.code, 'INVALID_ENVELOPE');
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

function request(port, { method, path, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ port, method, path, headers: { 'content-type': 'application/json' } }, (response) => {
      let text = ''; response.on('data', (chunk) => text += chunk); response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    request.on('error', reject); request.end(body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined);
  });
}
