// sigil/relay/v1/idempotency-race.pg.test.mjs
// Live-Postgres pin: two concurrent submissions with the same sender and
// idempotency key but different message_ids. Exactly one is accepted; the loser
// gets the client-visible 409 DUPLICATE_MESSAGE, never a 500 and never the
// internal IDEMPOTENCY_RACE signal.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresRepository } from './postgres-repository.mjs';
import { acceptEnvelopeAsync } from './accept-envelope.mjs';
import { signedBytes } from './validate-envelope.mjs';
import { assertDisposableTestDatabase } from '../../scripts/assert-disposable-test-db.mjs';
import { applyMigrations } from '../../scripts/apply-migrations.mjs';

const connectionString = process.env.SIGIL_TEST_DATABASE_URL;
const NOW = new Date('2029-12-31T12:01:00.000Z');

test('postgres accept path: a lost idempotency-key race answers 409 DUPLICATE_MESSAGE', { skip: !connectionString }, async (t) => {
  assertDisposableTestDatabase(connectionString);
  await applyMigrations(connectionString, { reset: true });
  const pool = new pg.Pool({ connectionString });
  t.after(() => pool.end());
  const suffix = crypto.randomUUID().replaceAll('-', '_');
  const human = `usr_race_${suffix}`;
  await pool.query(`INSERT INTO humans (human_id, status, created_at) VALUES ($1, 'active', NOW())`, [human]);
  const endpoints = {};
  for (const name of ['sender', 'recipient']) {
    const endpointId = `ep_${name}_${suffix}`;
    const keyId = `key_${name}_${suffix}`;
    const keys = crypto.generateKeyPairSync('ed25519');
    await pool.query(
      `INSERT INTO endpoints (endpoint_id, owner_id, runtime, installation_id, display_name, status, created_at)
       VALUES ($1, $2, $3, $4, $3, 'active', NOW())`,
      [endpointId, human, name, `install_${endpointId}`],
    );
    await pool.query(
      `INSERT INTO endpoint_keys (key_id, endpoint_id, algorithm, public_key, status, valid_from)
       VALUES ($1, $2, 'Ed25519', $3, 'active', NOW())`,
      [keyId, endpointId, keys.publicKey.export({ type: 'spki', format: 'der' })],
    );
    endpoints[name] = { endpointId, keyId, keys };
  }
  const registered = new Map(Object.values(endpoints).map(({ endpointId, keyId, keys }) => [endpointId, { owner_id: human, status: 'active', key_id: keyId, public_key: keys.publicKey }]));
  const { sender, recipient } = endpoints;
  const idempotencyKey = `idem_${crypto.randomUUID()}`;
  const build = (messageId) => {
    const envelope = {
      protocol: 'sigil/1', message_id: messageId, conversation_id: `conv_${suffix}`, message_type: 'chat.message',
      sender: { endpoint_id: sender.endpointId, owner_id: human }, recipient: { endpoint_id: recipient.endpointId, owner_id: human },
      body: { text: `hello ${messageId}` }, context_refs: [], capabilities: [], correlation_id: null,
      idempotency_key: idempotencyKey, created_at: '2029-12-31T12:00:00.000Z', expires_at: '2029-12-31T13:00:00.000Z',
      signature: { algorithm: 'Ed25519', key_id: sender.keyId, value: '' },
    };
    envelope.signature.value = crypto.sign(null, signedBytes(envelope), sender.keys.privateKey).toString('base64url');
    return envelope;
  };
  const repository = new PostgresRepository({ pool });
  const a = build(`msg_a_${suffix}`);
  const b = build(`msg_b_${suffix}`);
  const results = await Promise.all([a, b].map((envelope) => acceptEnvelopeAsync(envelope, { repository, registered, now: NOW })));

  const accepted = results.filter((r) => r.status === 202);
  const rejected = results.filter((r) => r.status !== 202);
  assert.equal(accepted.length, 1, JSON.stringify(results));
  assert.equal(rejected.length, 1, JSON.stringify(results));
  assert.equal(rejected[0].status, 409, JSON.stringify(results));
  assert.equal(rejected[0].body.code, 'DUPLICATE_MESSAGE');
  for (const result of results) assert.ok(!JSON.stringify(result).includes('IDEMPOTENCY_RACE'), 'internal signal must never reach a client');

  const winnerId = accepted[0].body.message_id;
  const stored = await repository.lookupIdempotency(sender.endpointId, idempotencyKey);
  assert.equal(stored.message_id, winnerId);
});
