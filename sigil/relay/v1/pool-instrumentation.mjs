import { logHop } from './hop-log.mjs';

export const DEFAULT_SLOW_QUERY_MS = 250;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

export function positiveIntFromEnv(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function relayPoolOptions(env = process.env) {
  const queryTimeout = positiveIntFromEnv(env.SIGIL_DB_QUERY_TIMEOUT_MS, DEFAULT_QUERY_TIMEOUT_MS);
  return {
    connectionTimeoutMillis: positiveIntFromEnv(env.SIGIL_DB_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS),
    query_timeout: queryTimeout,
    statement_timeout: queryTimeout,
  };
}

// The op is only the leading SQL keyword: never the text, params, or connection string.
function sqlOp(query) {
  const text = typeof query === 'string' ? query : query?.text;
  return (typeof text === 'string' ? text.trim().split(/\s+/, 1)[0] : '').toUpperCase().replace(/[^A-Z]/g, '') || 'UNKNOWN';
}

export function instrumentPool(pool, { slowQueryMs = DEFAULT_SLOW_QUERY_MS, now = () => performance.now(), log = logHop } = {}) {
  const counts = () => ({ waiting: pool.waitingCount ?? null, total: pool.totalCount ?? null, idle: pool.idleCount ?? null });
  const timed = async (op, run) => {
    const startedAt = now();
    try {
      return await run();
    } finally {
      const durationMs = Math.round(now() - startedAt);
      if (durationMs >= slowQueryMs) log('relay.db_slow', { op, duration_ms: durationMs, ...counts() });
    }
  };
  const wrapQuery = (target) => {
    const query = target.query.bind(target);
    target.query = (...args) => (typeof args.at(-1) === 'function' ? query(...args) : timed(sqlOp(args[0]), () => query(...args)));
  };
  const connect = pool.connect.bind(pool);
  pool.connect = (...args) => {
    if (typeof args[0] === 'function') return connect(...args);
    const waitingAtStart = pool.waitingCount ?? 0;
    return timed('CONNECT', async () => {
      const client = await connect();
      if (!client.sigilInstrumented) { wrapQuery(client); client.sigilInstrumented = true; }
      return client;
    }).finally(() => { if (waitingAtStart > 0) log('relay.db_pool_waiting', counts()); });
  };
  wrapQuery(pool);
  return pool;
}
