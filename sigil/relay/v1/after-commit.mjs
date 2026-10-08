import { AsyncLocalStorage } from 'node:async_hooks';

// One queue per outermost transaction. Nested scopes share it, so callbacks
// run once, only when the outermost transaction commits, and are dropped if
// any level throws (the throw reaches the outermost scope, which never flushes).
const queueStore = new AsyncLocalStorage();

// Returns false when no transaction scope is open, so callers can decide
// whether to run the callback immediately.
export function afterCommit(fn) {
  const queue = queueStore.getStore();
  if (!queue) return false;
  queue.push(fn);
  return true;
}

export async function deferOrRun(fn) {
  if (!afterCommit(fn)) await fn();
}

export async function withAfterCommitScope(run, { logger = console } = {}) {
  const outer = queueStore.getStore();
  if (outer) {
    // Nested scope: share the outermost queue, but if this level throws, drop
    // only the callbacks it registered. The outer caller may catch the error and
    // still commit, and must not then announce this level's rolled-back work.
    // (Postgres withTransaction does not truly nest: each call opens its own
    // client, so the inner rollback is real even when the outer commit succeeds.)
    const mark = outer.length;
    try { return await run(); } catch (error) { outer.length = mark; throw error; }
  }
  const queue = [];
  const result = await queueStore.run(queue, run);
  for (const fn of queue) {
    try { await fn(); } catch (error) { logger?.error?.('after-commit callback failed', error); }
  }
  return result;
}
