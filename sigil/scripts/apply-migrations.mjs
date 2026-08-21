import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertDisposableTestDatabase } from './assert-disposable-test-db.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../migrations');

export async function applyMigrations(connectionString = process.env.SIGIL_DATABASE_URL || 'postgres://sigil:sigil_password@127.0.0.1:55432/sigil', { reset = false } = {}) {
  console.log(`Connecting to PostgreSQL at ${connectionString.replace(/:[^:@]+@/, ':***@')}...`);
  const pool = new pg.Pool({ connectionString });

  try {
    if (reset) {
      assertDisposableTestDatabase(connectionString);
      console.log('Resetting schema public...');
      await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _sigil_schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    let appliedRows = await pool.query('SELECT version FROM _sigil_schema_migrations');
    let applied = new Set(appliedRows.rows.map((r) => r.version));

    const tables = new Set((await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map((r) => r.table_name));
    const indexes = new Set((await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)).rows.map((r) => r.indexname));
    const columns = new Set((await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'audit_events'`)).rows.map((r) => r.column_name));

    if (!applied.has('001_initial.sql') && tables.has('humans')) {
      await pool.query("INSERT INTO _sigil_schema_migrations (version) VALUES ('001_initial.sql') ON CONFLICT DO NOTHING");
      applied.add('001_initial.sql');
    }
    if (!applied.has('002_delivery_acknowledgement_idempotency.sql') && tables.has('delivery_acknowledgements')) {
      await pool.query("INSERT INTO _sigil_schema_migrations (version) VALUES ('002_delivery_acknowledgement_idempotency.sql') ON CONFLICT DO NOTHING");
      applied.add('002_delivery_acknowledgement_idempotency.sql');
    }
    if (!applied.has('003_plugin_connector_auth.sql') && tables.has('oidc_identities')) {
      await pool.query("INSERT INTO _sigil_schema_migrations (version) VALUES ('003_plugin_connector_auth.sql') ON CONFLICT DO NOTHING");
      applied.add('003_plugin_connector_auth.sql');
    }
    if (!applied.has('004_security_hardening.sql') && tables.has('recovery_attempts')) {
      await pool.query("INSERT INTO _sigil_schema_migrations (version) VALUES ('004_security_hardening.sql') ON CONFLICT DO NOTHING");
      applied.add('004_security_hardening.sql');
    }
    if (!applied.has('005_message_lookup_index.sql') && indexes.has('envelopes_sender_endpoint_id_message_id_idx')) {
      await pool.query("INSERT INTO _sigil_schema_migrations (version) VALUES ('005_message_lookup_index.sql') ON CONFLICT DO NOTHING");
      applied.add('005_message_lookup_index.sql');
    }
    if (!applied.has('006_capability_registry.sql') && tables.has('capabilities')) {
      await pool.query("INSERT INTO _sigil_schema_migrations (version) VALUES ('006_capability_registry.sql') ON CONFLICT DO NOTHING");
      applied.add('006_capability_registry.sql');
    }
    if (!applied.has('007_rate_quota.sql') && tables.has('quota_usage')) {
      await pool.query("INSERT INTO _sigil_schema_migrations (version) VALUES ('007_rate_quota.sql') ON CONFLICT DO NOTHING");
      applied.add('007_rate_quota.sql');
    }
    if (!applied.has('008_audit_conversation_binding.sql') && columns.has('conversation_id')) {
      await pool.query("INSERT INTO _sigil_schema_migrations (version) VALUES ('008_audit_conversation_binding.sql') ON CONFLICT DO NOTHING");
      applied.add('008_audit_conversation_binding.sql');
    }
    if (!applied.has('009_display_name_collision.sql') && indexes.has('endpoints_owner_display_name_idx')) {
      await pool.query("INSERT INTO _sigil_schema_migrations (version) VALUES ('009_display_name_collision.sql') ON CONFLICT DO NOTHING");
      applied.add('009_display_name_collision.sql');
    }
    if (!applied.has('010_endpoint_acknowledgements.sql') && tables.has('endpoint_acknowledgements')) {
      await pool.query("INSERT INTO _sigil_schema_migrations (version) VALUES ('010_endpoint_acknowledgements.sql') ON CONFLICT DO NOTHING");
      applied.add('010_endpoint_acknowledgements.sql');
    }
    if (!applied.has('011_task_request_lookup_index.sql') && indexes.has('envelopes_task_request_lookup_idx')) {
      await pool.query("INSERT INTO _sigil_schema_migrations (version) VALUES ('011_task_request_lookup_index.sql') ON CONFLICT DO NOTHING");
      applied.add('011_task_request_lookup_index.sql');
    }

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
