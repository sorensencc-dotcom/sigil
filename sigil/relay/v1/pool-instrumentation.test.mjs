import test from 'node:test';
import assert from 'node:assert/strict';
import { instrumentPool, relayPoolOptions } from './pool-instrumentation.mjs';

function fakePool({ queryMs = 0, connectMs = 0, waitingCount = 0 } = {}) {
  const clock = { t: 0 };
  const client = { query: async () => { clock.t += queryMs; return { rows: [] }; } };
  const pool = {
    waitingCount, totalCount: 10, idleCount: 0,
    query: async () => { clock.t += queryMs; return { rows: [] }; },
    connect: async () => { clock.t += connectMs; return client; },
  };
  const logs = [];
  instrumentPool(pool, { slowQueryMs: 250, now: () => clock.t, log: (hop, fields) => logs.push({ hop, ...fields }) });
  return { pool, logs };
}

test('a slow query logs its SQL keyword, duration, and pool counts but no SQL text or params', async () => {
  const { pool, logs } = fakePool({ queryMs: 400 });
  await pool.query('select secret_column from t where token = $1', ['tok_SECRET']);
  assert.deepEqual(logs, [{ hop: 'relay.db_slow', op: 'SELECT', duration_ms: 400, waiting: 0, total: 10, idle: 0 }]);
  assert.doesNotMatch(JSON.stringify(logs), /secret_column|tok_SECRET/);
});

test('a fast query logs nothing', async () => {
  const { pool, logs } = fakePool({ queryMs: 10 });
  await pool.query({ text: 'INSERT INTO t VALUES ($1)', values: [1] });
  assert.deepEqual(logs, []);
});

test('queries on a checked-out client are timed too', async () => {
  const { pool, logs } = fakePool({ queryMs: 300 });
  const client = await pool.connect();
  await client.query('UPDATE t SET x = 1');
  assert.deepEqual(logs.map((l) => l.op), ['UPDATE']);
});

test('a slow checkout while others wait logs db_slow and db_pool_waiting', async () => {
  const { pool, logs } = fakePool({ connectMs: 2000, waitingCount: 3 });
  await pool.connect();
  assert.deepEqual(logs.map((l) => [l.hop, l.op ?? null]), [['relay.db_slow', 'CONNECT'], ['relay.db_pool_waiting', null]]);
  assert.equal(logs[1].waiting, 3);
});

test('pool options default safely and ignore invalid env', () => {
  assert.deepEqual(relayPoolOptions({}), { connectionTimeoutMillis: 10000, query_timeout: 30000, statement_timeout: 30000 });
  assert.deepEqual(relayPoolOptions({ SIGIL_DB_CONNECT_TIMEOUT_MS: 'abc', SIGIL_DB_QUERY_TIMEOUT_MS: '-5' }), { connectionTimeoutMillis: 10000, query_timeout: 30000, statement_timeout: 30000 });
  assert.equal(relayPoolOptions({ SIGIL_DB_QUERY_TIMEOUT_MS: '5000' }).statement_timeout, 5000);
});
