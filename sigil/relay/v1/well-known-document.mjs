import crypto from 'node:crypto';

// Builds this relay's `.well-known/sigil` discovery document from a single
// designated endpoint identity (the shape `sigil/cli/identity.mjs` produces).
// Pure -- no filesystem, no network. The output shape is fixed by the
// consumer's `validatePeerDocument` in peer-discovery.mjs.
//
// `publicKey` is the base64url encoding of the DER SPKI form of the identity's
// Ed25519 public key. It is byte-identical to the string an operator would
// pass to `sigil peer add --public-key <key>` for a manual static cross-pin,
// and round-trips via
//   crypto.createPublicKey({ key: Buffer.from(s, 'base64url'), format: 'der', type: 'spki' }).
export function buildPeerDocument({ identity, domain, endpoint, wsEndpoint } = {}) {
  if (!domain || typeof domain !== 'string') {
    throw new Error('buildPeerDocument: domain is required');
  }
  if (!endpoint || typeof endpoint !== 'string') {
    throw new Error('buildPeerDocument: endpoint is required');
  }
  if (!identity?.public_key_pem) {
    throw new Error('buildPeerDocument: identity has no public key (public_key_pem)');
  }

  let keyObject;
  try {
    keyObject = crypto.createPublicKey(identity.public_key_pem);
  } catch (error) {
    throw new Error(`buildPeerDocument: identity public key is unreadable: ${error.message}`);
  }
  if (keyObject.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `buildPeerDocument: identity key is ${keyObject.asymmetricKeyType ?? 'unknown'}, expected Ed25519`,
    );
  }

  const publicKey = keyObject.export({ type: 'spki', format: 'der' }).toString('base64url');
  const relay = { endpoint };
  if (wsEndpoint) relay.ws_endpoint = wsEndpoint;

  return {
    domain,
    relay,
    keys: [{ kid: identity.key_id, alg: 'Ed25519', publicKey }],
  };
}
