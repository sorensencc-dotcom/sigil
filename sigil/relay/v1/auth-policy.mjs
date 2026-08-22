export const TOKEN_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const ACCOUNT_LINK_TTL_MS = 10 * 60 * 1000;
export const ASSURANCE_LEVELS = Object.freeze({ low: 'low', standard: 'standard', high: 'high' });

export function assertAllowedIssuer(issuer, allowList) {
  if (!(allowList instanceof Set) || allowList.size === 0) throw Object.assign(new Error('OIDC issuer allow-list is not configured'), { code: 'OIDC_PROVIDER_NOT_CONFIGURED' });
  if (!allowList.has(issuer)) throw Object.assign(new Error('OIDC issuer is not allowed'), { code: 'OIDC_PROVIDER_NOT_ALLOWED' });
  return issuer;
}

export function boundedTokenExpiry({ now = new Date(), expiresAt } = {}) {
  const issued = now instanceof Date ? now : new Date(now);
  const expiry = expiresAt ? new Date(expiresAt) : new Date(issued.getTime() + TOKEN_MAX_LIFETIME_MS);
  if (Number.isNaN(expiry.getTime()) || expiry <= issued || expiry.getTime() - issued.getTime() > TOKEN_MAX_LIFETIME_MS) throw Object.assign(new Error('Endpoint token lifetime must be positive and no more than 24 hours'), { code: 'TOKEN_LIFETIME_INVALID' });
  return expiry;
}

export const DIRECTORY_EXPIRY_DEFAULT_MS = 24 * 60 * 60 * 1000;
export const DIRECTORY_EXPIRY_MIN_MS = 60 * 60 * 1000;
export const DIRECTORY_EXPIRY_MAX_MS = 7 * 24 * 60 * 60 * 1000;

// Bounds invite/match-request expiry to spec §7's [1h, 7d] range, same
// shape as boundedTokenExpiry above.
export function boundedDirectoryExpiry({ now = new Date(), expiresAt } = {}) {
  const issued = now instanceof Date ? now : new Date(now);
  const expiry = expiresAt ? (expiresAt instanceof Date ? expiresAt : new Date(expiresAt)) : new Date(issued.getTime() + DIRECTORY_EXPIRY_DEFAULT_MS);
  const durationMs = expiry.getTime() - issued.getTime();
  if (Number.isNaN(expiry.getTime()) || durationMs < DIRECTORY_EXPIRY_MIN_MS || durationMs > DIRECTORY_EXPIRY_MAX_MS) {
    throw Object.assign(new Error('Directory invite/match expiry must be between 1 hour and 7 days'), { code: 'DIRECTORY_EXPIRY_INVALID' });
  }
  return expiry;
}

export function assertAssurance(assurance) {
  if (!Object.hasOwn(ASSURANCE_LEVELS, assurance)) throw Object.assign(new Error('Unsupported assurance level'), { code: 'ASSURANCE_LEVEL_INVALID' });
  return assurance;
}

export function assertAccountLinkCeremony({ nonceHash, stateHash, issuedAt, expiresAt, now = new Date() } = {}) {
  if (!nonceHash || !stateHash || !issuedAt || !expiresAt) throw Object.assign(new Error('Account-link nonce, state, issuance, and expiry are required'), { code: 'ACCOUNT_LINK_CEREMONY_REQUIRED' });
  const current = now instanceof Date ? now : new Date(now); const issued = new Date(issuedAt); const expiry = new Date(expiresAt);
  if ([issued, expiry].some((value) => Number.isNaN(value.getTime())) || expiry <= issued || expiry <= current || expiry.getTime() - issued.getTime() > ACCOUNT_LINK_TTL_MS) throw Object.assign(new Error('Account-link ceremony is expired or exceeds 10 minutes'), { code: 'ACCOUNT_LINK_CEREMONY_INVALID' });
  return true;
}
