// End-to-end integration test for Tasks 4-6 (p2p-host, p2p-data-protocol,
// p2p-control-protocol) working together: black-box, in-process. Matches
// spec §10 Phase-2 gate "two or more independent processes exchange
// messages over libp2p" and "mDNS discovery works" -- the latter (and the
// Kademlia cross-network gate) is NOT covered here; see the Task 9
// STATUS.md note this task's brief requires (Step 5) for the manual
// verification that still needs real separate OS processes/machines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createP2pHost } from './p2p-host.mjs';
import { wireDataProtocol, sendEnvelope } from './p2p-data-protocol.mjs';
import { wireControlProtocol, ping } from './p2p-control-protocol.mjs';
import { canonicalJsonBytes } from '../jcs.mjs';

function makeIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { keys: { publicKey, privateKey }, public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }), private_key_pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

function signEnvelope(envelope, privateKey, keyId) {
  const unsigned = { ...envelope };
  delete unsigned.signature;
  const value = crypto.sign(null, canonicalJsonBytes(unsigned), privateKey).toString('base64');
  return { ...envelope, signature: { algorithm: 'Ed25519', key_id: keyId, value } };
}

test('two hosts complete data delivery and a control heartbeat over the same node pair', async () => {
  const senderIdentity = makeIdentity();
  const receiverIdentity = makeIdentity();
  const senderHost = await createP2pHost({ identity: senderIdentity, listenAddrs: ['/ip4/127.0.0.1/tcp/0'] });
  const receiverHost = await createP2pHost({ identity: receiverIdentity, listenAddrs: ['/ip4/127.0.0.1/tcp/0'] });
  try {
    wireControlProtocol(senderHost);
    wireControlProtocol(receiverHost);
    const registry = new Map([['ep_sender', { owner_id: 'usr_sender', endpoint_id: 'ep_sender', key_id: 'key_sender', kind: 'agent', status: 'active', public_key: senderIdentity.keys.publicKey }]]);
    const writes = [];
    wireDataProtocol(receiverHost, { registered: registry, persist: async (row) => { writes.push(row); return { message_id: row.message_id, duplicate: false }; } });

    const [receiverAddr] = receiverHost.getMultiaddrs();

    const pong = await ping(senderHost, receiverAddr);
    assert.equal(pong.pong, true);

    // Deviation from the brief's Step 1 sample: a fixed expires_at of
    // 2099-01-01 is more than validate-envelope.mjs's 24h MAX_LIFETIME_MS
    // ahead of created_at (now), so validateEnvelope rejects with
    // MESSAGE_EXPIRED (422) instead of accepting. Use created_at + 1h,
    // matching p2p-data-protocol.test.mjs's existing pattern.
    const envelope = signEnvelope({
      protocol: 'sigil/1', message_id: 'msg_it_01', conversation_id: 'conv_it_01', message_type: 'task.request',
      sender: { owner_id: 'usr_sender', endpoint_id: 'ep_sender', kind: 'agent' },
      recipient: { owner_id: 'usr_receiver', endpoint_id: 'ep_receiver' },
      body: { task_id: 'task_it_01', instruction: 'ping', success_criteria: [], dependencies: [], deadline: '2099-01-01T00:00:00Z' },
      context_refs: [], capabilities: [], correlation_id: null,
      idempotency_key: 'send_it_01', expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), created_at: new Date().toISOString()
    }, senderIdentity.keys.privateKey, 'key_sender');

    const dataResponse = await sendEnvelope(senderHost, receiverAddr, envelope);
    assert.equal(dataResponse.status, 202);
    assert.equal(writes.length, 1);
    // acceptEnvelopeAsync's legacy (no-repository) path calls
    // `options.persist?.({ envelope, ...result })` (accept-envelope.mjs) --
    // the row is the envelope plus validateEnvelope's result fields
    // (accepted, canonical_hash, endpoint_id, message_id), not a flattened
    // sender_endpoint_id. Confirmed by logging writes[0] during Step 1.
    assert.equal(writes[0].envelope.sender.endpoint_id, 'ep_sender');
  } finally {
    await senderHost.stop();
    await receiverHost.stop();
  }
});

test('sendEnvelope is rejected with PEER_IDENTITY_MISMATCH when the dialing peer is not the registered key for the claimed sender', async () => {
  const senderIdentity = makeIdentity(); // registered under ep_sender
  const impersonatorIdentity = makeIdentity(); // real Noise identity of the dialing host
  const receiverIdentity = makeIdentity();
  const impersonatorHost = await createP2pHost({ identity: impersonatorIdentity, listenAddrs: ['/ip4/127.0.0.1/tcp/0'] });
  const receiverHost = await createP2pHost({ identity: receiverIdentity, listenAddrs: ['/ip4/127.0.0.1/tcp/0'] });
  try {
    const registry = new Map([['ep_sender', { owner_id: 'usr_sender', endpoint_id: 'ep_sender', key_id: 'key_sender', kind: 'agent', status: 'active', public_key: senderIdentity.keys.publicKey }]]);
    const writes = [];
    wireDataProtocol(receiverHost, { registered: registry, persist: async (row) => { writes.push(row); return { message_id: row.message_id, duplicate: false }; } });

    const [receiverAddr] = receiverHost.getMultiaddrs();

    // Envelope claims sender.endpoint_id: 'ep_sender' (registered to
    // senderIdentity's key), but is dialed from impersonatorHost, whose
    // Noise-authenticated connection.remotePeer is derived from
    // impersonatorIdentity, not senderIdentity -- the PeerId mismatch this
    // is testing for. Signed with the impersonator's own key: the mismatch
    // check runs (and throws) before acceptEnvelopeAsync/signature
    // verification is ever reached, so the signature's validity against
    // ep_sender's registered key is irrelevant here.
    const envelope = signEnvelope({
      protocol: 'sigil/1', message_id: 'msg_it_02', conversation_id: 'conv_it_02', message_type: 'task.request',
      sender: { owner_id: 'usr_sender', endpoint_id: 'ep_sender', kind: 'agent' },
      recipient: { owner_id: 'usr_receiver', endpoint_id: 'ep_receiver' },
      body: { task_id: 'task_it_02', instruction: 'ping', success_criteria: [], dependencies: [], deadline: '2099-01-01T00:00:00Z' },
      context_refs: [], capabilities: [], correlation_id: null,
      idempotency_key: 'send_it_02', expires_at: '2099-01-01T00:00:00Z', created_at: new Date().toISOString()
    }, impersonatorIdentity.keys.privateKey, 'key_sender');

    const dataResponse = await sendEnvelope(impersonatorHost, receiverAddr, envelope);
    assert.equal(dataResponse.status, 400);
    assert.equal(dataResponse.body.code, 'PEER_IDENTITY_MISMATCH');
    assert.equal(writes.length, 0);
  } finally {
    await impersonatorHost.stop();
    await receiverHost.stop();
  }
});
