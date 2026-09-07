import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from './memory-repository.mjs';

test('memory consumeRelayNonce: first insert ok, second throws RELAY_REPLAYED', async () => {
  const repo = createMemoryRepository();
  const exp = Date.now() + 300_000;
  await repo.consumeRelayNonce('AAAAAAAAAAAAAAAAAAAAAA', { expiresAt: exp });
  await assert.rejects(
    repo.consumeRelayNonce('AAAAAAAAAAAAAAAAAAAAAA', { expiresAt: exp }),
    (e) => e.code === 'RELAY_REPLAYED',
  );
});

test('memory pruneRelayNonces removes only expired entries', async () => {
  const repo = createMemoryRepository();
  await repo.consumeRelayNonce('N_old_000000000000000000', { expiresAt: Date.now() - 1000 });
  await repo.consumeRelayNonce('N_new_000000000000000000', { expiresAt: Date.now() + 300_000 });
  const { deleted } = await repo.pruneRelayNonces(new Date());
  assert.equal(deleted, 1);
  // the still-valid nonce is still considered seen
  await assert.rejects(
    repo.consumeRelayNonce('N_new_000000000000000000', { expiresAt: Date.now() + 300_000 }),
    (e) => e.code === 'RELAY_REPLAYED',
  );
});
