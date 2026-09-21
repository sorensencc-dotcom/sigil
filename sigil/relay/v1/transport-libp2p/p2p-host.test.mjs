import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createP2pHost } from './p2p-host.mjs';
import { peerIdFromIdentity } from './peer-id.mjs';

function makeIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }),
    private_key_pem: privateKey.export({ type: 'pkcs8', format: 'pem' })
  };
}

test('two hosts dial over loopback TCP and authenticate the remote PeerId via Noise', async () => {
  const identityA = makeIdentity();
  const identityB = makeIdentity();
  const hostA = await createP2pHost({ identity: identityA, listenAddrs: ['/ip4/127.0.0.1/tcp/0'] });
  const hostB = await createP2pHost({ identity: identityB, listenAddrs: ['/ip4/127.0.0.1/tcp/0'] });
  try {
    const expectedPeerIdB = await peerIdFromIdentity(identityB);
    const [addrB] = hostB.getMultiaddrs();
    const connection = await hostA.dial(addrB);
    assert.equal(connection.remotePeer.toString(), expectedPeerIdB.toString());
  } finally {
    await hostA.stop();
    await hostB.stop();
  }
});

test('createP2pHost({ enableDht: true }) starts without throwing (requires the ping service kad-dht depends on)', async () => {
  const identity = makeIdentity();
  const node = await createP2pHost({ identity, enableDht: true });
  try {
    assert.equal(node.status, 'started');
  } finally {
    await node.stop();
  }
});
