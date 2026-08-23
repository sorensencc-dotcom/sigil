import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function freshDb(t) {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  return pool;
}

test('createHumanSession and recordAuditEvent participate in a caller-supplied transaction and roll back together', { skip: !connectionString }, async (t) => {
  const pool = await freshDb(t);
  const repository = new PostgresRepository({ pool });
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const humanId = `usr_txn_${suffix}`;
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [humanId]);
  const now = new Date('2026-08-22T00:00:00Z');
  const sessionId = `sess_${suffix}`;

  await assert.rejects(repository.withTransaction(async (client) => {
    await repository.createHumanSession({ sessionId, humanId, authenticationMethod: 'mock_oidc', assurance: 'standard', issuedAt: now, expiresAt: new Date(now.getTime() + 60_000), now, client });
    await repository.recordAuditEvent({ eventType: 'human_session.created', subjectId: sessionId, actorHumanId: humanId, objectType: 'human_session', objectId: sessionId, outcome: 'success', now, client });
    throw new Error('force rollback');
  }));

  const sessionRow = await pool.query('SELECT * FROM human_sessions WHERE session_id = $1', [sessionId]);
  assert.equal(sessionRow.rows.length, 0, 'session row must not survive the rollback');
  const auditRow = await pool.query(`SELECT * FROM audit_events WHERE subject_id = $1`, [sessionId]);
  assert.equal(auditRow.rows.length, 0, 'audit row must not survive the rollback');
});

test('claimDirectoryMatch runs on a caller-supplied client without opening its own transaction', { skip: !connectionString }, async (t) => {
  const pool = await freshDb(t);
  const repository = new PostgresRepository({ pool });
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const ids = { a: `usr_a_${suffix}`, b: `usr_b_${suffix}`, epA: `ep_a_${suffix}` };
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.a}', 'active', NOW()), ('${ids.b}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at) VALUES ('${ids.epA}', '${ids.a}', 'claude', 'install_a', 'A', 'active', NOW());
    INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, added_at) VALUES ('https://accounts.example.com', 'Example', TRUE, NOW());
  `);
  const now = new Date('2026-08-22T00:00:00Z');
  await repository.createDirectoryMatchRequest({ issuerEndpointId: ids.epA, issuerHumanId: ids.a, issuer: 'https://accounts.example.com', matchTarget: 'target@example.com', expiresAt: new Date(now.getTime() + 3_600_000), homeRelay: 'relay.local', now });

  const claimed = await repository.withTransaction((client) =>
    repository.claimDirectoryMatch({ issuer: 'https://accounts.example.com', matchTarget: 'target@example.com', matchedHumanId: ids.b, now, client })
  );
  assert.equal(typeof claimed.request_id, 'string');
});
