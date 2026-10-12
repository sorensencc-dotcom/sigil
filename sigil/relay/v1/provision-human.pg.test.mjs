import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { provisionHumanTx } from './provision-human.mjs';
import { unwrapPrivateKey } from './key-wrap.mjs';
import { withTransaction } from './with-transaction.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const skip = !connectionString;
const wrapKey = crypto.randomBytes(32);
const NOW = new Date('2030-01-02T03:04:05.000Z');

async function freshPool(t) {
  assertDisposableTestDatabase(connectionString);
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await applyMigrations(connectionString);
  return pool;
}

test('provisionHumanTx writes the human, endpoint, key, wrapped key, attributes, and audit row', { skip }, async (t) => {
  const pool = await freshPool(t);
  const result = await withTransaction(pool, (client) => provisionHumanTx(client, {
    displayName: 'Alice',
    attributes: [
      { kind: 'email', value: 'alice@example.com', source: 'cli', verification_state: 'provider_verified' },
      { kind: 'name', value: 'Alice A', source: 'cli' },
    ],
    wrapKey,
    now: NOW,
  }));
  assert.match(result.human_id, /^hum_[0-9a-f]{32}$/);
  assert.match(result.endpoint_id, /^ep_[0-9a-f]{32}$/);
  assert.match(result.key_id, /^key_[0-9a-f]{32}$/);

  const human = (await pool.query('SELECT * FROM humans')).rows;
  assert.equal(human.length, 1);
  assert.equal(human[0].human_id, result.human_id);
  assert.equal(human[0].status, 'active');

  const eps = (await pool.query('SELECT * FROM endpoints')).rows;
  assert.equal(eps.length, 1);
  assert.equal(eps[0].endpoint_id, result.endpoint_id);
  assert.equal(eps[0].owner_id, result.human_id);
  assert.equal(eps[0].runtime, 'human');
  assert.equal(eps[0].kind, 'human');
  assert.equal(eps[0].status, 'active');
  assert.equal(eps[0].installation_id, `install_${result.endpoint_id}`);
  assert.equal(eps[0].display_name, 'Alice');

  const keys = (await pool.query('SELECT * FROM endpoint_keys')).rows;
  assert.equal(keys.length, 1);
  assert.equal(keys[0].key_id, result.key_id);
  assert.equal(keys[0].endpoint_id, result.endpoint_id);
  assert.equal(keys[0].algorithm, 'Ed25519');
  assert.equal(keys[0].status, 'active');
  assert.equal(keys[0].valid_from.toISOString(), NOW.toISOString());

  const wrapped = (await pool.query('SELECT * FROM human_signing_keys')).rows;
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0].key_id, result.key_id);
  const priv = unwrapPrivateKey({ wrapKey, endpointId: result.endpoint_id, keyId: result.key_id, wrapped: wrapped[0].wrapped_private_key });
  const derivedSpki = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' });
  assert.ok(derivedSpki.equals(keys[0].public_key));

  const attrs = (await pool.query('SELECT * FROM human_attributes ORDER BY kind')).rows;
  assert.equal(attrs.length, 2);
  assert.deepEqual(attrs.map((a) => a.kind), ['email', 'name']);
  for (const a of attrs) {
    assert.equal(a.human_id, result.human_id);
    assert.equal(a.verification_state, 'unverified');
    assert.equal(a.source, 'cli');
    assert.equal(a.observed_at.toISOString(), NOW.toISOString());
  }
  assert.equal(attrs[0].value_or_ciphertext.toString('utf8'), 'alice@example.com');

  const audit = (await pool.query(`SELECT * FROM audit_events WHERE event_type = 'human.provisioned'`)).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].subject_id, result.human_id);
  assert.equal(audit[0].object_type, 'human');
  assert.equal(audit[0].object_id, result.human_id);
  assert.equal(audit[0].outcome, 'success');
});

test('an outer rollback leaves no human, endpoint, or key rows', { skip }, async (t) => {
  const pool = await freshPool(t);
  await assert.rejects(
    withTransaction(pool, async (client) => {
      await provisionHumanTx(client, { displayName: 'Bob', attributes: [{ kind: 'name', value: 'Bob', source: 'cli' }], wrapKey });
      throw new Error('boom');
    }),
    /boom/,
  );
  for (const table of ['humans', 'endpoints', 'endpoint_keys', 'human_signing_keys', 'human_attributes', 'audit_events']) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    assert.equal(rows[0].n, 0, table);
  }
});

test('a missing wrap key rejects WRAP_KEY_UNAVAILABLE before any insert', { skip }, async (t) => {
  const pool = await freshPool(t);
  await assert.rejects(
    withTransaction(pool, (client) => provisionHumanTx(client, {})),
    (error) => error.code === 'WRAP_KEY_UNAVAILABLE',
  );
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM humans')).rows[0].n, 0);
});

test('without a displayName the display name is the endpoint id', { skip }, async (t) => {
  const pool = await freshPool(t);
  const result = await withTransaction(pool, (client) => provisionHumanTx(client, { wrapKey }));
  const row = (await pool.query('SELECT display_name FROM endpoints WHERE endpoint_id = $1', [result.endpoint_id])).rows[0];
  assert.equal(row.display_name, result.endpoint_id);
});
