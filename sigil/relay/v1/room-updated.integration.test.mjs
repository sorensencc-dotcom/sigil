// Rooms phase 4a: room.updated frames fire after commit only, to humans only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { createRelayServer } from './http-server.mjs';
import { emitRoomEvent } from './room-events.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createIdentity, identityKeys } from '../../cli/identity.mjs';
import { createAgentMailIngress } from '../../ingress/v1/agentmail-adapter.mjs';
import { createAgentMailSecretStore } from '../../ingress/v1/agentmail-secret-snapshot.mjs';
import { createAcceptOptionsBuilder } from './accept-options.mjs';
import { createP2pHost } from './transport-libp2p/p2p-host.mjs';
import { wireDataProtocol, sendEnvelope } from './transport-libp2p/p2p-data-protocol.mjs';

const NOW = new Date('2026-10-02T12:01:00.000Z');

async function world() {
  const system = createIdentity({ ownerId: 'relay_system', endpointId: 'ep_relay_system', kind: 'system' });
  const ids = ['ep_web', 'ep_web2', 'ep_claude'];
  const keys = Object.fromEntries(ids.map((id) => [id, crypto.generateKeyPairSync('ed25519')]));
  const registered = new Map(ids.map((id) => [id, { owner_id: 'usr_chris', status: 'active', kind: id === 'ep_claude' ? 'agent' : 'human', key_id: `key_${id}`, public_key: keys[id].publicKey }]));
  const repository = createMemoryRepository({ registry: registered });
  await repository.ensureRoomSystemEndpoint({ identity: system, now: NOW });
  await repository.createRoom({ conversationId: 'room_1', workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_web2', role: 'member', responseMode: null, addedByHumanId: 'usr_chris', now: NOW });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_chris', now: NOW });
  const frames = [];
  const stream = { notify() {}, notifyReceipt() {}, notifyRoom: (id, frame) => { frames.push([id, frame]); return true; } };
  return { system, keys, registered, repository, frames, stream, room: await repository.lookupRoom('room_1') };
}

function roomMessage(keys, senderId) {
  const envelope = {
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: 'room_1', message_type: 'room.message',
    sender: { endpoint_id: senderId, owner_id: 'usr_chris' }, broadcast_scope: { conversation_id: 'room_1' },
    body: { text: 'hello room' }, context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: `idem_${crypto.randomUUID()}`, created_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-02T13:00:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: `key_${senderId}`, value: '' },
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys[senderId].privateKey).toString('base64url');
  return envelope;
}

const byEndpoint = (frames) => frames.map(([id]) => id).sort();

test('a room message sends one room.updated per human member, sender included, none to agents', async () => {
  const w = await world();
  const result = await acceptEnvelopeAsync(roomMessage(w.keys, 'ep_web'), { repository: w.repository, registered: w.registered, now: NOW, stream: w.stream });
  assert.equal(result.status, 202);
  assert.deepEqual(byEndpoint(w.frames), ['ep_web', 'ep_web2']);
  for (const [, frame] of w.frames) assert.deepEqual(frame, { room_id: 'room_1', room_seq: 1, changed: 'messages' });
});

test('a duplicate accept sends no second frame', async () => {
  const w = await world();
  const envelope = roomMessage(w.keys, 'ep_web');
  await acceptEnvelopeAsync(envelope, { repository: w.repository, registered: w.registered, now: NOW, stream: w.stream });
  w.frames.length = 0;
  await acceptEnvelopeAsync(envelope, { repository: w.repository, registered: w.registered, now: NOW, stream: w.stream });
  assert.equal(w.frames.length, 0);
});

test('a rollback after the notify point sends nothing', async () => {
  const w = await world();
  w.repository.resetAgentTurns = async () => { throw new Error('boom'); };
  const result = await acceptEnvelopeAsync(roomMessage(w.keys, 'ep_web'), { repository: w.repository, registered: w.registered, now: NOW, stream: w.stream });
  assert.notEqual(result.status, 202);
  assert.equal(w.frames.length, 0);
});

test('emitRoomEvent sends after its transaction commits and nothing when it rolls back', async () => {
  const w = await world();
  const args = { identity: w.system, repository: w.repository, room: w.room, body: { kind: 'router_decision', endpoint_ids: ['ep_claude'], reason: 'r' }, now: NOW, inboxDepthLimit: 100, registered: w.registered, stream: w.stream };
  await w.repository.withTransaction(async (client) => {
    await emitRoomEvent({ ...args, client, idempotencyKey: 'evt_a' });
    assert.equal(w.frames.length, 0, 'nothing is sent inside the transaction');
  });
  assert.deepEqual(byEndpoint(w.frames), ['ep_web', 'ep_web2']);
  w.frames.length = 0;
  await assert.rejects(w.repository.withTransaction(async (client) => {
    await emitRoomEvent({ ...args, client, idempotencyKey: 'evt_b' });
    throw new Error('rollback');
  }));
  assert.equal(w.frames.length, 0);
});

test('adding and removing a member sends a members frame without room_seq', async () => {
  const w = await world();
  w.registered.set('ep_web3', { owner_id: 'usr_chris', status: 'active', kind: 'human' });
  const principals = { 'Bearer web': { endpoint_id: 'ep_web', owner_id: 'usr_chris', human_id: 'usr_chris' } };
  const server = createRelayServer({ registry: w.registered, repository: w.repository, stream: w.stream, authenticate: async (request) => principals[request.headers.authorization] ?? null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const post = (path, body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: 'Bearer web' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(payload);
  });
  try {
    assert.equal(await post('/v1/rooms/room_1/members', { endpoint_id: 'ep_web3' }), 201);
    assert.deepEqual(byEndpoint(w.frames), ['ep_web', 'ep_web2', 'ep_web3']);
    for (const [, frame] of w.frames) assert.deepEqual(frame, { room_id: 'room_1', changed: 'members' });
    w.frames.length = 0;
    assert.equal(await post('/v1/rooms/room_1/members/ep_web3/remove'), 200);
    assert.deepEqual(byEndpoint(w.frames), ['ep_web', 'ep_web2']);
    for (const [, frame] of w.frames) assert.deepEqual(frame, { room_id: 'room_1', changed: 'members' });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

function p2pIdentity(keyPair) {
  return {
    keys: { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey },
    public_key_pem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }),
    private_key_pem: keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function realBuilder(w, onPersisted, now = NOW) {
  return createAcceptOptionsBuilder({
    registered: w.registered, request_id: undefined, now: now ?? undefined, repository: w.repository, relayDomain: undefined, persist: undefined,
    federationMode: undefined, federationIdentity: undefined, fetchImpl: undefined, stream_seq: undefined, resendMetrics: undefined,
    logger: undefined, onPersisted, systemIdentity: w.system, stream: w.stream,
  });
}

async function addRouter(w) {
  w.registered.set('ep_router', { owner_id: 'usr_chris', status: 'active', kind: 'agent', key_id: 'key_ep_router', public_key: crypto.generateKeyPairSync('ed25519').publicKey });
  await w.repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_router', role: 'member', responseMode: 'router', addedByHumanId: 'usr_chris', now: NOW });
}

// The router is not called directly from acceptEnvelopeAsync: an unmentioned human
// message makes room dispatch create one delivery for the router member
// (room-dispatch.mjs, needs systemIdentity from the shared options). One router
// delivery is "the router invoked once" at this layer.
const routerDeliveries = (persistedRows) => persistedRows.flatMap((p) => p.roomDeliveries ?? []).filter((d) => d.endpoint_id === 'ep_router');

test('a room message accepted over p2p sends room.updated to human members and routes once', async () => {
  const w = await world();
  await addRouter(w);
  const persistedRows = [];
  const buildAcceptOptions = realBuilder(w, async ({ persisted }) => { persistedRows.push(persisted); });
  const senderHost = await createP2pHost({ identity: p2pIdentity(w.keys.ep_web), listenAddrs: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
  const receiverHost = await createP2pHost({ identity: p2pIdentity(crypto.generateKeyPairSync('ed25519')), listenAddrs: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
  try {
    wireDataProtocol(receiverHost, { registered: w.registered, buildAcceptOptions });
    const response = await sendEnvelope(senderHost, receiverHost.getMultiaddrs()[0], roomMessage(w.keys, 'ep_web'));
    assert.equal(response.status, 202, JSON.stringify(response.body));
    assert.deepEqual(byEndpoint(w.frames), ['ep_web', 'ep_web2']);
    assert.equal(routerDeliveries(persistedRows).length, 1, 'router delivery created once');
  } finally {
    await senderHost.stop();
    await receiverHost.stop();
  }
});

// AgentMail's enqueue can only build task.request envelopes from ep_ingress
// (build-task-request.mjs), never room.message, so room.updated and router
// delivery cannot be reached through it. Closest real behavior: the shared
// builder's options reach acceptEnvelopeAsync (onPersisted runs once, with the
// room stream present and silent for a non-room.message).
test('an AgentMail-ingested envelope is accepted with the shared builder options and sends no room frame', async () => {
  const w = await world();
  const triage = createIdentity({ ownerId: 'usr_operator', endpointId: 'ep_triage', kind: 'agent' });
  const ingressIdentity = createIdentity({ ownerId: 'usr_operator', endpointId: 'ep_ingress', kind: 'agent' });
  for (const id of [triage, ingressIdentity]) w.registered.set(id.endpoint_id, { ...id, public_key: crypto.createPublicKey(id.public_key_pem), status: 'active' });
  const persistedRows = [];
  const buildAcceptOptions = realBuilder(w, async ({ persisted }) => { persistedRows.push(persisted); }, null); // wall clock: ingress envelopes are stamped now
  const ingress = createAgentMailIngress({
    config: { inboxMappings: [{ providerInboxId: 'inbox_a', endpointId: 'ep_triage', webhookSecretId: 'wh_triage', workflowPolicy: ['trm'] }], senderAllowlist: ['operator@example.test'], forwardingDomain: 'agentmail.test', limits: { maxMessageBytes: 1024 * 1024, maxAttachmentBytes: 1024, maxParserSeconds: 2, maxQueueDepth: 100, senderPerMinute: 10 }, forwardingTokenRefs: {} },
    provider: { async verifyWebhook() { return { eventId: 'evt_room', messageId: 'msg_room', from: 'operator@example.test', authenticatedSender: true, senderAuthentication: 'synthetic-pass', alias: `triage+trm+${'A'.repeat(22)}@agentmail.test`, normalizedInstruction: 'Handle synthetic input', attachments: [] }; } },
    secretStore: createAgentMailSecretStore({ generation: 'g1', withWebhookSecret: (_id, callback) => callback({ withValue: (fn) => fn('synthetic-webhook') }), withForwardingToken: (_alias, callback) => callback({ withValue: (fn) => fn('A'.repeat(22)) }) }),
    ingress: { endpoint: { endpoint_id: ingressIdentity.endpoint_id, owner_id: ingressIdentity.owner_id }, ownerId: ingressIdentity.owner_id, signer: { ...identityKeys(ingressIdentity), keyId: ingressIdentity.key_id } },
    repository: w.repository, registry: w.registered,
    relayOptions: { buildAcceptOptions },
  });
  const result = await ingress.handleWebhook({ rawBody: '{}', headers: {}, inboxId: 'inbox_a' });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.equal(persistedRows.length, 1, 'shared builder onPersisted ran once');
  assert.equal(w.frames.length, 0, 'a non-room.message sends no room.updated');
});
