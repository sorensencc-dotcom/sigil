// sigil/cli/registry-seed.pg.test.mjs
// Live-Postgres pins for the insert-only registry seed used by `sigil relay up`.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

import { createIdentity } from './identity.mjs';
import { seedRegistry } from './registry-seed.mjs';
import { assertDisposableTestDatabase } from '../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;

async function freshPool(t) {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyMigrations(connectionString);
  return pool;
}

function entry(id, overrides = {}) {
  return {
    owner_id: id.owner_id, endpoint_id: id.endpoint_id, key_id: id.key_id, kind: id.kind,
    status: 'active', public_key_pem: id.public_key_pem, relay_token: id.relay_token, ...overrides,
  };
}

const row = async (pool, id) => (await pool.query('SELECT owner_id, kind, status FROM endpoints WHERE endpoint_id=$1', [id])).rows[0];

test('fresh seed inserts endpoint with kind from file, defaulting to human', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  const a = createIdentity({ ownerId: 'usr_a', endpointId: 'ep_a', kind: 'agent' });
  const h = createIdentity({ ownerId: 'usr_a', endpointId: 'ep_h', kind: 'human' });
  const noKind = entry(h, { endpoint_id: 'ep_nokind', key_id: 'key_nokind' });
  delete noKind.kind;
  noKind.public_key_pem = createIdentity({ ownerId: 'usr_a', endpointId: 'ep_nokind', kind: 'human' }).public_key_pem;
  await seedRegistry(pool, { endpoints: [entry(a), entry(h), noKind] });
  assert.equal((await row(pool, 'ep_a')).kind, 'agent');
  assert.equal((await row(pool, 'ep_h')).kind, 'human');
  assert.equal((await row(pool, 'ep_nokind')).kind, 'human');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM endpoint_keys WHERE status='active'`)).rows[0].n, 3);
});

test('re-seeding never reactivates a revoked endpoint', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  const a = createIdentity({ ownerId: 'usr_a', endpointId: 'ep_a', kind: 'agent' });
  const data = { endpoints: [entry(a)] };
  await seedRegistry(pool, data);
  await pool.query(`UPDATE endpoints SET status='revoked' WHERE endpoint_id='ep_a'`);
  await seedRegistry(pool, data);
  assert.equal((await row(pool, 'ep_a')).status, 'revoked');
});

test('file status revoked/suspended lowers a postgres row; active never raises one', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  const a = createIdentity({ ownerId: 'usr_a', endpointId: 'ep_a', kind: 'agent' });
  const b = createIdentity({ ownerId: 'usr_a', endpointId: 'ep_b', kind: 'agent' });
  await seedRegistry(pool, { endpoints: [entry(a), entry(b)] });
  await seedRegistry(pool, { endpoints: [entry(a, { status: 'revoked' }), entry(b, { status: 'suspended' })] });
  assert.equal((await row(pool, 'ep_a')).status, 'revoked');
  assert.equal((await row(pool, 'ep_b')).status, 'suspended');
  await seedRegistry(pool, { endpoints: [entry(a, { status: 'active' }), entry(b, { status: 'active' })] });
  assert.equal((await row(pool, 'ep_a')).status, 'revoked');
  assert.equal((await row(pool, 'ep_b')).status, 'suspended');
});

test('owner, key, or kind differences throw REGISTRY_CONFLICT naming both values', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  const a = createIdentity({ ownerId: 'usr_a', endpointId: 'ep_a', kind: 'agent' });
  await seedRegistry(pool, { endpoints: [entry(a)] });

  const expectConflict = async (file, field, fileValue, pgValue) => {
    await assert.rejects(seedRegistry(pool, { endpoints: [file] }), (err) => {
      assert.equal(err.code, 'REGISTRY_CONFLICT');
      const d = err.details.find((x) => x.field === field);
      assert.ok(d, `conflict on ${field}`);
      assert.equal(d.endpoint_id, 'ep_a');
      assert.equal(d.file, fileValue);
      assert.equal(d.postgres, pgValue);
      assert.match(err.message, /ep_a/);
      return true;
    });
  };
  await expectConflict(entry(a, { owner_id: 'usr_other' }), 'owner_id', 'usr_other', 'usr_a');
  await expectConflict(entry(a, { kind: 'human' }), 'kind', 'human', 'agent');
  const other = createIdentity({ ownerId: 'usr_a', endpointId: 'ep_a', kind: 'agent' });
  const spki = (pem) => crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('hex');
  await expectConflict(entry(a, { public_key_pem: other.public_key_pem }), 'public_key', spki(other.public_key_pem), spki(a.public_key_pem));
});

test('--reconcile-kind fixes only a mismatch equal to the file kind; other mismatches still throw', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  const a = createIdentity({ ownerId: 'usr_a', endpointId: 'ep_a', kind: 'human' });
  const b = createIdentity({ ownerId: 'usr_a', endpointId: 'ep_b', kind: 'human' });
  await seedRegistry(pool, { endpoints: [entry(a), entry(b)] });
  await pool.query(`UPDATE endpoints SET kind='agent' WHERE endpoint_id IN ('ep_a','ep_b')`);

  // reconcile value that differs from file kind: still throws, nothing changed
  await assert.rejects(
    seedRegistry(pool, { endpoints: [entry(a)] }, { reconcileKind: new Map([['ep_a', 'agent']]) }),
    (err) => err.code === 'REGISTRY_CONFLICT');
  assert.equal((await row(pool, 'ep_a')).kind, 'agent');

  // reconcile ep_a only; ep_b still mismatches -> throws, and ep_a fix is not committed
  await assert.rejects(
    seedRegistry(pool, { endpoints: [entry(a), entry(b)] }, { reconcileKind: new Map([['ep_a', 'human']]) }),
    (err) => err.code === 'REGISTRY_CONFLICT' && err.details.length === 1 && err.details[0].endpoint_id === 'ep_b');

  // reconcile both: succeeds and updates kind
  await seedRegistry(pool, { endpoints: [entry(a), entry(b)] }, { reconcileKind: new Map([['ep_a', 'human'], ['ep_b', 'human']]) });
  assert.equal((await row(pool, 'ep_a')).kind, 'human');
  assert.equal((await row(pool, 'ep_b')).kind, 'human');
});

// Spec Testing, `kind` bullet: a legacy human row predates `kind`, so its file
// row has none (meaning human) while migration 033 backfilled Postgres from
// runtime as agent.
test('a legacy file row with no kind fails with REGISTRY_CONFLICT until --reconcile-kind, then has that kind', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  const legacy = entry(createIdentity({ ownerId: 'usr_a', endpointId: 'ep_legacy', kind: 'human' }));
  delete legacy.kind;
  await seedRegistry(pool, { endpoints: [legacy] });
  await pool.query(`UPDATE endpoints SET kind='agent' WHERE endpoint_id='ep_legacy'`);

  await assert.rejects(seedRegistry(pool, { endpoints: [legacy] }), (err) => {
    assert.equal(err.code, 'REGISTRY_CONFLICT');
    assert.deepEqual(err.details.map((d) => [d.endpoint_id, d.field, d.file, d.postgres]), [['ep_legacy', 'kind', 'human', 'agent']]);
    return true;
  });
  assert.equal((await row(pool, 'ep_legacy')).kind, 'agent');

  await seedRegistry(pool, { endpoints: [legacy] }, { reconcileKind: new Map([['ep_legacy', 'human']]) });
  assert.equal((await row(pool, 'ep_legacy')).kind, 'human');
  await seedRegistry(pool, { endpoints: [legacy] });
  assert.equal((await row(pool, 'ep_legacy')).kind, 'human');
});

test('display_name from the file is inserted and refreshed on re-seed; absent leaves it alone', { skip: !connectionString }, async (t) => {
  const pool = await freshPool(t);
  const a = createIdentity({ ownerId: 'usr_a', endpointId: 'ep_a', kind: 'agent' });
  const b = createIdentity({ ownerId: 'usr_a', endpointId: 'ep_b', kind: 'agent' });
  const name = async (id) => (await pool.query('SELECT display_name FROM endpoints WHERE endpoint_id=$1', [id])).rows[0].display_name;
  await seedRegistry(pool, { endpoints: [entry(a, { display_name: 'Chief' }), entry(b)] });
  assert.equal(await name('ep_a'), 'Chief');
  assert.equal(await name('ep_b'), 'ep_b');
  await seedRegistry(pool, { endpoints: [entry(a, { display_name: '  Chief   of Staff ' }), entry(b, { display_name: 'Bee' })] });
  assert.equal(await name('ep_a'), 'Chief of Staff');
  assert.equal(await name('ep_b'), 'Bee');
  await seedRegistry(pool, { endpoints: [entry(a), entry(b, { display_name: 'x'.repeat(41) })] });
  assert.equal(await name('ep_a'), 'Chief of Staff');
  assert.equal(await name('ep_b'), 'Bee');
});
