import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

const at = (minutes) => new Date(`2030-01-01T00:${String(minutes).padStart(2, '0')}:00.000Z`);
const hash = (value) => Buffer.alloc(32, value);

function tokenRow(tokenId, botId, value, createdAt = at(0)) {
  return { tokenId, botId, tokenSha256: hash(value), status: 'active', createdAt, expiresAt: null };
}

test('reply token insert and hash lookup return the stored row, and unknown hashes return null', async () => {
  const repository = createMemoryRepository();
  await repository.insertReplyToken(tokenRow('frt_1', 'bot_a', 1));
  assert.equal((await repository.lookupReplyTokenByHash(hash(1))).token_id, 'frt_1');
  assert.equal(await repository.lookupReplyTokenByHash(hash(2)), null);
});

test('retireActiveReplyTokens retires only active tokens for the selected bot', async () => {
  const repository = createMemoryRepository();
  await repository.insertReplyToken(tokenRow('frt_a1', 'bot_a', 1));
  await repository.insertReplyToken(tokenRow('frt_a2', 'bot_a', 2, at(1)));
  await repository.insertReplyToken(tokenRow('frt_b1', 'bot_b', 3));
  await repository.insertReplyToken({ ...tokenRow('frt_canary', 'bot_a', 4), status: 'canary' });
  assert.equal(await repository.retireActiveReplyTokens('bot_a', at(10)), 2);
  assert.equal((await repository.lookupReplyTokenByHash(hash(1))).status, 'retired');
  assert.equal((await repository.lookupReplyTokenByHash(hash(1))).expires_at, at(10).toISOString());
  assert.equal((await repository.lookupReplyTokenByHash(hash(3))).status, 'active');
  assert.equal((await repository.lookupReplyTokenByHash(hash(4))).status, 'canary');
});

test('revokeReplyToken is idempotent and records revoked_at', async () => {
  const repository = createMemoryRepository();
  await repository.insertReplyToken(tokenRow('frt_1', 'bot_a', 1));
  assert.equal(await repository.revokeReplyToken('frt_1', at(2)), true);
  assert.equal(await repository.revokeReplyToken('frt_1', at(3)), false);
  assert.equal((await repository.lookupReplyTokenByHash(hash(1))).revoked_at, at(2).toISOString());
});

test('listReplyTokens omits token hashes and returns lifecycle fields', async () => {
  const repository = createMemoryRepository();
  await repository.insertReplyToken(tokenRow('frt_1', 'bot_a', 1));
  const row = (await repository.listReplyTokens('bot_a'))[0];
  assert.deepEqual(Object.keys(row).sort(), ['bot_id', 'created_at', 'expires_at', 'last_used_at', 'revoked_at', 'status', 'token_id']);
  assert.equal(row.token_id, 'frt_1');
  assert.equal('token_sha256' in row, false);
});

test('touchReplyTokenLastUsed writes only after the throttle interval', async () => {
  const repository = createMemoryRepository();
  await repository.insertReplyToken(tokenRow('frt_1', 'bot_a', 1));
  assert.equal(await repository.touchReplyTokenLastUsed('frt_1', at(1), 60_000), true);
  assert.equal(await repository.touchReplyTokenLastUsed('frt_1', at(1).getTime() + 30_000, 60_000), false);
  assert.equal(await repository.touchReplyTokenLastUsed('frt_1', at(2), 60_000), true);
});

test('countAcceptedReplies counts only recent accepted replies for the bot', async () => {
  const repository = createMemoryRepository();
  await repository.recordAuditEvent({ eventType: 'room.floor_warden_reply', subjectId: 'bot_a', outcome: 'accepted', now: at(5) });
  await repository.recordAuditEvent({ eventType: 'room.floor_warden_reply', subjectId: 'bot_a', outcome: 'refused', now: at(6) });
  await repository.recordAuditEvent({ eventType: 'room.floor_warden_reply', subjectId: 'bot_b', outcome: 'accepted', now: at(7) });
  await repository.recordAuditEvent({ eventType: 'room.floor_warden_reply', subjectId: 'bot_a', outcome: 'accepted', now: at(1) });
  assert.equal(await repository.countAcceptedReplies({ botId: 'bot_a', since: at(4) }), 1);
});

test('reserveRateLimit accepts the reply quota scope kind', async () => {
  const repository = createMemoryRepository();
  assert.deepEqual(await repository.reserveRateLimit('floor_warden_reply', 'bot_a', at(0).toISOString(), 30), { count: 1, allowed: true });
});
