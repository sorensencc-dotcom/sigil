function peerError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

// Mirrors oidc-client.mjs's outboundFetchOptions(): a fixed timeout and a
// hard no-follow redirect policy so a hung/redirecting peer can't hold the
// request open or redirect trust to an unvetted URL. AbortSignal.timeout is
// called fresh per request -- a shared signal fires once and stays aborted.
function outboundFetchOptions() {
  return { signal: AbortSignal.timeout(5000), redirect: 'error' };
}

// http/ws acceptance gates on NODE_ENV !== 'production', which is fail-open
// by CLI default (an operator shell rarely sets NODE_ENV=production). This
// is plan-sanctioned (see plan's Global Constraints) rather than an oversight
// -- tracked as a deliberate decision, not silently inherited. Revisit if
// sigil ever ships a production default NODE_ENV.
export function isValidEndpointUrl(url) {
  if (typeof url !== 'string') return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && process.env.NODE_ENV !== 'production';
}

// Separate from isValidEndpointUrl because ws_endpoint is a WebSocket URL,
// not an HTTP one -- wss:/ws: are the correct schemes, not https:/http:.
// (Caught by Codex outside-voice: the original single validator applied to
// both fields would reject the plan's own valid wss:// test fixture.)
export function isValidWsEndpointUrl(url) {
  if (typeof url !== 'string') return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol === 'wss:') return true;
  return parsed.protocol === 'ws:' && process.env.NODE_ENV !== 'production';
}

export function isValidKeyEntry(key) {
  return typeof key?.kid === 'string' && key.kid.length > 0 && key.alg === 'Ed25519' && typeof key.publicKey === 'string' && key.publicKey.length > 0;
}

export function validatePeerDocument(data, { expectedDomain } = {}) {
  if (data === null || typeof data !== 'object') {
    throw peerError('Malformed .well-known/sigil document: not an object', 'PEER_MALFORMED_RESPONSE', {});
  }
  if (expectedDomain !== undefined && data.domain !== expectedDomain) {
    throw peerError(`.well-known/sigil domain mismatch: expected "${expectedDomain}", got "${data.domain}"`, 'PEER_DOMAIN_MISMATCH', { domain: expectedDomain, responseDomain: data.domain });
  }
  if (!isValidEndpointUrl(data.relay?.endpoint)) {
    throw peerError(`Invalid relay.endpoint in .well-known/sigil document for "${data.domain}"`, 'PEER_INVALID_ENDPOINT', { domain: data.domain });
  }
  if (data.relay.ws_endpoint !== undefined && !isValidWsEndpointUrl(data.relay.ws_endpoint)) {
    throw peerError(`Invalid relay.ws_endpoint in .well-known/sigil document for "${data.domain}"`, 'PEER_INVALID_ENDPOINT', { domain: data.domain });
  }
  if (!Array.isArray(data.keys) || data.keys.length === 0) {
    throw peerError(`.well-known/sigil document for "${data.domain}" has no keys`, 'PEER_NO_KEYS', { domain: data.domain });
  }
  for (const key of data.keys) {
    if (!isValidKeyEntry(key)) {
      throw peerError(`.well-known/sigil document for "${data.domain}" has an invalid key entry`, 'PEER_INVALID_KEY', { domain: data.domain });
    }
  }
  return { domain: data.domain, relayUrl: data.relay.endpoint, wsUrl: data.relay.ws_endpoint ?? null, keys: data.keys };
}

export async function discoverPeer(domain, { fetchImpl = fetch } = {}) {
  const { parseDomain } = await import('./federated-id.mjs');
  parseDomain(domain); // throws INVALID_DOMAIN_SYNTAX / INVALID_PORT before any fetch or repository call
  let response;
  try {
    response = await fetchImpl(`https://${domain}/.well-known/sigil`, outboundFetchOptions());
  } catch {
    throw peerError(`Failed to reach https://${domain}/.well-known/sigil`, 'PEER_DISCOVERY_FAILED', { domain });
  }
  if (!response.ok) {
    throw peerError(`.well-known/sigil for "${domain}" returned HTTP ${response.status}`, 'PEER_DISCOVERY_FAILED', { domain, status: response.status });
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw peerError(`Malformed .well-known/sigil response for "${domain}"`, 'PEER_MALFORMED_RESPONSE', { domain });
  }
  // Ensure the parsed JSON is a non-null object, not a primitive or null literal
  if (typeof data !== 'object' || data === null) {
    throw peerError(`Malformed .well-known/sigil response for "${domain}"`, 'PEER_MALFORMED_RESPONSE', { domain });
  }
  return validatePeerDocument(data, { expectedDomain: domain });
}

// Structured comparison, not a delimiter-joined string -- kid/publicKey are
// untrusted response data, and a naive `${kid}:${publicKey}` join could let
// two distinct key sets collide (or a mismatched set compare equal) if either
// field ever contained the join delimiter. (Caught by Codex outside-voice.)
function sameKeySet(a, b) {
  if (a.length !== b.length) return false;
  const normalize = (keys) => [...keys].map((k) => ({ kid: k.kid, alg: k.alg, publicKey: k.publicKey })).sort((x, y) => (x.kid < y.kid ? -1 : x.kid > y.kid ? 1 : 0));
  const na = normalize(a);
  const nb = normalize(b);
  return na.every((k, i) => k.kid === nb[i].kid && k.alg === nb[i].alg && k.publicKey === nb[i].publicKey);
}

function auditPayload(discovered, extra = {}) {
  return { relayUrl: discovered.relayUrl, keys: discovered.keys, ...extra };
}

export async function resolvePeer(domain, repository, { fetchImpl = fetch, now = new Date() } = {}) {
  const { parseDomain } = await import('./federated-id.mjs');
  parseDomain(domain);
  const existing = await repository.getPeerByDomain(domain);
  if (existing && existing.trustMode === 'static') return existing;

  const discovered = await discoverPeer(domain, { fetchImpl });

  if (!existing) {
    const record = await repository.upsertPeer({ domain, relayUrl: discovered.relayUrl, wsUrl: discovered.wsUrl, keys: discovered.keys, trustMode: 'tofu', now });
    await repository.recordAuditEvent({ eventType: 'peer.tofu_pinned', subjectId: domain, objectType: 'peer_relay', objectId: domain, outcome: 'accepted', payload: auditPayload(discovered), now });
    return record;
  }

  // No grace-accept for ANY unauthenticated field -- keys, relayUrl, and
  // wsUrl are all just data in an unauthenticated HTTP response. A public
  // key being "still present" proves nothing about who controls the domain
  // right now, and an endpoint is exactly as unauthenticated as a key --
  // treating them differently (audit-only for endpoint, reject for keys) was
  // an inconsistent security posture (eng review + Codex outside-voice,
  // 2026-08-25). Any change to keys, relayUrl, or wsUrl is rejected exactly
  // like a full mismatch; the operator must run
  // `sigil peer rotate <domain> --confirm` to accept it.
  const keysChanged = !sameKeySet(existing.keys, discovered.keys);
  const endpointChanged = existing.relayUrl !== discovered.relayUrl || existing.wsUrl !== discovered.wsUrl;
  if (keysChanged || endpointChanged) {
    await repository.recordAuditEvent({ eventType: 'peer.key_mismatch_rejected', subjectId: domain, objectType: 'peer_relay', objectId: domain, outcome: 'rejected', payload: { pinnedKeys: existing.keys, fetchedKeys: discovered.keys, pinnedRelayUrl: existing.relayUrl, fetchedRelayUrl: discovered.relayUrl, pinnedWsUrl: existing.wsUrl, fetchedWsUrl: discovered.wsUrl, keysChanged, endpointChanged }, now });
    throw peerError(`Peer "${domain}" changed: run "sigil peer rotate ${domain} --confirm" to accept it`, 'PEER_KEY_MISMATCH', { domain, pinnedKeys: existing.keys, fetchedKeys: discovered.keys, keysChanged, endpointChanged, pinnedRelayUrl: existing.relayUrl, fetchedRelayUrl: discovered.relayUrl, pinnedWsUrl: existing.wsUrl, fetchedWsUrl: discovered.wsUrl });
  }

  // Nothing changed -- a silent re-confirmation, no new audit event.
  return repository.upsertPeer({ domain, relayUrl: discovered.relayUrl, wsUrl: discovered.wsUrl, keys: discovered.keys, trustMode: 'tofu', now });
}

export async function rotatePeer(domain, repository, { fetchImpl = fetch, now = new Date() } = {}) {
  const { parseDomain } = await import('./federated-id.mjs');
  parseDomain(domain);
  const existing = await repository.getPeerByDomain(domain);
  const discovered = await discoverPeer(domain, { fetchImpl });
  const record = await repository.upsertPeer({ domain, relayUrl: discovered.relayUrl, wsUrl: discovered.wsUrl, keys: discovered.keys, trustMode: 'tofu', now });
  // A static pin force-overwritten via rotate silently downgrades to tofu
  // trust (matches the brief: rotate force-overwrites regardless of any
  // existing pin). Record the downgrade in the audit trail so it isn't
  // invisible after the fact.
  const downgradedFromStatic = existing?.trustMode === 'static';
  await repository.recordAuditEvent({ eventType: 'peer.rotated', subjectId: domain, objectType: 'peer_relay', objectId: domain, outcome: 'accepted', payload: auditPayload(discovered, { forced: true, previousTrustMode: existing?.trustMode ?? null, downgradedFromStatic }), now });
  return record;
}
