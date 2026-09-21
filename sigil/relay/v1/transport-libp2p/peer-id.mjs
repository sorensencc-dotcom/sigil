// PeerId derivation for sigil's existing Ed25519 identities. Uses the JWK
// export to get the raw 32-byte public key (no manual SPKI-DER slicing --
// see plan Task 2 rationale) and @libp2p/crypto's Ed25519 PeerId factory so
// the derivation matches exactly what a connecting libp2p peer computes
// from the same public key during the Noise handshake.
import { peerIdFromPublicKey as libp2pPeerIdFromRaw } from '@libp2p/peer-id';
import { publicKeyFromRaw } from '@libp2p/crypto/keys';
import crypto from 'node:crypto';

function rawEd25519PublicKeyBytes(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') {
    throw new Error(`Expected an Ed25519 public key, got kty=${jwk.kty} crv=${jwk.crv}`);
  }
  return Buffer.from(jwk.x, 'base64url');
}

export async function peerIdFromPublicKey(publicKey) {
  const raw = rawEd25519PublicKeyBytes(publicKey);
  const key = publicKeyFromRaw(raw);
  return libp2pPeerIdFromRaw(key);
}

export async function peerIdFromIdentity(identity) {
  const publicKey = crypto.createPublicKey(identity.public_key_pem);
  return peerIdFromPublicKey(publicKey);
}
