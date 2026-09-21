// libp2p node factory. Noise pattern is XX (plan Global Constraints, spec
// §5 fix 2026-09-20) -- @chainsafe/libp2p-noise defaults to XX, so no
// pattern option is passed; if a future libp2p-noise release adds an
// explicit pattern option, set it to 'XX' rather than relying on default.
//
// API deviation from the plan's code sample: the installed libp2p@3.3.11
// removed the `peerId` constructor option in favor of a `privateKey`
// option (a `PrivateKey` instance from `@libp2p/interface`); libp2p
// derives the PeerId from that key itself. To keep the resulting PeerId
// identical to `peerIdFromIdentity()` (Task 2), we build the libp2p
// `PrivateKey` from the same Ed25519 key material (seed + raw public key,
// via `@libp2p/crypto/keys#privateKeyFromRaw`) rather than passing a
// `peerId` directly.
//
// This file also does not call `await node.start()` explicitly --
// `createLibp2p()` defaults its `start` option to `true` and starts the
// node itself before resolving, so an extra `.start()` call here would be
// redundant, not a missing step.
import crypto from 'node:crypto';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { mdns } from '@libp2p/mdns';
import { kadDHT } from '@libp2p/kad-dht';
import { ping } from '@libp2p/ping';
import { privateKeyFromRaw } from '@libp2p/crypto/keys';

function rawEd25519PrivateKeyBytes(identity) {
  const privateKey = crypto.createPrivateKey(identity.private_key_pem);
  const jwk = privateKey.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') {
    throw new Error(`Expected an Ed25519 private key, got kty=${jwk.kty} crv=${jwk.crv}`);
  }
  const seed = Buffer.from(jwk.d, 'base64url');
  const publicKey = Buffer.from(jwk.x, 'base64url');
  return Buffer.concat([seed, publicKey]);
}

function libp2pPrivateKeyFromIdentity(identity) {
  return privateKeyFromRaw(rawEd25519PrivateKeyBytes(identity));
}

export async function createP2pHost({ identity, listenAddrs = ['/ip4/127.0.0.1/tcp/0'], enableMdns = false, enableDht = false }) {
  const privateKey = libp2pPrivateKeyFromIdentity(identity);
  const services = { identify: identify() };
  if (enableMdns) services.mdns = mdns({ serviceTag: '_sam-mesh._tcp.local' });
  // @libp2p/kad-dht requires a registered `@libp2p/ping` service at
  // startup (TODOS.md: "p2p-host.mjs's enableDht: true path throws at
  // startup") -- ping must be registered whenever dht is enabled.
  if (enableDht) {
    services.ping = ping();
    services.dht = kadDHT({ protocol: '/sam/dht/1.0.0', clientMode: false });
  }

  const node = await createLibp2p({
    privateKey,
    addresses: { listen: listenAddrs },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services
  });

  return node;
}
