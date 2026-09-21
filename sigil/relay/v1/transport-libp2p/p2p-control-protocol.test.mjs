import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createP2pHost } from './p2p-host.mjs';
import { wireControlProtocol, ping } from './p2p-control-protocol.mjs';

function makeIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }), private_key_pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

test('ping over /sigil/control/1.0.0 gets a pong from the remote peer', async () => {
  const hostA = await createP2pHost({ identity: makeIdentity(), listenAddrs: ['/ip4/127.0.0.1/tcp/0'] });
  const hostB = await createP2pHost({ identity: makeIdentity(), listenAddrs: ['/ip4/127.0.0.1/tcp/0'] });
  try {
    wireControlProtocol(hostB);
    const [addrB] = hostB.getMultiaddrs();
    const response = await ping(hostA, addrB);
    assert.equal(response.pong, true);
    assert.equal(response.peer_id, hostB.peerId.toString());
  } finally {
    await hostA.stop();
    await hostB.stop();
  }
});

test('m2: a peer that dials and never sends a frame gets the stream closed by the remote (server-side read timeout), not left open indefinitely', async () => {
  const hostA = await createP2pHost({ identity: makeIdentity(), listenAddrs: ['/ip4/127.0.0.1/tcp/0'] });
  const hostB = await createP2pHost({ identity: makeIdentity(), listenAddrs: ['/ip4/127.0.0.1/tcp/0'] });
  try {
    wireControlProtocol(hostB, { readTimeoutMs: 100 });
    const [addrB] = hostB.getMultiaddrs();
    // Dial the protocol directly and never write anything -- unlike ping(),
    // which always sends a frame immediately. The server side's read
    // timeout, not this client, is what must close the stream.
    const rawStream = await hostA.dialProtocol(addrB, '/sigil/control/1.0.0');
    // 100ms read timeout vs. an 8s wait cap: generous margin for the full
    // repo suite's observed CPU contention under many concurrent libp2p
    // hosts (the sibling CLI p2p test has been seen to take ~7.6s for a
    // startup that's <2s in isolation).
    const remoteClosed = await new Promise((resolve) => {
      rawStream.addEventListener('close', () => resolve(true), { once: true });
      setTimeout(() => resolve(false), 8000);
    });
    assert.equal(remoteClosed, true);
  } finally {
    await hostA.stop();
    await hostB.stop();
  }
});
