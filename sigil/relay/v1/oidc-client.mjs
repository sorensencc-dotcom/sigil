import crypto from 'node:crypto';

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

const REQUIRED_CLAIMS = ['iss', 'sub', 'email', 'email_verified', 'iat', 'exp'];
const CLOCK_SKEW_SECONDS = 30;
const ALG_TO_KTY = { RS256: 'RSA', ES256: 'EC' };

function jwkToKeyObject(jwk) {
  if (jwk.kty !== 'RSA' && jwk.kty !== 'EC') throw invalidToken(`Unsupported JWK key type: ${jwk.kty}`);
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

export async function verifyRealIdToken(token, { issuer, clientId, jwksCache, jwksUri, now = () => new Date() } = {}) {
  if (typeof token !== 'string') throw invalidToken('ID token must be a string');
  const segments = token.split('.');
  if (segments.length !== 3) throw invalidToken('Malformed compact JWS');
  const [headerSegment, payloadSegment, signatureSegment] = segments;

  let header;
  try { header = JSON.parse(Buffer.from(headerSegment, 'base64url').toString()); }
  catch { throw invalidToken('Malformed JWS header'); }

  const expectedKty = ALG_TO_KTY[header.alg];
  if (!expectedKty) throw invalidToken(`Unsupported or missing alg: ${header.alg}`);

  const jwk = await jwksCache.getKey(jwksUri, header.kid, typeof now === 'function' ? now() : now);
  if (!jwk) throw invalidToken(`No matching JWKS key for kid: ${header.kid}`);
  // Alg/kty confusion guard: a header claiming RS256 must resolve to an
  // RSA key, ES256 to an EC key. Checked before the signature is touched.
  if (jwk.kty !== expectedKty) throw invalidToken('Token alg does not match resolved key type');
  const publicKey = jwkToKeyObject(jwk);

  const signature = Buffer.from(signatureSegment, 'base64url');
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const verifyOptions = header.alg === 'ES256' ? { key: publicKey, dsaEncoding: 'ieee-p1363' } : { key: publicKey };
  let signatureValid;
  try { signatureValid = crypto.verify(header.alg === 'ES256' ? 'sha256' : 'RSA-SHA256', Buffer.from(signingInput), verifyOptions, signature); }
  catch { throw invalidToken('Signature verification failed'); }
  if (!signatureValid) throw invalidToken('Signature verification failed');

  let payload;
  try { payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString()); }
  catch { throw invalidToken('Malformed JWS payload'); }

  for (const claim of REQUIRED_CLAIMS) {
    if (!(claim in payload) || payload[claim] === null || payload[claim] === undefined) {
      throw invalidToken(`Missing required claim: ${claim}`);
    }
  }
  if (payload.email_verified !== true) throw invalidToken('email_verified must be true');
  if (payload.iss !== issuer) throw invalidToken('Unexpected issuer');

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(clientId)) throw invalidToken('aud does not include the expected client_id');
  // azp pins the actual requesting client when an IdP puts a broader value
  // in aud -- Google notably does this. Only enforced when present.
  if ('azp' in payload && payload.azp !== clientId) throw invalidToken('azp does not match the expected client_id');

  const nowSeconds = Math.floor((typeof now === 'function' ? now() : now).getTime() / 1000);
  if (nowSeconds > Number(payload.exp) + CLOCK_SKEW_SECONDS) throw invalidToken('ID token has expired');
  if (nowSeconds < Number(payload.iat) - CLOCK_SKEW_SECONDS) throw invalidToken('ID token is not yet valid');

  return { issuer: payload.iss, subject: payload.sub, email: payload.email, jti: payload.jti };
}
