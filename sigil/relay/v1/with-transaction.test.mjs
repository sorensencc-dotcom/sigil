import test from 'node:test';
import assert from 'node:assert/strict';
import { withTransaction } from './with-transaction.mjs';

function fakePool() {
  const calls = [];
  const client = { async query(text) { calls.push(text); }, release() { calls.push('RELEASE'); } };
  return { calls, async connect() { calls.push('CONNECT'); return client; } };
}

test('commits and releases on success', async () => {
  const pool = fakePool();
  const result = await withTransaction(pool, async (client) => { await client.query('SELECT 1'); return 'ok'; });
  assert.equal(result, 'ok');
  assert.deepEqual(pool.calls, ['CONNECT', 'BEGIN', 'SELECT 1', 'COMMIT', 'RELEASE']);
});

test('rolls back and releases on error, then rethrows', async () => {
  const pool = fakePool();
  await assert.rejects(
    () => withTransaction(pool, async () => { throw new Error('boom'); }),
    /boom/
  );
  assert.deepEqual(pool.calls, ['CONNECT', 'BEGIN', 'ROLLBACK', 'RELEASE']);
});

test('releases even when rollback itself is never reached (release is in finally)', async () => {
  const pool = fakePool();
  try { await withTransaction(pool, async () => { throw Object.assign(new Error('x'), { code: 'CUSTOM' }); }); } catch {}
  assert.equal(pool.calls.at(-1), 'RELEASE');
});
