import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryRepository } from './memory-repository.mjs';

test('memory relay createHumanSession returns a session row shaped like the Postgres one', async () => {
  const repository = createMemoryRepository();
  const now = new Date('2026-08-22T00:00:00Z');
  const session = await repository.createHumanSession({ sessionId: 'sess_1', humanId: 'usr_1', authenticationMethod: 'mock_oidc', assurance: 'standard', issuedAt: now, expiresAt: new Date(now.getTime() + 300_000), now });
  assert.equal(session.session_id, 'sess_1');
  assert.equal(session.human_id, 'usr_1');
  assert.equal(session.authentication_method, 'mock_oidc');
  assert.equal(session.assurance, 'standard');
  assert.equal(session.revoked_at, null);
});

test('memory relay consumeLoginJti allows first use, rejects replay', async () => {
  const repository = createMemoryRepository();
  const now = new Date('2026-08-22T00:00:00Z');
  const expiresAt = new Date(now.getTime() + 300_000);
  await repository.consumeLoginJti('jti_1', { now, expiresAt });
  await assert.rejects(
    () => repository.consumeLoginJti('jti_1', { now, expiresAt }),
    { code: 'TOKEN_REPLAYED' }
  );
});
