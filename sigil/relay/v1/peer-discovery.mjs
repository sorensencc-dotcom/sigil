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
  // Self-match, mirroring discoverIssuer's RFC 8414 SS3.3 issuer-match check:
  // without this, a response served from (or proxied through) an unexpected
  // host could redirect trust to an endpoint/keys the caller never vetted.
  if (data.domain !== domain) {
    throw peerError(`.well-known/sigil domain mismatch: expected "${domain}", got "${data.domain}"`, 'PEER_DOMAIN_MISMATCH', { domain, responseDomain: data.domain });
  }
  if (!isValidEndpointUrl(data.relay?.endpoint)) {
    throw peerError(`Invalid relay.endpoint in .well-known/sigil response for "${domain}"`, 'PEER_INVALID_ENDPOINT', { domain });
  }
  if (data.relay.ws_endpoint !== undefined && !isValidWsEndpointUrl(data.relay.ws_endpoint)) {
    throw peerError(`Invalid relay.ws_endpoint in .well-known/sigil response for "${domain}"`, 'PEER_INVALID_ENDPOINT', { domain });
  }
  if (!Array.isArray(data.keys) || data.keys.length === 0) {
    throw peerError(`.well-known/sigil response for "${domain}" has no keys`, 'PEER_NO_KEYS', { domain });
  }
  for (const key of data.keys) {
    if (!isValidKeyEntry(key)) {
      throw peerError(`.well-known/sigil response for "${domain}" has an invalid key entry`, 'PEER_INVALID_KEY', { domain });
    }
  }
  return { domain, relayUrl: data.relay.endpoint, wsUrl: data.relay.ws_endpoint ?? null, keys: data.keys };
}
