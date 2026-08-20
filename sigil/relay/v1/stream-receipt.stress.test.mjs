import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createIdentity, identityKeys } from '../../cli/identity.mjs';
import { LocalOutbox } from '../../connectors/v1/local-outbox.mjs';
import { RelayClient } from '../../connectors/v1/relay-client.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';
import { createRelayServer } from './http-server.mjs';
import { createStreamServer } from './stream-server.mjs';
import { hashBearerToken } from './transport-auth.mjs';

const BURST_SIZE = 64;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function openSocket(url, endpointIdOrHeaders) {
  const headers = typeof endpointIdOrHeaders === 'string' ? { 'x-endpoint-id': endpointIdOrHeaders } : endpointIdOrHeaders;
  const socket = new WebSocket(url, { headers });
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function collectMessages(socket, count) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const onMessage = (raw) => {
      try {
        messages.push(JSON.parse(raw));
        if (messages.length === count) finish(resolve, messages);
      } catch (error) {
        finish(reject, error);
      }
    };
    const onError = (error) => finish(reject, error);
    const finish = (settle, value) => {
      socket.off('message', onMessage);
      socket.off('error', onError);
      settle(value);
    };
    socket.on('message', onMessage);
    socket.on('error', onError);
  });
}

function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once('close', resolve);
    socket.close();
  });
}

function endpoint(identity, keys) {
  return {
    owner_id: identity.owner_id,
    endpoint_id: identity.endpoint_id,
    key_id: identity.key_id,
    kind: identity.kind,
    status: 'active',
    public_key: keys.publicKey,
  };
}

function message(sender, recipient, index) {
  const createdAt = new Date(Date.now() - index).toISOString();
  return {
    protocol: 'sigil/1',
    message_id: `msg_stream_receipt_${index}`,
    conversation_id: 'conv_stream_receipt_stress',
    message_type: 'chat.message',
    sender,
    recipient,
    body: { text: `stress-${index}` },
    context_refs: [],
    capabilities: [],
    correlation_id: null,
    idempotency_key: `idem_stream_receipt_${index}`,
    created_at: createdAt,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  };
}

test('stream delivers concurrent notifications and sender receipts without cross-talk', async () => {
  const httpServer = http.createServer();
  const stream = createStreamServer({
    server: httpServer,
    authenticate: (request) => request.headers['x-endpoint-id'],
  });
  const port = await listen(httpServer);
  const senderSocket = await openSocket(`ws://127.0.0.1:${port}/v1/stream`, 'ep_codex');
  const recipientSocket = await openSocket(`ws://127.0.0.1:${port}/v1/stream`, 'ep_claude');

  try {
    const senderMessages = collectMessages(senderSocket, BURST_SIZE);
    const recipientMessages = collectMessages(recipientSocket, BURST_SIZE);
    const results = await Promise.all(Array.from({ length: BURST_SIZE }, (_, index) => Promise.resolve().then(() => [
      stream.notify('ep_claude', `del_burst_${index}`),
      stream.notifyReceipt('ep_codex', {
        message_id: `msg_burst_${index}`,
        delivery_id: `del_burst_${index}`,
        state: 'delivered',
        at: '2026-08-19T00:00:00.000Z',
      }),
    ])));

    assert.deepEqual(results.flat(), Array.from({ length: BURST_SIZE * 2 }, () => true));
    const [receipts, notifications] = await Promise.all([senderMessages, recipientMessages]);
    assert.deepEqual(new Set(receipts.map((event) => event.delivery_id)), new Set(Array.from({ length: BURST_SIZE }, (_, index) => `del_burst_${index}`)));
    assert.deepEqual(new Set(notifications.map((event) => event.delivery_id)), new Set(Array.from({ length: BURST_SIZE }, (_, index) => `del_burst_${index}`)));
    assert.ok(receipts.every((event) => event.type === 'delivery.receipt'));
    assert.ok(notifications.every((event) => event.type === 'delivered'));
  } finally {
    await closeSocket(senderSocket);
    await closeSocket(recipientSocket);
    await stream.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test('reconnecting recipient reconciles concurrent missed deliveries and acknowledges each with receipts', async () => {
  const sender = createIdentity({ ownerId: 'usr_codex', endpointId: 'ep_codex', kind: 'human' });
  const recipient = createIdentity({ ownerId: 'usr_claude', endpointId: 'ep_claude', kind: 'human' });
  const senderKeys = identityKeys(sender);
  const recipientKeys = identityKeys(recipient);
  const senderEndpoint = endpoint(sender, senderKeys);
  const recipientEndpoint = endpoint(recipient, recipientKeys);
  const repository = createMemoryRepository();
  const streamHttpServer = http.createServer();
  const stream = createStreamServer({
    server: streamHttpServer,
    tokenHashes: new Map([
      [hashBearerToken(sender.relay_token), sender.endpoint_id],
      [hashBearerToken(recipient.relay_token), recipient.endpoint_id],
    ]),
  });
  const relayServer = createRelayServer({
    registry: new Map([[sender.endpoint_id, senderEndpoint], [recipient.endpoint_id, recipientEndpoint]]),
    repository,
    tokenHashes: new Map([
      [hashBearerToken(sender.relay_token), sender.endpoint_id],
      [hashBearerToken(recipient.relay_token), recipient.endpoint_id],
    ]),
    stream,
  });
  const streamPort = await listen(streamHttpServer);
  const relayPort = await listen(relayServer);
  const streamUrl = `ws://127.0.0.1:${streamPort}/v1/stream`;
  const relayUrl = `http://127.0.0.1:${relayPort}`;
  const senderSocket = await openSocket(streamUrl, { authorization: 'Bearer ' + sender.relay_token });
  const disconnectedRecipient = await openSocket(streamUrl, { authorization: 'Bearer ' + recipient.relay_token });
  await closeSocket(disconnectedRecipient);
  let reconnectedRecipient;

  try {
    const senderRelay = new RelayClient({ baseUrl: relayUrl, token: sender.relay_token });
    const recipientRelay = new RelayClient({ baseUrl: relayUrl, token: recipient.relay_token });
    const outbox = new LocalOutbox({ privateKey: senderKeys.privateKey, endpoint: senderEndpoint });
    const envelopes = Array.from({ length: BURST_SIZE }, (_, index) => outbox.queue(message(senderEndpoint, recipientEndpoint, index)).envelope);
    const deliveredReceipts = collectMessages(senderSocket, BURST_SIZE);
    const accepted = await Promise.all(envelopes.map((envelope) => senderRelay.sendEnvelope(envelope)));
    assert.equal(accepted.length, BURST_SIZE);
    assert.equal(accepted.filter((result) => result.duplicate).length, 0);
    const delivered = await deliveredReceipts;
    assert.deepEqual(new Set(delivered.map((event) => event.message_id)), new Set(envelopes.map((envelope) => envelope.message_id)));
    assert.ok(delivered.every((event) => event.state === 'delivered'));

    reconnectedRecipient = await openSocket(streamUrl, { authorization: 'Bearer ' + recipient.relay_token });
    const page = await recipientRelay.reconcileInbox('');
    assert.equal(page.items.length, BURST_SIZE);
    assert.deepEqual(new Set(page.items.map((item) => item.message_id)), new Set(envelopes.map((envelope) => envelope.message_id)));

    const acknowledgedReceipts = collectMessages(senderSocket, BURST_SIZE);
    await Promise.all(page.items.map((item) => recipientRelay.acknowledge(item.delivery_id)));
    const acknowledged = await acknowledgedReceipts;
    assert.deepEqual(new Set(acknowledged.map((event) => event.delivery_id)), new Set(page.items.map((item) => item.delivery_id)));
    assert.ok(acknowledged.every((event) => event.state === 'acknowledged'));
    await closeSocket(reconnectedRecipient);
  } finally {
    await closeSocket(reconnectedRecipient);
    await closeSocket(senderSocket);
    await stream.close();
    await new Promise((resolve) => streamHttpServer.close(resolve));
    await new Promise((resolve) => relayServer.close(resolve));
  }
});
