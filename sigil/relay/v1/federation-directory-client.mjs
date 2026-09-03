import crypto from 'node:crypto';
import { canonicalJsonBytes } from './jcs.mjs';

// Origin-side (outbound) half of the cross-federation directory protocol
// (design §"New module: federation-directory-client.mjs"). Pure builders for
// the three relay-to-relay directory messages plus one I/O function,
// postDirectory, which mirrors federation-router.mjs's postForward. postForward
// is refactored to delegate here so there is exactly one HTTP + outcome-
// classification implementation and one peer-error-code reader.

const isoOf = (now) => (now instanceof Date ? now : new Date(now)).toISOString();

export function buildRedemptionRequest({ linkRef, code, redeemer, redeemerDomain, now }) {
  const body = {
    link_ref: linkRef,
    code,
    redeemer: { owner_id: redeemer.owner_id, endpoint_id: redeemer.endpoint_id },
    redeemer_domain: redeemerDomain,
    requested_at: isoOf(now),
  };
  return { body, canonicalBytes: canonicalJsonBytes(body) };
}

export function buildConfirmationRequest({ linkRef, now }) {
  const body = { link_ref: linkRef, confirmed_at: isoOf(now) };
  return { body, canonicalBytes: canonicalJsonBytes(body) };
}

export function buildRevocationRequest({ linkRef, now }) {
  const body = { link_ref: linkRef, revoked_at: isoOf(now) };
  return { body, canonicalBytes: canonicalJsonBytes(body) };
}

// Ed25519 over the exact canonicalBytes with the origin relay's federation
// identity key. keyId is echoed so the caller can populate Sigil-Relay-Key-Id.
export function signRelayRequest(canonicalBytes, identity) {
  const privateKey = crypto.createPrivateKey(identity.private_key_pem);
  const signature = crypto.sign(null, canonicalBytes, privateKey).toString('base64url');
  return { signature, keyId: identity.key_id };
}

const PEER_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const PEER_BODY_READ_CAP = 4 * 1024;

// Shared 4xx peer-error-code reader. Lifted verbatim from federation-router.mjs
// (the `let peerCode; ... ` block previously inline in postForward). Both
// postForward and postDirectory call this so there is one implementation of the
// bounded, shape-checked read.
export async function readPeerCode(res) {
  // 4xx: bounded, shape-checked *streaming* read of the peer's error code.
  // Never buffer the whole response -- a hostile pinned peer could otherwise
  // force multi-GB buffering. Read res.body chunk by chunk; the instant the
  // accumulated byte count exceeds PEER_BODY_READ_CAP, cancel the reader and
  // give up on peerCode (design §172: 4 KiB read cap).
  let peerCode;
  const bodyStream = res.body;
  if (bodyStream && typeof bodyStream[Symbol.asyncIterator] === 'function') {
    const parts = [];
    let total = 0;
    let overCap = false;
    try {
      for await (const chunk of bodyStream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > PEER_BODY_READ_CAP) { overCap = true; break; }
        parts.push(buf);
      }
    } catch { overCap = true; }
    if (overCap) {
      try { await bodyStream.cancel?.(); } catch { /* reader already closed */ }
    } else {
      try {
        const parsed = JSON.parse(Buffer.concat(parts).toString('utf8'));
        if (parsed && typeof parsed.code === 'string' && PEER_CODE_RE.test(parsed.code)) peerCode = parsed.code;
      } catch { /* non-JSON / empty: peerCode stays undefined */ }
    }
  } else if (typeof res.text === 'function') {
    // No streamable body (e.g. a mock or a HEAD-style response): fall back to
    // a single bounded text read, still capped by bytes.
    try {
      const text = await res.text();
      if (typeof text === 'string' && Buffer.byteLength(text) <= PEER_BODY_READ_CAP) {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.code === 'string' && PEER_CODE_RE.test(parsed.code)) peerCode = parsed.code;
      }
    } catch { /* non-JSON / oversize / read error: peerCode stays undefined */ }
  }
  return peerCode;
}

// The only paths postDirectory will POST to. The target URL is always derived
// from peer.relayUrl + one of these -- never from a message field.
const DIRECTORY_PATHS = new Set([
  '/v1/federation/directory/redemptions',
  '/v1/federation/directory/confirmations',
  '/v1/federation/directory/revocations',
  '/v1/federation/envelopes',
]);

export async function postDirectory(peer, path, canonicalBytes, { signature, keyId }, { fetchImpl = fetch } = {}) {
  if (!DIRECTORY_PATHS.has(path)) {
    throw Object.assign(new Error(`postDirectory: unexpected path ${path}`), { code: 'FORWARD_TRANSPORT_FAILED' });
  }
  // new URL(relativePath, base): base normalised with a trailing slash and the
  // path made relative (leading slash stripped) so any base path segment
  // (e.g. https://host/relay) is preserved -- behaviour-identical to
  // postForward's old `relayUrl.replace(/\/+$/, '') + path`.
  const base = peer.relayUrl.endsWith('/') ? peer.relayUrl : peer.relayUrl + '/';
  const url = new URL(path.replace(/^\/+/, ''), base).toString();
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      body: canonicalBytes,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: {
        'content-type': 'application/json',
        'Sigil-Relay-Signature': signature,
        'Sigil-Relay-Key-Id': keyId,
      },
    });
  } catch (error) {
    throw Object.assign(new Error(`directory post transport failed: ${error.message}`), { code: 'FORWARD_TRANSPORT_FAILED', cause: error });
  }

  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
  if (res.status >= 500) {
    throw Object.assign(new Error(`peer relay returned ${res.status}`), { code: 'FORWARD_TRANSPORT_FAILED', status: res.status });
  }
  const peerCode = await readPeerCode(res);
  return peerCode ? { ok: false, status: res.status, peerCode } : { ok: false, status: res.status };
}
