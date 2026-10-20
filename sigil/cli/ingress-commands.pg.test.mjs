import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../scripts/apply-migrations.mjs';
import { PostgresRepository } from '../relay/v1/postgres-repository.mjs';
import { cmdIngressStatus } from './ingress-commands.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('status lists fixture token metadata and accepted replies from disposable Postgres', { skip: !connectionString, timeout: 60_000 }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ('hum_ingress_status', 'active', NOW())`);
  await pool.query(`INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at) VALUES ('ep_test_bot', 'hum_ingress_status', 'test', 'agent', 'inst_test_bot', 'Test bot', 'active', NOW())`);
  await pool.query(`INSERT INTO floor_warden_bots (bot_id, endpoint_id, display_name, status, created_at) VALUES ('bot_test', 'ep_test_bot', 'Test bot', 'active', NOW())`);
  await pool.query(`INSERT INTO floor_warden_reply_tokens (token_id, bot_id, token_sha256, status, created_at) VALUES ('frt_test', 'bot_test', decode(repeat('07', 32), 'hex'), 'active', NOW())`);
  await pool.query(`INSERT INTO floor_warden_reply_tokens (token_id, bot_id, token_sha256, status, created_at) VALUES ('frt_retired', 'bot_test', decode(repeat('08', 32), 'hex'), 'retired', NOW())`);
  await pool.query(`INSERT INTO audit_events (event_id, event_type, subject_id, outcome, created_at) VALUES ('audit_ingress_status', 'room.floor_warden_reply', 'bot_test', 'accepted', NOW()), ('audit_ingress_refused', 'room.floor_warden_reply', 'bot_test', 'refused', NOW())`);
  const lines = [];
  await cmdIngressStatus([], { repository: new PostgresRepository({ pool }), write: (line) => lines.push(line) });
  const text = lines.join('\n');
  assert.match(text, /bot_test/);
  assert.match(text, /frt_test\tactive/);
  assert.match(text, /frt_retired\tretired/);
  assert.match(text, /accepted_last_hour/);
  assert.match(text, /\t1$/m);
  assert.ok(!text.includes('070707'));
});
