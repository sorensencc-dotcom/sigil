// sigil/relay/v1/postgres-repository.federation-outbox.test.mjs
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

function makeRow(overrides = {}) {
  const suffix = crypto.randomUUID();
  return {
    messageId: `msg-${suffix}`,
    idempotencyKey: `idem-${suffix}`,
    recipientDomain: 'remote.example.com',
    originDomain: 'local.example.com',
    envelope: { message_id: `msg-${suffix}`, expires_at: '2999-01-01T00:00:00Z' },
    senderKey: { kid: 'k1', alg: 'Ed25519', publicKey: 'pub-1' },
    senderOwnerId: `owner-${suffix}`,
    now: new Date('2020-01-01T00:00:00Z'),
    ...overrides,
  };
}

test('enqueueFederationForward inserts one row (inserted: true)', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const input = makeRow();
  const { row, inserted } = await repository.enqueueFederationForward(input);
  assert.equal(inserted, true);
  assert.equal(row.messageId, input.messageId);
  assert.equal(row.idempotencyKey, input.idempotencyKey);
  assert.equal(row.recipientDomain, 'remote.example.com');
  assert.equal(row.originDomain, 'local.example.com');
  assert.equal(row.state, 'pending');
  assert.equal(row.attemptCount, 0);
  assert.equal(row.claimToken, null);
  assert.deepEqual(row.senderKey, input.senderKey);
});

test('re-enqueue of the same (message_id, idempotency_key) returns inserted: false and the existing row', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const input = makeRow();
  const first = await repository.enqueueFederationForward(input);
  const second = await repository.enqueueFederationForward({ ...makeRow(), messageId: input.messageId, idempotencyKey: input.idempotencyKey });
  assert.equal(second.inserted, false);
  assert.equal(second.row.id, first.row.id);
  // Unchanged from the first insert -- the re-enqueue must not overwrite.
  assert.equal(second.row.recipientDomain, 'remote.example.com');
});

test('claimDueFederationForwards moves pending -> processing and sets a claim token', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const input = makeRow();
  const { row } = await repository.enqueueFederationForward(input);
  const claimed = await repository.claimDueFederationForwards(new Date(), 10, 30);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, row.id);
  assert.equal(claimed[0].state, 'processing');
  assert.equal(claimed[0].attemptCount, 0);
  assert.ok(claimed[0].claimToken, 'expected a claim token to be assigned');
  assert.ok(claimed[0].claimedAt, 'expected claimed_at to be set');
});

test('a processing row past its lease is re-claimed with attempt_count incremented', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const { row } = await repository.enqueueFederationForward(makeRow());
  const first = await repository.claimDueFederationForwards(new Date(), 10, 30);
  assert.equal(first.length, 1);
  assert.equal(first[0].attemptCount, 0);
  // A claimer whose clock is an hour ahead sees the lease (30s) as long expired.
  const future = new Date(Date.now() + 3600 * 1000);
  const reclaimed = await repository.claimDueFederationForwards(future, 10, 30);
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].id, row.id);
  assert.equal(reclaimed[0].state, 'processing');
  assert.equal(reclaimed[0].attemptCount, 1);
  assert.notEqual(reclaimed[0].claimToken, first[0].claimToken);
});

test('finalizeFederationForward updates with the right claim token and is a no-op with a stale one', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const { row } = await repository.enqueueFederationForward(makeRow());
  const [claimed] = await repository.claimDueFederationForwards(new Date(), 10, 30);

  const stale = await repository.finalizeFederationForward(row.id, crypto.randomUUID(), 'forwarded', {});
  assert.equal(stale.updated, false);
  const afterStale = await repository.getFederationOutboxRow(row.id);
  assert.equal(afterStale.state, 'processing');

  const ok = await repository.finalizeFederationForward(row.id, claimed.claimToken, 'forwarded', { reasonCode: 'OK' });
  assert.equal(ok.updated, true);
  const afterOk = await repository.getFederationOutboxRow(row.id);
  assert.equal(afterOk.state, 'forwarded');
  assert.equal(afterOk.claimToken, null);
  assert.equal(afterOk.claimedAt, null);
  assert.equal(afterOk.lastReasonCode, 'OK');
});

test('retryFederationForward moves a dead_letter row back to pending', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const { row } = await repository.enqueueFederationForward(makeRow());
  const [claimed] = await repository.claimDueFederationForwards(new Date(), 10, 30);
  await repository.finalizeFederationForward(row.id, claimed.claimToken, 'dead_letter', { attemptCount: 5, reasonCode: 'BOOM' });

  const result = await repository.retryFederationForward(row.id, new Date());
  assert.deepEqual(result, { retried: true });
  const after = await repository.getFederationOutboxRow(row.id);
  assert.equal(after.state, 'pending');
  assert.equal(after.attemptCount, 0);
  assert.equal(after.claimToken, null);
  assert.equal(after.claimedAt, null);
  assert.equal(after.lastReasonCode, null);
});

test('retryFederationForward of an expired-envelope row returns { retried: false, reason: MESSAGE_EXPIRED }', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const input = makeRow({ envelope: { message_id: 'm-expired', expires_at: '2000-01-01T00:00:00Z' } });
  const { row } = await repository.enqueueFederationForward(input);
  const [claimed] = await repository.claimDueFederationForwards(new Date(), 10, 30);
  await repository.finalizeFederationForward(row.id, claimed.claimToken, 'dead_letter', { reasonCode: 'BOOM' });

  const result = await repository.retryFederationForward(row.id, new Date());
  assert.deepEqual(result, { retried: false, reason: 'MESSAGE_EXPIRED' });
  const after = await repository.getFederationOutboxRow(row.id);
  assert.equal(after.state, 'dead_letter');
});

test('listFederationOutbox returns full state counts and rows without envelope/sender_key', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const a = await repository.enqueueFederationForward(makeRow());
  await repository.enqueueFederationForward(makeRow());
  await repository.enqueueFederationForward(makeRow());
  const [claimed] = await repository.claimDueFederationForwards(new Date(), 1, 30);
  await repository.finalizeFederationForward(claimed.id, claimed.claimToken, 'forwarded', {});

  const all = await repository.listFederationOutbox();
  assert.deepEqual(all.counts, { pending: 2, processing: 0, forwarded: 1, forward_rejected: 0, dead_letter: 0 });
  assert.equal(all.rows.length, 3);
  for (const r of all.rows) {
    assert.ok(!('envelope' in r), 'list rows must omit envelope');
    assert.ok(!('senderKey' in r), 'list rows must omit senderKey');
    assert.ok('state' in r && 'attemptCount' in r);
  }

  const pendingOnly = await repository.listFederationOutbox({ states: ['pending'] });
  assert.equal(pendingOnly.rows.length, 2);
  assert.equal(pendingOnly.counts.forwarded, 1);
  assert.ok(a.row.id);
});

test('getFederationOutboxRow returns the full row (with envelope + sender_key) or null', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  assert.equal(await repository.getFederationOutboxRow(crypto.randomUUID()), null);
  const input = makeRow();
  const { row } = await repository.enqueueFederationForward(input);
  const fetched = await repository.getFederationOutboxRow(row.id);
  assert.deepEqual(fetched.envelope, input.envelope);
  assert.deepEqual(fetched.senderKey, input.senderKey);
  assert.equal(fetched.senderOwnerId, input.senderOwnerId);
});

test('two concurrent claimDueFederationForwards callers never return the same row', { skip: !connectionString }, async (t) => {
  const { repository } = await bootstrap(t);
  const enqueued = [];
  for (let i = 0; i < 6; i += 1) {
    enqueued.push((await repository.enqueueFederationForward(makeRow())).row.id);
  }

  const now = new Date();
  const [claimA, claimB] = await Promise.all([
    repository.withTransaction((client) => repository.claimDueFederationForwards(now, 3, 30, client)),
    repository.withTransaction((client) => repository.claimDueFederationForwards(now, 3, 30, client)),
  ]);

  const idsA = new Set(claimA.map((r) => r.id));
  const idsB = new Set(claimB.map((r) => r.id));
  for (const id of idsA) assert.ok(!idsB.has(id), `row ${id} was claimed by both callers`);
  const union = new Set([...idsA, ...idsB]);
  assert.equal(union.size, idsA.size + idsB.size, 'claimed id sets must be disjoint');
  for (const id of union) assert.ok(enqueued.includes(id));
});
