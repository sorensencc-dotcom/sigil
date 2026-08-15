// OIDC issuer normalization (spec §5.1: "Issuer URLs MUST be normalized
// according to the configured provider policy"). This is the one policy
// applied unconditionally regardless of provider: HTTPS only, lowercase
// scheme/host, default port stripped, dot-segments resolved, trailing slash
// collapsed, and userinfo/query/fragment rejected outright rather than
// silently dropped (an issuer carrying `user:pass@` or a query string is far
// more likely to be a spoofing attempt than a legitimate provider URL).
//
// Two distinct issuer strings that normalize to the same value MUST be
// treated as the same identity provider; two that don't MUST be treated as
// different, even if a human would read them as "the same". Everything that
// stores or looks up an (issuer, subject) pair should normalize the issuer
// through this function first.

function invalidIssuer(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ISSUER' });
}

export function normalizeIssuer(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw invalidIssuer('issuer must be a non-empty string');
  let url;
  try { url = new URL(raw); } catch { throw invalidIssuer('issuer is not a valid URL'); }
  if (url.protocol !== 'https:') throw invalidIssuer('issuer must use https');
  if (url.username || url.password) throw invalidIssuer('issuer must not contain userinfo');
  if (url.search || url.hash) throw invalidIssuer('issuer must not contain a query string or fragment');
  // url.host already lowercases the hostname and omits the default HTTPS
  // port (443); url.pathname already resolves `.`/`..` segments. Only the
  // trailing-slash collapse is left to do here.
  const path = url.pathname.replace(/\/+$/, '');
  return `https://${url.host}${path}`;
}
