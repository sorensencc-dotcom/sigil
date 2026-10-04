// sigil/relay/v1/accept-envelope.rooms.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

const NOW = new Date('2026-10-02T12:01:00.000Z');

function world() {
  const keys = Object.fromEntries(['ep_web', 'ep_web2', 'ep_claude', 'ep_codex', 'ep_stranger'].map((id) => [id, crypto.generateKeyPairSync('ed25519')]));
  const registered = new Map(Object.entries(keys).map(([id, pair]) => [id, { owner_id: 'usr_chris', status: 'active', key_id: `key_${id}`, public_key: pair.publicKey }]));
  const repository = createMemoryRepository({ registry: registered });
  return { keys, registered, repository };
}

function roomEnvelope(keys, senderId, overrides = {}) {
  const envelope = {
    protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: 'room_1', message_type: 'room.message',
    sender: { endpoint_id: senderId, owner_id: 'usr_chris' }, broadcast_scope: { conversation_id: 'room_1' },
    body: { text: 'hello room' }, context_refs: [], capabilities: [], correlation_id: null,
    idempotency_key: `idem_${crypto.randomUUID()}`, created_at: '2026-10-02T12:00:00.000Z', expires_at: '2026-10-02T13:00:00.000Z',
    signature: { algorithm: 'Ed25519', key_id: `key_${senderId}`, value: '' },
    ...overrides,
  };
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys[senderId].privateKey).toString('base64url');
  return envelope;
}

async function roomWithMembers(repository) {
  await repository.createRoom({ conversationId: 'room_1', workspaceId: 'ws_usr_chris', name: 'build', createdByHumanId: 'usr_chris', ownerEndpointId: 'ep_web', now: NOW });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_web2', role: 'member', responseMode: null, addedByHumanId: 'usr_chris', now: NOW });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_claude', role: 'member', responseMode: 'joins', addedByHumanId: 'usr_chris', now: NOW });
  await repository.addRoomMember({ conversationId: 'room_1', endpointId: 'ep_codex', role: 'member', responseMode: 'mentions_only', addedByHumanId: 'usr_chris', now: NOW });
}

test('a member room.message is accepted, sequenced, and fanned out to humans; a mention invokes an agent', async () => {
  const { keys, registered, repository } = world();
  await roomWithMembers(repository);
  let persistedEvent;
  const first = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_web', { body: { text: 'hello room', mentions: ['ep_claude'] } }), { repository, registered, now: NOW, onPersisted: async (event) => { persistedEvent = event; } });
  assert.equal(first.status, 202);
  assert.deepEqual(persistedEvent.persisted.fanout.map((f) => f.endpoint_id), ['ep_web2'], 'agents get no fan-out');
  assert.deepEqual(persistedEvent.persisted.roomDeliveries.map((d) => d.endpoint_id), ['ep_claude']);
  const secondEnvelope = roomEnvelope(keys, 'ep_claude', { body: { text: 'reply', thread_root_id: first.body.message_id } });
  const second = await acceptEnvelopeAsync(secondEnvelope, { repository, registered, now: NOW });
  assert.equal(second.status, 202);
  const history = await repository.listRoomMessages('room_1', 0n, 100);
  assert.deepEqual(history.map((m) => m.room_seq), ['1', '2']);
  assert.equal(history[1].canonical_bytes, signedBytes(secondEnvelope).toString('base64url'), 'history carries the signed bytes the accept path stored');
  assert.equal((await repository.listInbox('ep_claude')).length, 1, 'the invoked agent holds its one delivery');
  assert.equal((await repository.listInbox('ep_codex')).length, 0);
  assert.equal((await repository.listInbox('ep_web')).length, 1, 'the agent reply reached the human');
  assert.equal((await repository.listInbox('ep_web2')).length, 2);
});

test('a non-member is refused and nothing is persisted', async () => {
  const { keys, registered, repository } = world();
  await roomWithMembers(repository);
  const result = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_stranger'), { repository, registered, now: NOW });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'ROUTE_NOT_AUTHORIZED');
  assert.deepEqual(await repository.listRoomMessages('room_1', 0n, 100), []);
});

test('a direct envelope into a room conversation is refused', async () => {
  const { keys, registered, repository } = world();
  await roomWithMembers(repository);
  const result = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_web', { broadcast_scope: undefined, recipient: { endpoint_id: 'ep_claude', owner_id: 'usr_chris' } }), { repository, registered, now: NOW });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'ROUTE_NOT_AUTHORIZED');
});

test('room.message outside a room conversation is refused', async () => {
  const { keys, registered, repository } = world();
  const result = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_web', { conversation_id: 'conv_direct', broadcast_scope: undefined, recipient: { endpoint_id: 'ep_claude', owner_id: 'usr_chris' } }), { repository, registered, now: NOW });
  assert.equal(result.body.code, 'INVALID_ENVELOPE');
});

test('a room message replayed with the same idempotency key is a duplicate, not a new room_seq', async () => {
  const { keys, registered, repository } = world();
  await roomWithMembers(repository);
  const envelope = roomEnvelope(keys, 'ep_web');
  await acceptEnvelopeAsync(envelope, { repository, registered, now: NOW });
  const replay = await acceptEnvelopeAsync(envelope, { repository, registered, now: NOW });
  assert.equal(replay.body.duplicate, true);
  assert.deepEqual((await repository.listRoomMessages('room_1', 0n, 100)).map((m) => m.room_seq), ['1']);
});

test('a non-member with a forged signature gets the signature error, not a membership answer', async () => {
  const { keys, registered, repository } = world();
  await roomWithMembers(repository);
  const envelope = roomEnvelope(keys, 'ep_stranger');
  envelope.signature.value = crypto.sign(null, signedBytes(envelope), keys.ep_web.privateKey).toString('base64url');
  const result = await acceptEnvelopeAsync(envelope, { repository, registered, now: NOW });
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'INVALID_SIGNATURE');
  assert.deepEqual(await repository.listRoomMessages('room_1', 0n, 100), []);
});

// Sync-forward world: a local sender, a pinned peer relay, federationMode 'sync',
// and one approved decision for a high-risk capability on the exact envelope
// the test sends. Built from the setup in accept-envelope.federation-sync.test.mjs.
async function syncForwardWorldWithApprovedHighRiskAction() {
  const senderId = 'ep_codex@a.example';
  const senderKeys = crypto.generateKeyPairSync('ed25519');
  const relayKeys = crypto.generateKeyPairSync('ed25519');
  const registered = new Map([[senderId, { owner_id: 'usr_chris', status: 'active', key_id: 'key_codex', public_key: senderKeys.publicKey }]]);
  const repository = createMemoryRepository({ registry: registered });
  await repository.upsertPeer({ domain: 'b.example', relayUrl: 'https://relay.b.example', wsUrl: null, keys: [], trustMode: 'pinned', now: NOW });
  const options = {
    repository,
    registered,
    relayDomain: 'a.example',
    federationMode: 'sync',
    federationIdentity: { private_key_pem: relayKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), key_id: 'relay-a-key-1' },
    now: NOW,
    request_id: 'req_room_fwd',
    postForwardImpl: async () => ({ ok: true, status: 202 }),
  };
  let decision = null;
  return {
    repository,
    senderId,
    options,
    async signedForwardEnvelope(overrides = {}) {
      const envelope = {
        protocol: 'sigil/1',
        message_id: `msg_${crypto.randomUUID()}`,
        conversation_id: 'conv_fed_1',
        message_type: 'chat.message',
        sender: { endpoint_id: senderId, owner_id: 'usr_chris' },
        recipient: { endpoint_id: 'ep_claude@b.example', owner_id: 'usr_remote_owner' },
        body: { text: 'hello across the relay boundary' },
        context_refs: [],
        capabilities: ['sigil.approval/request'],
        correlation_id: null,
        idempotency_key: `send_${crypto.randomUUID()}`,
        created_at: '2026-10-02T12:00:00.000Z',
        expires_at: '2026-10-02T13:00:00.000Z',
        signature: { algorithm: 'Ed25519', key_id: 'key_codex', value: '' },
        ...overrides,
      };
      envelope.signature.value = crypto.sign(null, signedBytes(envelope), senderKeys.privateKey).toString('base64url');
      decision = await repository.recordApprovalDecision({
        endpointId: senderId,
        actionHash: crypto.createHash('sha256').update(signedBytes(envelope)).digest('hex'),
        expiresAt: '2026-10-02T14:00:00.000Z',
        now: NOW,
      });
      return envelope;
    },
    approvalState() { return decision.status; },
  };
}

test('a sync-forwarded high-risk envelope aimed at a room is refused without consuming its approval', async () => {
  const world = await syncForwardWorldWithApprovedHighRiskAction();
  await world.repository.createRoom({ conversationId: 'room_fwd', workspaceId: 'ws_usr_chris', name: 'fwd', createdByHumanId: 'usr_chris', ownerEndpointId: world.senderId, now: NOW });
  const envelope = await world.signedForwardEnvelope({ conversation_id: 'room_fwd' });
  const result = await acceptEnvelopeAsync(envelope, world.options);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'ROUTE_NOT_AUTHORIZED');
  assert.equal(world.approvalState(), 'approved', 'the approval is still unconsumed');
});

test('fan-out skips a revoked member endpoint', async () => {
  const { keys, registered, repository } = world();
  await roomWithMembers(repository);
  registered.get('ep_web2').status = 'revoked';
  let persistedEvent;
  const result = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_web'), { repository, registered, now: NOW, onPersisted: async (event) => { persistedEvent = event; } });
  assert.equal(result.status, 202);
  assert.deepEqual(persistedEvent.persisted.fanout, []);
  assert.deepEqual(repository._debugGetAuditEvents().filter((e) => e.event_type === 'room.delivery_skipped').map((e) => [e.endpoint_id, e.reason]), [['ep_web2', 'endpoint_inactive']]);
});

test('fan-out skips a member whose inbox is at the depth limit and audits the skip', async () => {
  const { keys, registered, repository } = world();
  await roomWithMembers(repository);
  await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_web'), { repository, registered, now: NOW, inboxDepthLimit: 1 });
  let persistedEvent;
  const second = await acceptEnvelopeAsync(roomEnvelope(keys, 'ep_web'), { repository, registered, now: NOW, inboxDepthLimit: 1, onPersisted: async (event) => { persistedEvent = event; } });
  assert.equal(second.status, 202, 'the room message is still accepted');
  assert.deepEqual(persistedEvent.persisted.fanout, []);
  const skips = repository._debugGetAuditEvents().filter((e) => e.event_type === 'room.delivery_skipped');
  assert.deepEqual(skips.map((e) => [e.endpoint_id, e.reason]).sort(), [['ep_web2', 'inbox_full']]);
});
