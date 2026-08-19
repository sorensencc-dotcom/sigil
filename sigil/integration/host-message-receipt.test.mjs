import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createIdentity, identityKeys } from '../cli/identity.mjs';
import { createMemoryRepository } from '../cli/memory-repository.mjs';
import { LocalOutbox } from '../connectors/v1/local-outbox.mjs';
import { RelayClient } from '../connectors/v1/relay-client.mjs';
import { createRelayServer } from '../relay/v1/http-server.mjs';
import { hashBearerToken } from '../relay/v1/transport-auth.mjs';

test('real HTTP relay send, inbox reconcile, and acknowledgement round-trip', async () => {
  const sender = createIdentity({ ownerId: 'usr_codex', endpointId: 'ep_codex', kind: 'human' });
  const recipient = createIdentity({ ownerId: 'usr_antigravity', endpointId: 'ep_antigravity', kind: 'human' });
  const senderKeys = identityKeys(sender);
  const recipientKeys = identityKeys(recipient);
  const endpoint = (identity, keys) => ({ owner_id: identity.owner_id, endpoint_id: identity.endpoint_id, key_id: identity.key_id, kind: identity.kind, status: 'active', public_key: keys.publicKey });
  const senderEndpoint = endpoint(sender, senderKeys);
  const recipientEndpoint = endpoint(recipient, recipientKeys);
  const server = createRelayServer({
    registry: new Map([[sender.endpoint_id, senderEndpoint], [recipient.endpoint_id, recipientEndpoint]]),
    repository: createMemoryRepository(),
    tokenHashes: new Map([[hashBearerToken(sender.relay_token), sender.endpoint_id], [hashBearerToken(recipient.relay_token), recipient.endpoint_id]]),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const relayUrl = `http://127.0.0.1:${server.address().port}`;
  const message = { protocol: 'sigil/1', message_id: `msg_${crypto.randomUUID()}`, conversation_id: `conv_${crypto.randomUUID()}`, message_type: 'chat.message', recipient: recipientEndpoint, body: { text: 'test round-trip' }, context_refs: [], capabilities: [], correlation_id: null, idempotency_key: `send_${crypto.randomUUID()}`, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString() };
  try {
    const accepted = await new RelayClient({ baseUrl: relayUrl, token: sender.relay_token }).sendEnvelope(new LocalOutbox({ privateKey: senderKeys.privateKey, endpoint: senderEndpoint }).queue(message).envelope);
    assert.equal(accepted.duplicate, false);
    const recipientRelay = new RelayClient({ baseUrl: relayUrl, token: recipient.relay_token });
    const page = await recipientRelay.reconcileInbox('');
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].envelope.body.text, 'test round-trip');
    await recipientRelay.acknowledge(page.items[0].delivery_id);
    assert.equal((await recipientRelay.reconcileInbox('')).items.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});