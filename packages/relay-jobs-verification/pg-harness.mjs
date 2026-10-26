// packages/relay-jobs-verification/pg-harness.mjs
//
// Real PostgreSQL (PGlite, WASM) behind the pool interface PostgresRepository expects.
// Every migration in sigil/migrations/ is applied, so relay_jobs has the production
// schema, and sigil/relay/v1/postgres-repository.mjs runs unmodified on top.
//
// PGlite has one session. A `pool.connect()` client therefore holds a mutex until
// `release()`, which makes each transaction atomic. That matches the code under
// test: claimDueRelayJobs and finalizeRelayJob are each ONE statement, so they are
// atomic in PostgreSQL READ COMMITTED as well. Interleaving happens between calls.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../..');
const MIGRATIONS = path.join(REPO_ROOT, 'sigil/migrations');

function adapt(result) {
  return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
}

export async function makeDb() {
  const db = new PGlite();
  await db.waitReady;
  let tail = Promise.resolve();
  const lock = () => {
    let release;
    const next = new Promise((r) => { release = r; });
    const got = tail.then(() => release);
    tail = tail.then(() => next);
    return got;
  };
  const pool = {
    async query(text, values = []) { return adapt(await db.query(text, values)); },
    async connect() {
      const release = await lock();
      return {
        query: async (text, values = []) => adapt(await db.query(text, values)),
        release,
      };
    },
  };
  return { db, pool };
}

export async function applyMigrations(db) {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    try {
      await db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    } catch (error) {
      throw new Error(`migration ${f} failed on PGlite: ${error.message}`);
    }
  }
  return files;
}
