function invalidToken(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ID_TOKEN' });
}

export async function discoverIssuer(issuer, { fetchImpl = fetch } = {}) {
  if (typeof issuer !== 'string' || !issuer.startsWith('https://')) {
    throw invalidToken('OIDC issuer must be an https:// URL');
  }
  let response;
  try {
    response = await fetchImpl(`${issuer}/.well-known/openid-configuration`);
  } catch {
    throw invalidToken('Failed to reach OIDC discovery endpoint');
  }
  if (!response.ok) throw invalidToken(`OIDC discovery endpoint returned HTTP ${response.status}`);
  let doc;
  try {
    doc = await response.json();
  } catch {
    throw invalidToken('Malformed OIDC discovery document');
  }
  // RFC 8414 SS3.3: the discovery document's own issuer must exactly match
  // the issuer it was requested from -- otherwise a doc served from (or
  // proxied through) an unexpected host could redirect trust to a jwks_uri
  // the caller never vetted.
  if (doc.issuer !== issuer) throw invalidToken('OIDC discovery document issuer mismatch');
  if (typeof doc.jwks_uri !== 'string' || !doc.jwks_uri.startsWith('https://')) {
    throw invalidToken('OIDC discovery document missing a valid https jwks_uri');
  }
  return { jwksUri: doc.jwks_uri };
}

async function fetchJwks(jwksUri, fetchImpl) {
  if (typeof jwksUri !== 'string' || !jwksUri.startsWith('https://')) {
    throw invalidToken('jwks_uri must be an https:// URL');
  }
  let response;
  try {
    response = await fetchImpl(jwksUri);
  } catch {
    throw invalidToken('Failed to reach JWKS endpoint');
  }
  if (!response.ok) throw invalidToken(`JWKS endpoint returned HTTP ${response.status}`);
  let doc;
  try {
    doc = await response.json();
  } catch {
    throw invalidToken('Malformed JWKS document');
  }
  if (!Array.isArray(doc.keys)) throw invalidToken('JWKS document missing a keys array');
  return doc.keys;
}

// Cache keyed by jwksUri (the route resolves jwksUri via discoverIssuer
// first, then calls getKey with that URI). TTL and a per-URI kid-miss
// refetch cooldown bound how often this ever calls out to the network --
// see docs/superpowers/specs/2026-08-23-sigil-real-oidc-login.md's "Cached
// JWKS with rotation refetch" section for the reasoning.
export function createJwksCache({ fetchImpl = fetch, ttlMs = 3600_000, missCooldownMs = 10_000 } = {}) {
  const cache = new Map(); // jwksUri -> { keys, fetchedAt, lastMissRefetchAt }

  async function refetch(jwksUri, now) {
    const keys = await fetchJwks(jwksUri, fetchImpl);
    const entry = { keys, fetchedAt: now.getTime(), lastMissRefetchAt: cache.get(jwksUri)?.lastMissRefetchAt ?? -Infinity };
    cache.set(jwksUri, entry);
    return entry;
  }

  return {
    async getKey(jwksUri, kid, now = new Date()) {
      let entry = cache.get(jwksUri);
      if (!entry || now.getTime() - entry.fetchedAt > ttlMs) {
        entry = await refetch(jwksUri, now);
      }
      let key = entry.keys.find((k) => k.kid === kid);
      if (!key) {
        const cooledDown = now.getTime() - entry.lastMissRefetchAt > missCooldownMs;
        if (cooledDown) {
          entry = await refetch(jwksUri, now);
          entry.lastMissRefetchAt = now.getTime();
          key = entry.keys.find((k) => k.kid === kid);
        }
      }
      return key ?? null;
    }
  };
}
