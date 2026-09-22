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

test('getPeerByKid resolves the pinned peer that published a kid', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const domain = `relay-${suffix}.example.com`;
  const testKid = `kid-${suffix}`;
  await repository.upsertPeer({
    domain,
    relayUrl: 'https://relay.example.com',
    keys: [{ kid: testKid, alg: 'Ed25519', publicKey: 'AAAA' }],
    trustMode: 'tofu',
  });
  const fetched = await repository.getPeerByKid(testKid);
  assert.equal(fetched?.domain, domain);
  assert.equal(await repository.getPeerByKid('kid-unknown'), null);
});

// Wraps a real pg.Pool so its connect()ed client throws on the first INSERT
// INTO audit_events it sees, then behaves normally -- proves real Postgres
// transaction rollback, not just a mocked assertion. See
// identity-auth-audit-atomicity.test.mjs for the canonical version of this
// helper.
function withAuditFailureInjected(pool) {
  return {
    async connect() {
      const client = await pool.connect();
      const originalQuery = client.query.bind(client);
      const originalRelease = client.release.bind(client);
      client.query = async (text, values) => {
        if (typeof text === 'string' && text.startsWith('INSERT INTO audit_events')) {
          throw new Error('simulated audit_events insert failure');
        }
        return originalQuery(text, values);
      };
      client.release = (...args) => { client.query = originalQuery; return originalRelease(...args); };
      return client;
    },
    query: (text, values) => pool.query(text, values)
  };
}

test('upsertPeerWithAudit commits the peer row and the audit row together, and rolls both back on audit failure', { skip: !connectionString }, async (t) => {
  const { pool, repository } = await bootstrap(t);
  const domain = `peer-${crypto.randomUUID()}.example`;
  const fields = { domain, relayUrl: `https://${domain}/relay`, keys: [{ kid: 'k1', alg: 'Ed25519', publicKey: 'pk1' }], trustMode: 'static', eventType: 'peer.static_pinned' };

  const failing = new PostgresRepository({ pool: withAuditFailureInjected(pool) });
  await assert.rejects(() => failing.upsertPeerWithAudit(fields));
  const notCreated = await pool.query('SELECT 1 FROM peer_relays WHERE domain = $1', [domain]);
  assert.equal(notCreated.rowCount, 0);

  const record = await repository.upsertPeerWithAudit(fields);
  assert.equal(record.domain, domain);
  const audit = await pool.query(`SELECT count(*) FROM audit_events WHERE event_type = 'peer.static_pinned' AND subject_id = $1`, [domain]);
  assert.equal(Number(audit.rows[0].count), 1);
});

test('removePeerWithAudit commits the delete and the audit row together, rolls both back on audit failure, and skips the audit when nothing was removed', { skip: !connectionString }, async (t) => {
  const { pool, repository } = await bootstrap(t);
  const domain = `peer-${crypto.randomUUID()}.example`;
  await repository.upsertPeer({ domain, relayUrl: `https://${domain}/relay`, keys: [{ kid: 'k1', alg: 'Ed25519', publicKey: 'pk1' }], trustMode: 'static' });

  const failing = new PostgresRepository({ pool: withAuditFailureInjected(pool) });
  await assert.rejects(() => failing.removePeerWithAudit(domain));
  const stillThere = await pool.query('SELECT 1 FROM peer_relays WHERE domain = $1', [domain]);
  assert.equal(stillThere.rowCount, 1);

  const removed = await repository.removePeerWithAudit(domain);
  assert.equal(removed, true);
  const audit = await pool.query(`SELECT count(*) FROM audit_events WHERE event_type = 'peer.removed' AND subject_id = $1`, [domain]);
  assert.equal(Number(audit.rows[0].count), 1);

  const removedAgain = await repository.removePeerWithAudit(domain);
  assert.equal(removedAgain, false);
  const auditAfterNoOp = await pool.query(`SELECT count(*) FROM audit_events WHERE event_type = 'peer.removed' AND subject_id = $1`, [domain]);
  assert.equal(Number(auditAfterNoOp.rows[0].count), 1, 'no second audit row when removePeerWithAudit finds nothing to delete');
});
