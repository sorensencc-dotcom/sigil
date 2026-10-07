import test from 'node:test';
import assert from 'node:assert/strict';
import { afterCommit, withAfterCommitScope, deferOrRun } from './after-commit.mjs';
import { withTransaction } from './with-transaction.mjs';
import { createMemoryRepository } from '../../cli/memory-repository.mjs';

function fakePool({ failCommit = false } = {}) {
  const log = [];
  const client = {
    async query(sql) {
      log.push(sql);
      if (sql === 'COMMIT' && failCommit) throw new Error('commit failed');
      return { rows: [] };
    },
    release() { log.push('release'); },
  };
  return { pool: { connect: async () => client }, log };
}

test('callbacks run after the scope resolves, in order', async () => {
  const order = [];
  await withAfterCommitScope(async () => {
    afterCommit(() => order.push('a'));
    afterCommit(() => order.push('b'));
    order.push('body');
  });
  assert.deepEqual(order, ['body', 'a', 'b']);
});

test('callbacks are dropped when the scope throws', async () => {
  const order = [];
  await assert.rejects(withAfterCommitScope(async () => { afterCommit(() => order.push('a')); throw new Error('boom'); }));
  assert.deepEqual(order, []);
});

test('nested scopes share the outermost queue and run once', async () => {
  const order = [];
  await withAfterCommitScope(async () => {
    await withAfterCommitScope(async () => { afterCommit(() => order.push('inner')); });
    order.push('after-inner');
    afterCommit(() => order.push('outer'));
  });
  assert.deepEqual(order, ['after-inner', 'inner', 'outer']);
});

test('an inner scope that throws drops its own callbacks even when the outer scope catches and commits', async () => {
  const order = [];
  await withAfterCommitScope(async () => {
    afterCommit(() => order.push('outer-before'));
    await assert.rejects(withAfterCommitScope(async () => {
      afterCommit(() => order.push('inner'));
      throw new Error('inner rolled back');
    }));
    afterCommit(() => order.push('outer-after'));
  });
  assert.deepEqual(order, ['outer-before', 'outer-after']);
});

test('a nested scope that throws drops everything when the outer scope also fails', async () => {
  const order = [];
  await assert.rejects(withAfterCommitScope(async () => {
    afterCommit(() => order.push('outer'));
    await withAfterCommitScope(async () => { afterCommit(() => order.push('inner')); throw new Error('inner'); });
  }));
  assert.deepEqual(order, []);
});

test('a throwing callback is logged and does not fail the request or later callbacks', async () => {
  const errors = [];
  const order = [];
  const result = await withAfterCommitScope(async () => {
    afterCommit(() => { throw new Error('cb'); });
    afterCommit(() => order.push('second'));
    return 'ok';
  }, { logger: { error: (...args) => errors.push(args) } });
  assert.equal(result, 'ok');
  assert.deepEqual(order, ['second']);
  assert.equal(errors.length, 1);
});

test('deferOrRun runs immediately outside a scope and queues inside one', async () => {
  const order = [];
  await deferOrRun(() => order.push('now'));
  await withAfterCommitScope(async () => { await deferOrRun(() => order.push('queued')); order.push('body'); });
  assert.deepEqual(order, ['now', 'body', 'queued']);
});

test('postgres withTransaction runs callbacks only after COMMIT succeeds', async () => {
  const { pool, log } = fakePool();
  const seen = [];
  await withTransaction(pool, async () => { afterCommit(() => seen.push(log.slice())); });
  assert.ok(seen[0].includes('COMMIT'));
  assert.ok(!seen[0].includes('ROLLBACK'));
});

test('postgres withTransaction sends nothing when COMMIT fails', async () => {
  const { pool } = fakePool({ failCommit: true });
  const seen = [];
  await assert.rejects(withTransaction(pool, async () => { afterCommit(() => seen.push('sent')); }), /commit failed/);
  assert.deepEqual(seen, []);
});

test('memory repository withTransaction: callbacks run once, only after the outermost commit', async () => {
  const repository = createMemoryRepository();
  const seen = [];
  await repository.withTransaction(async () => {
    await repository.withTransaction(async () => { afterCommit(() => seen.push('inner')); });
    assert.deepEqual(seen, []);
  });
  assert.deepEqual(seen, ['inner']);
});

test('memory repository withTransaction drops callbacks on rollback', async () => {
  const repository = createMemoryRepository();
  const seen = [];
  await assert.rejects(repository.withTransaction(async () => { afterCommit(() => seen.push('x')); throw new Error('rollback'); }));
  assert.deepEqual(seen, []);
});
