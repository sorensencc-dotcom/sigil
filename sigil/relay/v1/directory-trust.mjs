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
