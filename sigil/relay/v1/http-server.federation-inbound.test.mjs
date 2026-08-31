import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRelayServer } from './http-server.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { buildForwardRequest, signForwardRequest } from './federation-router.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

const ORIGIN = 'a.example';
const RELAY = 'b.example';
const SERVER_NOW = new Date('2026-08-30T12:00:30.000Z');

// worldWithRecipient mirrors accept-federated-envelope.test.mjs: a memory repo
// seeded with a pinned origin peer plus an active local recipient.
function worldWithRecipient(recipientOwnerId = 'usr_chris@primary.example') {
  const registry = new Map([[`ep_claude@${RELAY}`, { endpoint_id: `ep_claude@${RELAY}`, owner_id: recipientOwnerId, key_id: `key_ep_claude@${RELAY}`, kind: 'agent', status: 'active', public_key: crypto.generateKeyPairSync('ed25519').publicKey }]]);
  const relayKeys = crypto.generateKeyPairSync('ed25519');
  const senderKeys = crypto.generateKeyPairSync('ed25519');
  const relayIdentity = { key_id: 'relay-a-2026-08', private_key_pem: relayKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const relayPub = relayKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const senderPub = senderKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const repo = createMemoryRepository({ registry });
  repo.upsertPeer({ domain: ORIGIN, relayUrl: 'https://a.example/relay', keys: [{ kid: relayIdentity.key_id, alg: 'Ed25519', publicKey: relayPub }], trustMode: 'tofu' });
  return { relayKeys, senderKeys, relayIdentity, relayPub, senderPub, repo, registered: registry };
}

function senderEnvelope(senderPrivateKey, overrides = {}) {
  const base = {
    protocol: 'sigil/1', message_id: 'msg_fed_1', conversation_id: 'conv_1', message_type: 'chat.message',
    sender: { owner_id: 'usr_chris@primary.example', endpoint_id: `ep_codex@${ORIGIN}`, kind: 'agent' },
    recipient: { owner_id: 'usr_chris@primary.example', endpoint_id: `ep_claude@${RELAY}`, kind: 'agent' },
    body: { text: 'hi' }, context_refs: [], capabilities: [], idempotency_key: 'idem_1',
    created_at: '2026-08-30T12:00:00.000Z', expires_at: '2026-08-30T12:10:00.000Z',
    ...overrides,
  };
  const value = crypto.sign(null, signedBytes({ ...base, signature: undefined }), senderPrivateKey).toString('base64url');
  return { ...base, signature: { algorithm: 'Ed25519', key_id: `key_ep_codex@${ORIGIN}`, value } };
}

function forwardPayload(world, envelopeOverrides = {}, opts = {}) {
  const envelope = opts.envelope ?? senderEnvelope(world.senderKeys.privateKey, envelopeOverrides);
  const { body, canonicalBytes } = buildForwardRequest(envelope, {
    originDomain: opts.originDomain ?? ORIGIN,
    senderKey: { kid: `key_ep_codex@${ORIGIN}`, alg: 'Ed25519', publicKey: opts.senderPub ?? world.senderPub },
    senderOwnerId: opts.senderOwnerId ?? 'usr_chris@primary.example',
    now: new Date('2026-08-30T12:00:05.000Z'),
  });
  const { signature, keyId } = signForwardRequest(canonicalBytes, opts.relayIdentity ?? world.relayIdentity);
  return { body, headers: { 'sigil-relay-signature': signature, 'sigil-relay-key-id': keyId } };
}

async function startServer(world, { stream } = {}) {
  const server = createRelayServer({ repository: world.repo, registry: world.registered, relayDomain: RELAY, stream, now: () => SERVER_NOW });
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, port: server.address().port };
}

async function postForward(port, { body, headers }) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/federation/envelopes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('POST /v1/federation/envelopes delivers a signed forward and is idempotent', async () => {
  const world = worldWithRecipient();
  const notifications = [];
  const stream = { notify: (endpointId, messageId) => { notifications.push({ endpointId, messageId }); return true; } };
  const { server, port } = await startServer(world, { stream });
  try {
    const payload = forwardPayload(world);
    const first = await postForward(port, payload);
    assert.equal(first.status, 202);
    assert.equal(first.body.code, 'ACCEPTED');
    assert.equal(first.body.duplicate, false);
    assert.equal((await world.repo.listInbox(`ep_claude@${RELAY}`, '')).length, 1);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].endpointId, `ep_claude@${RELAY}`);

    const second = await postForward(port, payload);
    assert.equal(second.status, 202);
    assert.equal(second.body.duplicate, true);
    assert.equal((await world.repo.listInbox(`ep_claude@${RELAY}`, '')).length, 1);
    assert.equal(notifications.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /v1/federation/envelopes from an unpinned origin → 403 PEER_NOT_TRUSTED', async () => {
  const world = worldWithRecipient();
  const { server, port } = await startServer(world);
  try {
    const payload = forwardPayload(world, {}, { originDomain: 'c.example' });
    const result = await postForward(port, payload);
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'PEER_NOT_TRUSTED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
