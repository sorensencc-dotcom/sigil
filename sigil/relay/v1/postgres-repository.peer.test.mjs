// sigil/relay/v1/postgres-repository.peer.test.mjs
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

async function bootstrap(t) {
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  assertDisposableTestDatabase(connectionString);
  const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const file of (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(await fs.readFile(path.join(migrationsDir, file), 'utf8'));
  }
  return { pool, repository: new PostgresRepository({ pool }) };
}

const KEYS = [{ kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' }];

test('getPeerByDomain returns null for an unknown domain', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  assert.equal(await repository.getPeerByDomain('relay.example.com'), null);
});

test('upsertPeer inserts a record that getPeerByDomain can read back', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const domain = `relay-${suffix}.example.com`;
  const record = await repository.upsertPeer({ domain, relayUrl: 'https://relay.example.com/v1', wsUrl: null, keys: KEYS, trustMode: 'tofu' });
  assert.equal(record.domain, domain);
  assert.equal(record.trustMode, 'tofu');
  assert.deepEqual(record.keys, KEYS);
  const fetched = await repository.getPeerByDomain(domain);
  assert.deepEqual(fetched, record);
});

test('upsertPeer preserves discoveredAt across a later update but bumps updatedAt', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const domain = `relay-${suffix}.example.com`;
  const first = new Date('2026-08-25T00:00:00Z');
  const second = new Date('2026-08-26T00:00:00Z');
  await repository.upsertPeer({ domain, relayUrl: 'https://relay.example.com/v1', keys: KEYS, trustMode: 'tofu', now: first });
  const updated = await repository.upsertPeer({ domain, relayUrl: 'https://relay.example.com/v2', keys: KEYS, trustMode: 'tofu', now: second });
  assert.equal(new Date(updated.discoveredAt).toISOString(), first.toISOString());
  assert.equal(new Date(updated.updatedAt).toISOString(), second.toISOString());
  assert.equal(updated.relayUrl, 'https://relay.example.com/v2');
});

test('listPeers returns all pinned peers ordered by domain', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const domainA = `a-${suffix}.example.com`;
  const domainB = `b-${suffix}.example.com`;
  await repository.upsertPeer({ domain: domainB, relayUrl: 'https://b.example.com/v1', keys: KEYS, trustMode: 'static' });
  await repository.upsertPeer({ domain: domainA, relayUrl: 'https://a.example.com/v1', keys: KEYS, trustMode: 'tofu' });
  const domains = (await repository.listPeers()).map((p) => p.domain);
  assert.ok(domains.indexOf(domainA) < domains.indexOf(domainB));
});

test('removePeer deletes a pinned peer and returns true, false if nothing was there', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const domain = `relay-${suffix}.example.com`;
  await repository.upsertPeer({ domain, relayUrl: 'https://relay.example.com/v1', keys: KEYS, trustMode: 'tofu' });
  assert.equal(await repository.removePeer(domain), true);
  assert.equal(await repository.getPeerByDomain(domain), null);
  assert.equal(await repository.removePeer(domain), false);
});
