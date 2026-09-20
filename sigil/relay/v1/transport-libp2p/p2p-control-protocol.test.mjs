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
