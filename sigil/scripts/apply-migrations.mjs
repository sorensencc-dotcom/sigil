import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../migrations');

export async function applyMigrations(connectionString = process.env.SIGIL_DATABASE_URL || 'postgres://sigil:sigil_password@127.0.0.1:55432/sigil', { reset = false } = {}) {
  console.log(`Connecting to PostgreSQL at ${connectionString.replace(/:[^:@]+@/, ':***@')}...`);
  const pool = new pg.Pool({ connectionString });

  try {
    if (reset) {
      console.log('Resetting schema public...');
      await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _sigil_schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const appliedRows = await pool.query('SELECT version FROM _sigil_schema_migrations');
    const applied = new Set(appliedRows.rows.map((r) => r.version));

    const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    let count = 0;

    for (const file of files) {
      if (applied.has(file)) continue;
      console.log(`Applying migration ${file}...`);
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _sigil_schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        count += 1;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    console.log(`✔ Schema up to date (${count} new migration(s) applied, ${files.length} total).`);
  } finally {
    await pool.end();
  }
}

const isDirectRun = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const reset = process.argv.includes('--reset');
  const urlArg = process.argv.find((a) => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]);
  const url = urlArg || process.env.SIGIL_DATABASE_URL;
  applyMigrations(url, { reset }).catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
