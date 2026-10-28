import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplyTokenMatcher, evaluateReplyToken, generateReplyToken, hashReplyToken, isReplyTokenShape } from './reply-token.mjs';

test('generates and validates the fixed reply token shape', () => {
  const generated = generateReplyToken();
  assert.equal(isReplyTokenShape(generated.token), true);
  assert.match(generated.tokenId, /^frt_[0-9a-f]{32}$/);
  assert.deepEqual(generated.sha256, hashReplyToken(generated.token));
  for (const value of [`fwr_${'a'.repeat(42)}`, `fwr_${'a'.repeat(44)}`, `fwr_${'!'.repeat(43)}`, '', undefined, 'wrong']) {
    assert.equal(isReplyTokenShape(value), false);
  }
});

test('evaluates active, retired, expired, revoked, canary, and unknown rows', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  assert.deepEqual(evaluateReplyToken(null, now), { ok: false, reason: 'unknown' });
  assert.deepEqual(evaluateReplyToken({ status: 'active' }, now), { ok: true });
  assert.deepEqual(evaluateReplyToken({ status: 'retired', expires_at: '2026-01-01T00:01:00Z' }, now), { ok: true });
  assert.deepEqual(evaluateReplyToken({ status: 'retired', expires_at: '2025-12-31T23:59:00Z' }, now), { ok: false, reason: 'expired' });
  assert.deepEqual(evaluateReplyToken({ status: 'revoked' }, now), { ok: false, reason: 'revoked' });
  assert.deepEqual(evaluateReplyToken({ status: 'canary' }, now), { ok: false, reason: 'canary' });
  assert.deepEqual(evaluateReplyToken({ status: 'paused' }, now), { ok: false, reason: 'unknown' });
});

test('matches bot tokens before optional global tokens and does not leak touch failures', async () => {
  const generated = generateReplyToken();
  const calls = [];
  const warnings = [];
  const repository = {
    async lookupReplyTokenByHash(hash) { calls.push(['lookup', hash]); return { token_id: 'frt_bot', bot_id: 'bot_test', status: 'active' }; },
    async touchReplyTokenLastUsed(...args) { calls.push(['touch', ...args]); throw new Error(generated.token); },
  };
  const matcher = createReplyTokenMatcher({ repository, now: () => new Date(), allowGlobal: true, globalTokens: { matches: () => true }, logger: { warn(entry) { warnings.push(entry); } } });
  assert.deepEqual(await matcher(generated.token), { kind: 'bot', botId: 'bot_test', tokenId: 'frt_bot' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0][0], 'lookup');
  assert.equal(calls[1][0], 'touch');
  assert.equal(warnings.length, 1);
  const malformed = await matcher('not-a-reply-token');
  assert.equal(malformed, null);
  assert.equal(calls.length, 2);
});

test('global tokens are optional and malformed values make no repository call', async () => {
  let lookups = 0;
  const matcher = createReplyTokenMatcher({ repository: { lookupReplyTokenByHash: async () => { lookups += 1; return null; } }, allowGlobal: true, globalTokens: { matches: () => true } });
  const generated = generateReplyToken();
  assert.deepEqual(await matcher(generated.token), { kind: 'global' });
  assert.equal(lookups, 1);
  assert.equal(await matcher('fwr_bad'), null);
  assert.equal(lookups, 1);
});

test('matcher returns a canary verdict and null for revoked or unknown hashes', async () => {
  const canary = generateReplyToken();
  const revoked = generateReplyToken();
  const active = generateReplyToken();
  const unknown = generateReplyToken();
  const rows = new Map([
    [canary.sha256.toString('hex'), { token_id: 'frt_canary', bot_id: 'bot_canary', status: 'canary' }],
    [revoked.sha256.toString('hex'), { token_id: 'frt_revoked', bot_id: 'bot_revoked', status: 'revoked' }],
    [active.sha256.toString('hex'), { token_id: 'frt_active', bot_id: 'bot_active', status: 'active' }],
  ]);
  const touches = [];
  const repository = {
    async lookupReplyTokenByHash(hash) { return rows.get(Buffer.from(hash).toString('hex')) ?? null; },
    async touchReplyTokenLastUsed(...args) { touches.push(args); },
  };
  const matcher = createReplyTokenMatcher({ repository, now: () => new Date() });
  assert.deepEqual(await matcher(canary.token), { kind: 'canary', botId: 'bot_canary', tokenId: 'frt_canary' });
  assert.equal(await matcher(revoked.token), null);
  assert.equal(await matcher(unknown.token), null);
  assert.deepEqual(await matcher(active.token), { kind: 'bot', botId: 'bot_active', tokenId: 'frt_active' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(touches.length, 1);
  assert.equal(touches[0][0], 'frt_active');

  const withGlobal = createReplyTokenMatcher({
    repository,
    now: () => new Date(),
    allowGlobal: true,
    globalTokens: { matches: () => true },
  });
  assert.deepEqual(await withGlobal(canary.token), { kind: 'canary', botId: 'bot_canary', tokenId: 'frt_canary' });
});
