import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createP2pHost } from './p2p-host.mjs';
import { wireDataProtocol, sendEnvelope } from './p2p-data-protocol.mjs';
import { canonicalJsonBytes } from '../jcs.mjs';

function makeIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    keys: { publicKey, privateKey },
    public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }),
    private_key_pem: privateKey.export({ type: 'pkcs8', format: 'pem' })
  };
}

function signEnvelope(envelope, privateKey) {
  const unsigned = { ...envelope };
  delete unsigned.signature;
  const bytes = canonicalJsonBytes(unsigned);
  const value = crypto.sign(null, bytes, privateKey).toString('base64');
  return { ...envelope, signature: { algorithm: 'Ed25519', key_id: envelope.sender.key_id, value } };
}

test('inbound envelope over /sigil/data/1.0.0 reaches acceptEnvelopeAsync and returns 202', async () => {
  const senderIdentity = makeIdentity();
  const receiverIdentity = makeIdentity();
  const senderHost = await createP2pHost({ identity: senderIdentity, listenAddrs: ['/ip4/127.0.0.1/tcp/0'] });
  const receiverHost = await createP2pHost({ identity: receiverIdentity, listenAddrs: ['/ip4/127.0.0.1/tcp/0'] });
  try {
    const registry = new Map([
      ['ep_sender', { owner_id: 'usr_sender', endpoint_id: 'ep_sender', key_id: 'key_sender', kind: 'agent', status: 'active', public_key: senderIdentity.keys.publicKey }]
    ]);
    const writes = [];
    wireDataProtocol(receiverHost, {
      registry,
      registered: registry,
      relayDomain: undefined,
      federationMode: undefined,
      persist: async (row) => { writes.push(row); return { message_id: row.message_id, duplicate: false }; }
    });

    const envelope = signEnvelope({
      protocol: 'sigil/1',
      message_id: 'msg_p2p_01',
      conversation_id: 'conv_p2p_01',
      message_type: 'task.request',
      sender: { owner_id: 'usr_sender', endpoint_id: 'ep_sender', kind: 'agent', key_id: 'key_sender' },
      recipient: { owner_id: 'usr_receiver', endpoint_id: 'ep_receiver' },
      body: { task_id: 'task_p2p_01', instruction: 'ping', success_criteria: [], dependencies: [], deadline: '2099-01-01T00:00:00Z' },
      context_refs: [], capabilities: [], correlation_id: null,
      idempotency_key: 'send_p2p_01', expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), created_at: new Date().toISOString()
    }, senderIdentity.keys.privateKey);

    const [receiverAddr] = receiverHost.getMultiaddrs();
    const response = await sendEnvelope(senderHost, receiverAddr, envelope);
    assert.equal(response.status, 202);
    assert.equal(response.body.code, 'ACCEPTED');
    assert.equal(writes.length, 1);
  } finally {
    await senderHost.stop();
    await receiverHost.stop();
  }
});

test('m5: an unexpected (non-reject()) error thrown before acceptEnvelopeAsync is reached does not leak its message to the remote peer', async () => {
  const senderIdentity = makeIdentity();
  const receiverIdentity = makeIdentity();
  const senderHost = await createP2pHost({ identity: senderIdentity, listenAddrs: ['/ip4/127.0.0.1/tcp/0'] });
  const receiverHost = await createP2pHost({ identity: receiverIdentity, listenAddrs: ['/ip4/127.0.0.1/tcp/0'] });
  try {
    // A .get() that throws a plain Error (no .code) simulates an unexpected
    // failure in the sender-registry lookup, as opposed to a known
    // validate-envelope.mjs reject() -- this is the code path
    // wireDataProtocol's own catch block controls (the failure surface
    // scoped by TODOS.md m5). acceptEnvelopeAsync's *own* internal error
    // responses are a separate, HTTP-transport-shared concern (see the
    // TODOS.md entry this test's finding was split from).
    const registered = { get: () => { throw new Error('internal connection string: postgres://sensitive-detail'); } };
    wireDataProtocol(receiverHost, {
      registered,
      relayDomain: undefined,
      federationMode: undefined,
      persist: async () => ({ message_id: 'unused', duplicate: false })
    });

    const envelope = signEnvelope({
      protocol: 'sigil/1',
      message_id: 'msg_p2p_leak_01',
      conversation_id: 'conv_p2p_leak_01',
      message_type: 'task.request',
      sender: { owner_id: 'usr_sender', endpoint_id: 'ep_sender', kind: 'agent', key_id: 'key_sender' },
      recipient: { owner_id: 'usr_receiver', endpoint_id: 'ep_receiver' },
      body: { task_id: 'task_p2p_leak_01', instruction: 'ping', success_criteria: [], dependencies: [], deadline: '2099-01-01T00:00:00Z' },
      context_refs: [], capabilities: [], correlation_id: null,
      idempotency_key: 'send_p2p_leak_01', expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), created_at: new Date().toISOString()
    }, senderIdentity.keys.privateKey);

    const [receiverAddr] = receiverHost.getMultiaddrs();
    const response = await sendEnvelope(senderHost, receiverAddr, envelope);
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'INVALID_ENVELOPE');
    assert.equal(response.body.message, 'Envelope rejected');
    assert.doesNotMatch(JSON.stringify(response), /postgres:\/\/sensitive-detail/);
  } finally {
    await senderHost.stop();
    await receiverHost.stop();
  }
});
