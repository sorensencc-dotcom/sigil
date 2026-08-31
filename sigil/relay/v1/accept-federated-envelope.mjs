import crypto from 'node:crypto';
import { parseDomain, parseFederatedId } from './federated-id.mjs';
import { verifyRelaySignature } from './federation-router.mjs';
import { signedBytes } from './validate-envelope.mjs';

function respond(status, code, message, options, details = {}) {
  return { status, body: { request_id: options.request_id ?? null, code, message, details } };
}

function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }

// POST /v1/federation/envelopes handler (design §"Receiving side"). Runs the
// checks in order; the first failure returns immediately.
export async function acceptFederatedEnvelope(body, headers, options) {
  const { repository } = options;

  // --- Check 1: structural ---
  if (!body || typeof body !== 'object') return respond(400, 'INVALID_FEDERATION_REQUEST', 'Request body must be an object', options);
  const { origin_domain: originDomain, envelope, sender_key: senderKey, sender_owner_id: senderOwnerId } = body;
  try { parseDomain(originDomain); } catch { return respond(400, 'INVALID_FEDERATION_REQUEST', 'origin_domain is not a well-formed domain', options); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return respond(400, 'INVALID_FEDERATION_REQUEST', 'envelope must be an object', options);
  if (!senderKey || !isNonEmptyString(senderKey.kid) || senderKey.alg !== 'Ed25519' || !isNonEmptyString(senderKey.publicKey)) {
    return respond(400, 'INVALID_FEDERATION_REQUEST', 'sender_key must be { kid, alg: "Ed25519", publicKey }', options);
  }
  try { parseFederatedId(senderOwnerId); } catch { return respond(400, 'INVALID_FEDERATION_REQUEST', 'sender_owner_id is not a well-formed federated id', options); }

  // --- Check 2: origin pinned (receiver's own peer directory) ---
  const peer = await repository.getPeerByDomain(originDomain);
  if (!peer) return respond(403, 'PEER_NOT_TRUSTED', 'Origin domain is not pinned in this relay\'s peer directory', options, { origin_domain: originDomain });

  // --- Check 3: relay signature over the JCS body bytes ---
  const relaySignature = headers['sigil-relay-signature'];
  const relayKeyId = headers['sigil-relay-key-id'];
  if (!isNonEmptyString(relaySignature) || !isNonEmptyString(relayKeyId) || !verifyRelaySignature(body, { signature: relaySignature, keyId: relayKeyId, peer })) {
    return respond(401, 'RELAY_SIGNATURE_INVALID', 'Sigil-Relay-Signature failed verification against the pinned peer key', options);
  }

  // --- Check 4: sender domain === origin_domain ---
  let senderDomain;
  try { senderDomain = parseFederatedId(envelope.sender?.endpoint_id).domain; }
  catch { return respond(400, 'INVALID_FEDERATION_REQUEST', 'envelope.sender.endpoint_id is not a well-formed federated id', options); }
  if (senderDomain.toLowerCase() !== originDomain.toLowerCase()) {
    return respond(403, 'SENDER_DOMAIN_FOREIGN', 'envelope.sender domain does not equal origin_domain', options, { sender_domain: senderDomain, origin_domain: originDomain });
  }

  // --- Check 5: envelope signature against the propagated sender key ---
  let ok = false;
  try {
    const senderPub = crypto.createPublicKey({ key: Buffer.from(senderKey.publicKey, 'base64url'), format: 'der', type: 'spki' });
    const sig = Buffer.from(envelope.signature?.value ?? '', 'base64url');
    ok = sig.length > 0 && crypto.verify(null, signedBytes(envelope), senderPub, sig);
  } catch { ok = false; }
  if (!ok) return respond(401, 'INVALID_SIGNATURE', 'Envelope signature verification failed against sender_key', options);

  // --- Checks 6-10 land in Task 9 ---
  return { status: 202, body: { request_id: options.request_id ?? null, code: 'ACCEPTED_STUB' } };
}
