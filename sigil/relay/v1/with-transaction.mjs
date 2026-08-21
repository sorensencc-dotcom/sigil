/**
 * Executes a multi-step database workflow inside a single transaction
 * on a single, isolated pool connection client.
 * 
 * @param {import('pg').Pool} pool - The active PostgreSQL connection pool
 * @param {function(import('pg').PoolClient): Promise<any>} fn - The transactional operations callback
 * @returns {Promise<any>} The result of the callback
 */
export async function withTransaction(pool, fn) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new Error('Transaction execution requires a valid pg connection pool instance.');
  }
  if (typeof fn !== 'function') {
    throw new Error('Transaction execution requires a callback function.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[DATABASE] [ERROR] Failed to execute transaction rollback:', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

