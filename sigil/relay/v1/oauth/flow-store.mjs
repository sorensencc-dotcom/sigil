import crypto from 'node:crypto';
import { newCookieSecret, hashCookie } from './cookies.mjs';

// Process-local, like ticket-store.mjs. A relay restart mid-login costs one retry.
export function createFlowStore({ now = () => new Date(), ttlMs = 600_000, maxEntries = 10_000 } = {}) {
  const entries = new Map(); // sha256(cookie) -> { flow, expiresAt }
  const sweep = () => {
    const t = now().getTime();
    for (const [key, entry] of entries) if (entry.expiresAt <= t) entries.delete(key);
  };
  return {
    start({ provider, inviteId = null }) {
      sweep();
      if (entries.size >= maxEntries) throw Object.assign(new Error('flow store full'), { code: 'FLOW_CAP' });
      const { value, hash } = newCookieSecret();
      const pkceVerifier = crypto.randomBytes(32).toString('base64url');
      const flow = {
        flow_id: `flow_${crypto.randomBytes(8).toString('hex')}`,
        state: crypto.randomBytes(24).toString('base64url'),
        nonce: crypto.randomBytes(24).toString('base64url'),
        pkceVerifier,
        codeChallenge: crypto.createHash('sha256').update(pkceVerifier).digest('base64url'),
        provider,
        inviteId,
      };
      entries.set(hash, { flow, expiresAt: now().getTime() + ttlMs });
      return { cookieValue: value, flow };
    },
    take(cookieValue) {
      if (typeof cookieValue !== 'string' || !cookieValue) return null;
      const key = hashCookie(cookieValue);
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      return entry.expiresAt > now().getTime() ? entry.flow : null;
    },
    size: () => entries.size,
  };
}
