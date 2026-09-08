import crypto from 'node:crypto';
import { canonicalJsonBytes } from './jcs.mjs';

function fail(code, httpStatus, message) {
  return Object.assign(new Error(message), { code, httpStatus });
}

const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;

// Audit-payload fragment for a rejected inbound relay request (spec Section 3).
// Every RELAY_REQUEST_STALE rejection must carry the signed_at skew so an
// operator can tell a clock-drift peer from a replay attempt. Shared by both
// inbound relay routes -- the directory routes in http-server.mjs and the
// federated-envelope route -- so neither can drift from the other.
//
// `source` is whatever the call site still has when the verifier threw: the raw
// request bytes/string, or an already-parsed body. Anything unparseable yields
// an empty fragment, so the rejection is still audited, just without a skew.
export function relayRejectSkewPayload(code, source, nowMs) {
  if (code !== 'RELAY_REQUEST_STALE') return {};
  try {
    const body = source && typeof source === 'object' && !Buffer.isBuffer(source)
      ? source
      : JSON.parse(Buffer.isBuffer(source) ? source.toString('utf8') : String(source));
    const skewMs = nowMs - Date.parse(body.signed_at);
    if (Number.isFinite(skewMs)) return { signed_at_skew_seconds: Math.round(skewMs / 1000) };
  } catch { /* unparseable body: report the rejection without a skew */ }
  return {};
}

// Shared inbound relay-signature verification (design "New module:
// federation-relay-auth.mjs"). The acting relay's identity comes from WHICH
// pinned key signed the request -- never a body field -- so bodies that carry
// no domain (confirmation, revocation) authenticate exactly like redemption.
export async function verifyInboundRelayRequest(rawBody, headers, { getPeerByKid, now = new Date(), freshnessMs = 300_000 } = {}) {
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

  // 3b. Freshness: signed_at must parse and sit within +/- freshnessMs of the
  //     verifier's clock. A captured-and-replayed request reads as stale once the
  //     window passes -- this check runs before the nonce-format check.
  //
  // The signature has verified by this point, so the caller IS the pinned peer:
  // every failure below carries `peerRecord` and `parsedBody` so the route can
  // audit the rejection with a real origin_domain and skew instead of nulls.
  const withContext = (error) => Object.assign(error, { peerRecord, parsedBody });
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const signedAtMs = Date.parse(parsedBody.signed_at);
  if (!Number.isFinite(signedAtMs) || Math.abs(nowMs - signedAtMs) > freshnessMs) {
    throw withContext(fail('RELAY_REQUEST_STALE', 401, 'signed_at is missing or outside the accepted freshness window'));
  }

  // 3c. Nonce format: 16 random bytes, base64url, 22 chars. Consumption happens
  //     in the HTTP handler, not here.
  if (typeof parsedBody.nonce !== 'string' || !NONCE_RE.test(parsedBody.nonce)) {
    throw withContext(fail('INVALID_FEDERATION_REQUEST', 400, 'nonce must be 22 base64url characters'));
  }

  // 4. Return. Each handler asserts its own body/row consistency against originDomain.
  return { ok: true, originDomain: peerRecord.domain, peerRecord, parsedBody, nonce: parsedBody.nonce, signedAtMs };
}
