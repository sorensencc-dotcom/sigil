// sigil/relay/v1/postgres-repository.directory-match.test.mjs
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

test('directory OIDC match lifecycle, including single-winner concurrency', { skip: !connectionString }, async (t) => {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  const ids = { a: `usr_a_${suffix}`, b: `usr_b_${suffix}`, c: `usr_c_${suffix}`, epA: `ep_a_${suffix}`, epB: `ep_b_${suffix}` };
  await pool.query(`
    INSERT INTO humans (human_id, status, created_at) VALUES ('${ids.a}', 'active', NOW()), ('${ids.b}', 'active', NOW()), ('${ids.c}', 'active', NOW());
    INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
      VALUES ('${ids.epA}', '${ids.a}', 'claude', 'install_a', 'A', 'active', NOW()),
             ('${ids.epB}', '${ids.b}', 'codex', 'install_b', 'B', 'active', NOW());
    INSERT INTO oidc_issuer_allowlist (issuer, display_label, enabled, added_at) VALUES ('https://accounts.example.com', 'Example', TRUE, NOW());
  `);
  const repository = new PostgresRepository({ pool });
  const now = new Date('2026-08-21T00:00:00Z');

  const request = await repository.createDirectoryMatchRequest({ issuerEndpointId: ids.epA, issuerHumanId: ids.a, issuer: 'https://accounts.example.com', matchTarget: 'target@example.com', expiresAt: new Date(now.getTime() + 60 * 60 * 1000), homeRelay: 'relay.local', now });
  assert.equal(typeof request.request_id, 'string');

  const [claimByB, claimByC] = await Promise.all([
    repository.claimDirectoryMatch({ issuer: 'https://accounts.example.com', matchTarget: 'target@example.com', matchedHumanId: ids.b, now }),
    repository.claimDirectoryMatch({ issuer: 'https://accounts.example.com', matchTarget: 'target@example.com', matchedHumanId: ids.c, now })
  ]);
  const winners = [claimByB, claimByC].filter((r) => r !== null);
  assert.equal(winners.length, 1);

  const nominated = await repository.nominateDirectoryLinkEndpoint({ requestId: request.request_id, nominatedEndpointId: ids.epB, nominatedHumanId: ids.b, homeRelay: 'relay.local', now });
  assert.equal(typeof nominated.link_id, 'string');
  assert.equal(nominated.status, 'pending');

  const link = await pool.query('SELECT * FROM directory_links WHERE link_id = $1', [nominated.link_id]);
  assert.equal(link.rows[0].initiated_via, 'oidc_match');
  assert.equal(link.rows[0].b_confirmed_at !== null, true);

  const nonMatch = await repository.claimDirectoryMatch({ issuer: 'https://accounts.example.com', matchTarget: 'nobody@example.com', matchedHumanId: ids.c, now });
  assert.equal(nonMatch, null);
});
