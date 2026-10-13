import crypto from 'node:crypto';

export const SESSION_COOKIE = '__Host-sigil_session';
export const FLOW_COOKIE = '__Host-sigil_oauth';

export const hashCookie = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

export function newCookieSecret() {
  const value = crypto.randomBytes(32).toString('base64url');
  return { value, hash: hashCookie(value) };
}

export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

const ATTRS = 'Secure; Path=/; HttpOnly; SameSite=Lax';
export const setCookie = (name, value, { maxAge }) => `${name}=${value}; Max-Age=${maxAge}; ${ATTRS}`;
// A __Host- cookie set without Secure and Path=/ is ignored, and a bare Max-Age=0
// without Path would target /v1/auth; clearing repeats every attribute.
export const clearCookie = (name) => `${name}=; Max-Age=0; ${ATTRS}`;
