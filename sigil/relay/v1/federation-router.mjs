import crypto from 'node:crypto';
import { parseFederatedId } from './federated-id.mjs';
import { checkRecipientLocality, reject } from './validate-envelope.mjs';
import { canonicalJsonBytes } from './jcs.mjs';
import { postDirectory, readPeerCode } from './federation-directory-client.mjs';

export { readPeerCode };

// Origin-side routing decision (design §"New module"). Async only because the
// pinned-peer lookup is a repository call; every other branch is pure string
// work. The accept transaction awaits this in place of checkRecipientLocality.
export async function decideRoute(envelope, { relayDomain, federationMode, getPeerByDomain, storedFederationHop = false } = {}) {
  if (!envelope?.recipient) return { action: 'local' };

  // Routing disabled: preserve today's exact behavior. checkRecipientLocality
  // throws MALFORMED_FEDERATED_ID / RECIPIENT_NOT_LOCAL or returns silently.
  if (!relayDomain || !federationMode) {
    checkRecipientLocality(envelope, relayDomain);
    return { action: 'local' };
  }

  let recipientId;
  try {
    recipientId = parseFederatedId(envelope.recipient.endpoint_id);
  } catch {
    throw reject('MALFORMED_FEDERATED_ID', `recipient.endpoint_id "${envelope.recipient.endpoint_id}" is not a well-formed federated id, required by this relay's --domain configuration`, { recipient_endpoint_id: envelope.recipient.endpoint_id });
  }

  if (recipientId.domain.toLowerCase() === String(relayDomain).toLowerCase()) {
    return { action: 'local' };
  }

  // Defense-in-depth: decideRoute is not normally reached for a stored
  // federated-inbound envelope (it is delivered straight to a local inbox and
  // never re-submitted as an authenticated local send), but if a future path
  // ever routes one, stop it here.
  if (storedFederationHop === true) {
    return { action: 'reject', code: 'FEDERATION_HOP_EXCEEDED', details: { recipientDomain: recipientId.domain } };
  }

  const peer = await getPeerByDomain(recipientId.domain);
  if (!peer) {
    return { action: 'reject', code: 'PEER_NOT_PINNED', details: { recipientDomain: recipientId.domain } };
  }
  return { action: 'forward', peer, recipientDomain: recipientId.domain };
}

export function buildForwardRequest(envelope, { originDomain, senderKey, senderOwnerId, now } = {}) {
  const body = {
    origin_domain: originDomain,
    envelope,
    sender_key: { kid: senderKey.kid, alg: senderKey.alg ?? 'Ed25519', publicKey: senderKey.publicKey },
    sender_owner_id: senderOwnerId,
    forwarded_at: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
  return { body, canonicalBytes: canonicalJsonBytes(body) };
}

export function signForwardRequest(canonicalBytes, identity) {
  const privateKey = crypto.createPrivateKey(identity.private_key_pem);
  const signature = crypto.sign(null, canonicalBytes, privateKey).toString('base64url');
  return { signature, keyId: identity.key_id };
}

// Alias: the directory client and its callers use signRelayRequest; #3's call
// sites keep signForwardRequest. Both names resolve to one implementation.
export const signRelayRequest = signForwardRequest;

// Envelope forwarding is one directory POST among four. Delegate to the shared
// postDirectory so the HTTP call, the 2xx/4xx/5xx classification, the timeout,
// the redirect: 'error' guard and the bounded peer-error-code read all live in
// exactly one place. Behaviour-preserving: identical URL, headers and outcomes.
export async function postForward(peer, canonicalBytes, { signature, keyId }, { fetchImpl = fetch } = {}) {
  return postDirectory(peer, '/v1/federation/envelopes', canonicalBytes, { signature, keyId }, { fetchImpl });
}

export function verifyRelaySignature(parsedBody, { signature, keyId, peer } = {}) {
  try {
    const entry = (peer?.keys ?? []).find((k) => k.kid === keyId);
    if (!entry) return false;
    const publicKey = crypto.createPublicKey({ key: Buffer.from(entry.publicKey, 'base64url'), format: 'der', type: 'spki' });
    return crypto.verify(null, canonicalJsonBytes(parsedBody), publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}
