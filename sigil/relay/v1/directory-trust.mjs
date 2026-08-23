import crypto from 'node:crypto';

// High-entropy, single-use invite code (spec §3.1). Only the hash is ever
// persisted (spec §3.1 step 1: "stores its hash (never the code itself)").
export function generateInviteCode() {
  const code = crypto.randomBytes(24).toString('base64url');
  return { code, codeHash: crypto.createHash('sha256').update(code).digest('hex') };
}

// Match target (a provider-verified attribute value, spec §3.2 step 1) is
// hashed the same way an invite code is -- never stored or compared in the
// clear, so a leaked directory_match_requests row doesn't leak the target.
export function hashMatchTarget(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// Spec §3.2 step 2: "When any human authenticates via [an allow-listed]
// issuer, the relay checks their verified attributes against every
// pending, unexpired match request for that issuer." This is that check.
// It is wired in by POST /v1/auth/mock-login (relay/v1/http-server.mjs,
// gated behind --enable-mock-oidc / SIGIL_ENABLE_MOCK_OIDC), a fully local,
// fixture-signed login route for local dev/CI -- never real authentication.
// It remains unwired to any real IdP integration: no JWKS fetch, no
// real ID-token verification against an external issuer. That real OIDC
// login flow can call this same, already-reviewed function at the point a
// human's `provider_verified` email claim becomes available, instead of
// reinventing this against claimDirectoryMatch directly.
export async function attemptDirectoryMatchOnOidcLogin({ repository, issuer, verifiedEmail, matchedHumanId, now = new Date() }) {
  if (!verifiedEmail || !matchedHumanId) return null;
  if (typeof repository?.claimDirectoryMatch !== 'function') return null;
  return repository.claimDirectoryMatch({ issuer, matchTarget: verifiedEmail, matchedHumanId, now });
}
