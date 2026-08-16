// Standardizes connect/BEGIN/fn/COMMIT/ROLLBACK/release (design §3 "single
// transaction-bound client" requirement, blocker 4) so no call site can
// forget to release on an error path.
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
