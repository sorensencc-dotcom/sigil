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
