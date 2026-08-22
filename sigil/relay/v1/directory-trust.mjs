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
// pending, unexpired match request for that issuer." This is that check --
// but it is NOT wired to any login route, because this repo has no OIDC
// login flow at all yet (no ID-token verification, no JWKS, nothing calls
// repository.createHumanSession). It exists so that whichever future
// change adds real OIDC login has a single, already-reviewed call to make
// at the point a human's `provider_verified` email claim becomes
// available, instead of reinventing this against claimDirectoryMatch
// directly. Until that login flow exists, on-ramp 2 (OIDC match) can
// create and nominate-ready a directory_match_requests row but that row
// can never leave 'pending' in production.
export async function attemptDirectoryMatchOnOidcLogin({ repository, issuer, verifiedEmail, matchedHumanId, now = new Date() }) {
  if (!verifiedEmail || !matchedHumanId) return null;
  if (typeof repository?.claimDirectoryMatch !== 'function') return null;
  return repository.claimDirectoryMatch({ issuer, matchTarget: verifiedEmail, matchedHumanId, now });
}
