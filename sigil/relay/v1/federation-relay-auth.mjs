import crypto from 'node:crypto';
import { canonicalJsonBytes } from './jcs.mjs';

function fail(code, httpStatus, message) {
  return Object.assign(new Error(message), { code, httpStatus });
}

// Shared inbound relay-signature verification (design "New module:
// federation-relay-auth.mjs"). The acting relay's identity comes from WHICH
// pinned key signed the request -- never a body field -- so bodies that carry
// no domain (confirmation, revocation) authenticate exactly like redemption.
export async function verifyInboundRelayRequest(rawBody, headers, { getPeerByKid } = {}) {
  // 1. Parse.
  let parsedBody;
  try {
    parsedBody = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) throw new Error('not an object');
  } catch {
    throw fail('INVALID_FEDERATION_REQUEST', 400, 'Request body is not a JSON object');
  }

  // 2. Resolve the acting relay from the signing kid.
  const kid = headers['sigil-relay-key-id'];
  const signature = headers['sigil-relay-signature'];
  if (typeof kid !== 'string' || kid.length === 0) {
    throw fail('RELAY_SIGNATURE_INVALID', 401, 'Sigil-Relay-Key-Id header is required');
  }
  const peerRecord = await getPeerByKid(kid);
  if (!peerRecord) {
    throw fail('PEER_NOT_TRUSTED', 403, 'No pinned peer relay published the signing key id');
  }

  // 3. Verify the signature over re-canonicalized bytes. kid and publicKey must
  //    belong to the same pinned key entry.
  const entry = (peerRecord.keys ?? []).find((k) => k.kid === kid);
  let verified = false;
  if (entry && typeof signature === 'string' && signature.length > 0) {
    try {
      const pub = crypto.createPublicKey({ key: Buffer.from(entry.publicKey, 'base64url'), format: 'der', type: 'spki' });
      verified = crypto.verify(null, canonicalJsonBytes(parsedBody), pub, Buffer.from(signature, 'base64url'));
    } catch {
      verified = false;
    }
  }
  if (!verified) {
    throw fail('RELAY_SIGNATURE_INVALID', 401, 'Sigil-Relay-Signature failed verification against the pinned peer key');
  }

  // 4. Return. Each handler asserts its own body/row consistency against originDomain.
  return { ok: true, originDomain: peerRecord.domain, peerRecord, parsedBody };
}
