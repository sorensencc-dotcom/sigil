import crypto from 'node:crypto';
import { parseFederatedId } from './federated-id.mjs';
import { checkRecipientLocality, reject } from './validate-envelope.mjs';
import { canonicalJsonBytes } from './jcs.mjs';

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

const PEER_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const PEER_BODY_READ_CAP = 4 * 1024;

export async function postForward(peer, canonicalBytes, { signature, keyId }, { fetchImpl = fetch } = {}) {
  const url = peer.relayUrl.replace(/\/+$/, '') + '/v1/federation/envelopes';
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
    throw Object.assign(new Error(`forward transport failed: ${error.message}`), { code: 'FORWARD_TRANSPORT_FAILED', cause: error });
  }

  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
  if (res.status >= 500) {
    throw Object.assign(new Error(`peer relay returned ${res.status}`), { code: 'FORWARD_TRANSPORT_FAILED', status: res.status });
  }
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
  return peerCode ? { ok: false, status: res.status, peerCode } : { ok: false, status: res.status };
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
