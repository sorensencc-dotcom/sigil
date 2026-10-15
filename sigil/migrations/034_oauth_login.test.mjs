import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../scripts/apply-migrations.mjs';

const sql = fs.readFileSync(new URL('./034_oauth_login.sql', import.meta.url), 'utf8');
const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

test('034 declares the login schema', () => {
  for (const pattern of [
    /CREATE TABLE room_invites/, /CREATE TABLE room_invite_rooms/,
    /ADD COLUMN verified_via TEXT/, /ADD COLUMN last_seen_at/, /ADD COLUMN identity_issuer/,
    /FOREIGN KEY \(endpoint_id, human_id\) REFERENCES endpoints \(endpoint_id, owner_id\)/,
    /oauth_provider_subject/, /oauth_start/, /federation_directory_redemption_inbound/,
  ]) assert.match(sql, pattern);
});

test('034 constraints behave', { skip: !connectionString }, async (t) => {
  await assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString);
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const s = crypto.randomBytes(4).toString('hex');
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 3600_000).toISOString();
  for (const h of ['a', 'b']) {
    await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1,'active',$2)`, [`hum_${h}_${s}`, now]);
    await pool.query(
      `INSERT INTO endpoints (endpoint_id, owner_id, runtime, kind, installation_id, display_name, status, created_at)
       VALUES ($1,$2,'human','human',$3,$4,'active',$5)`,
      [`ep_${h}_${s}`, `hum_${h}_${s}`, `inst_${h}_${s}`, h, now]);
  }
  const session = (id, endpoint, human, extra = {}) => pool.query(
    `INSERT INTO human_sessions (session_id, human_id, authentication_method, assurance, device_context, issued_at, expires_at, endpoint_id, last_seen_at, identity_issuer, identity_subject)
     VALUES ($1,$2,'oauth_github','standard','{}',$3,$4,$5,$6,$7,$8)`,
    [id, human, now, later, endpoint, 'lastSeen' in extra ? extra.lastSeen : now, extra.issuer ?? 'https://github.com', extra.subject ?? '1']);
  await session(`s1_${s}`, `ep_a_${s}`, `hum_a_${s}`);
  await assert.rejects(session(`s2_${s}`, `ep_a_${s}`, `hum_b_${s}`), /foreign key/i); // endpoint of another human
  await assert.rejects(session(`s3_${s}`, `ep_a_${s}`, `hum_a_${s}`, { lastSeen: null }), /check/i);
  // step-up row: null endpoint_id still inserts
  await pool.query(
    `INSERT INTO human_sessions (session_id, human_id, authentication_method, assurance, device_context, issued_at, expires_at)
     VALUES ($1,$2,'mock_oidc','standard','{}',$3,$4)`, [`s4_${s}`, `hum_a_${s}`, now, later]);
  // invite CHECKs
  const invite = (id, cols) => pool.query(
    `INSERT INTO room_invites (invite_id, token_hash, name, created_by_human_id, created_at, expires_at ${cols.names})
     VALUES ($1,$2,'n',$3,$4,$5 ${cols.values})`, [id, `th_${id}`, `hum_a_${s}`, now, later, ...cols.params]);
  await invite(`i1_${s}`, { names: '', values: '', params: [] });
  await assert.rejects(invite(`i2_${s}`, { names: ', consumed_at', values: ', $6', params: [now] }), /check/i); // consumed without consumer
  await assert.rejects(invite(`i3_${s}`, { names: ', target_issuer', values: ', $6', params: ['https://github.com'] }), /check/i); // partial target
  // quota scope kinds
  for (const kind of ['invite', 'oauth_provider_subject', 'oauth_start', 'federation_origin']) {
    await pool.query(`INSERT INTO quota_usage (scope_kind, scope_id, window_start, count) VALUES ($1,$2,$3,1)`, [kind, `k_${s}`, now]);
  }
});
