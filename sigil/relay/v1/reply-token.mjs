import crypto from 'node:crypto';

const TOKEN_PATTERN = /^fwr_[A-Za-z0-9_-]{43}$/;

export function hashReplyToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

export function isReplyTokenShape(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

export function generateReplyToken() {
  const token = `fwr_${crypto.randomBytes(32).toString('base64url')}`;
  return {
    token,
    tokenId: `frt_${crypto.randomBytes(16).toString('hex')}`,
    sha256: hashReplyToken(token),
  };
}

export function evaluateReplyToken(row, now = new Date()) {
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.status === 'revoked') return { ok: false, reason: 'revoked' };
  if (row.status === 'canary') return { ok: false, reason: 'canary' };
  if (row.status === 'retired' && row.expires_at != null && new Date(row.expires_at) <= new Date(now)) {
    return { ok: false, reason: 'expired' };
  }
  if (row.status !== 'active' && row.status !== 'retired') return { ok: false, reason: 'unknown' };
  return { ok: true };
}

export function createReplyTokenMatcher({ repository, now = () => new Date(), globalTokens, allowGlobal = false, touchIntervalMs = 60_000, logger } = {}) {
  return async function match(bearer) {
    if (!isReplyTokenShape(bearer)) return null;
    const current = typeof now === 'function' ? now() : now;
    const row = await repository.lookupReplyTokenByHash(hashReplyToken(bearer));
    const verdict = evaluateReplyToken(row, current);
    if (verdict.ok) {
      Promise.resolve(repository.touchReplyTokenLastUsed(row.token_id, current, touchIntervalMs)).catch(() => {
        logger?.warn?.({ event: 'reply_token_touch_failed', token_id: row.token_id });
      });
      return { kind: 'bot', botId: row.bot_id, tokenId: row.token_id };
    }
    if (verdict.reason === 'canary') return { kind: 'canary', botId: row.bot_id, tokenId: row.token_id };
    if (allowGlobal && globalTokens?.matches(bearer)) return { kind: 'global' };
    return null;
  };
}
