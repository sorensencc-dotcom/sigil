import { parseCookies, hashCookie, SESSION_COOKIE } from './cookies.mjs';

export const SESSION_IDLE_MS = 8 * 3600_000;
export const TOUCH_AFTER_MS = 5 * 60_000;

const ms = (value) => new Date(value).getTime();

export async function loadSessionRow(repository, sessionId, client = repository.pool) {
  const { rows } = await client.query(
    `SELECT s.session_id, s.endpoint_id, s.human_id, s.expires_at, s.revoked_at, s.last_seen_at,
            i.status AS identity_status, e.kind AS endpoint_kind, e.status AS endpoint_status,
            e.display_name, h.status AS human_status
       FROM human_sessions s
       JOIN endpoints e ON e.endpoint_id = s.endpoint_id
       JOIN humans h ON h.human_id = s.human_id
       JOIN oidc_identities i ON i.issuer = s.identity_issuer AND i.subject = s.identity_subject
      WHERE s.session_id = $1 AND s.endpoint_id IS NOT NULL`, [sessionId]);
  return rows[0] ?? null;
}

export function sessionIsUsable(row, nowMs) {
  return Boolean(row)
    && !row.revoked_at
    && ms(row.expires_at) > nowMs
    && nowMs - ms(row.last_seen_at) < SESSION_IDLE_MS
    && row.identity_status === 'active'
    && row.endpoint_kind === 'human' && row.endpoint_status === 'active' && row.human_status === 'active';
}

// No cache by design: one indexed join per request.
export function createCookieAuthenticator({ repository, now = () => new Date() }) {
  return async function authenticate(request) {
    const value = parseCookies(request.headers?.cookie)[SESSION_COOKIE];
    if (!value) return null;
    const sessionId = hashCookie(value);
    const row = await loadSessionRow(repository, sessionId);
    const at = now();
    if (!sessionIsUsable(row, at.getTime())) return null;
    if (at.getTime() - ms(row.last_seen_at) > TOUCH_AFTER_MS) {
      await repository.pool.query(`UPDATE human_sessions SET last_seen_at = $2 WHERE session_id = $1 AND revoked_at IS NULL`, [sessionId, at.toISOString()]);
    }
    return { endpoint_id: row.endpoint_id, owner_id: row.human_id, human_id: row.human_id, session_id: sessionId, display_name: row.display_name };
  };
}
