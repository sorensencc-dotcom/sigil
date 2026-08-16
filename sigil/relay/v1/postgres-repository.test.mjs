import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresRepository } from './postgres-repository.mjs';

function fakePool({ fail = false } = {}) {
  const calls = [];
  const client = {
    async query(text, values) { calls.push({ text, values }); if (fail && text.startsWith('INSERT')) throw new Error('insert failed'); return text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK' ? { rows: [] } : { rows: [{ message_id: values?.[0] }] }; },
    release() { calls.push({ text: 'RELEASE' }); }
  };
  return { calls, async connect() { calls.push({ text: 'CONNECT' }); return client; }, async end() { calls.push({ text: 'END' }); } };
}

const envelope = { message_id: 'msg_1', conversation_id: 'conv_1', protocol: 'sigil/1', message_type: 'task.request', sender: { endpoint_id: 'ep_codex', owner_id: 'usr_1' }, recipient: { endpoint_id: 'ep_claude' }, body: { task_id: 'task_1' }, context_refs: [], capabilities: [], correlation_id: null, idempotency_key: 'send_1', expires_at: '2026-08-14T00:00:00Z', created_at: '2026-08-13T12:00:00Z', signature: { algorithm: 'Ed25519', key_id: 'key_1', value: 'sig' } };

test('repository persists accepted envelope in one transaction', async () => {
  const pool = fakePool();
  const row = await new PostgresRepository({ pool }).persistAcceptedEnvelope({ envelope, canonical_bytes: Buffer.from('canonical'), action_hash: 'sha256:abc' });
  assert.deepEqual(row, { message_id: 'msg_1', duplicate: false });
  assert.equal(pool.calls[1].text, 'BEGIN');
  const insert = pool.calls.find((call) => call.text.startsWith('INSERT'));
  assert.equal(insert.values.length, 20);
  assert.equal(insert.values[0], 'msg_1');
  assert.equal(insert.values[17], 'sig');
  assert.equal(insert.values[19], 'sha256:abc');
  assert.equal(pool.calls.at(-2).text, 'COMMIT');
});

test('repository rolls back and releases client on persistence failure', async () => {
  const pool = fakePool({ fail: true });
  await assert.rejects(() => new PostgresRepository({ pool }).persistAcceptedEnvelope({ envelope }));
  assert.ok(pool.calls.some((call) => call.text === 'ROLLBACK'));
  assert.equal(pool.calls.at(-1).text, 'RELEASE');
});

test('concurrent duplicate submission surfaces the winning acceptance instead of throwing', async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.startsWith('INSERT INTO idempotency_keys')) throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      if (text.startsWith('SELECT message_id, canonical_hash FROM idempotency_keys')) return { rows: [{ message_id: 'msg_winner', canonical_hash: 'sha256:abc' }] };
      return { rows: [{ message_id: values?.[0] }] };
    },
    release() { calls.push({ text: 'RELEASE' }); }
  };
  const pool = { calls, query: (...args) => client.query(...args), async connect() { return client; }, async end() {} };
  const row = await new PostgresRepository({ pool }).persistAcceptedEnvelope({ envelope, canonical_bytes: Buffer.from('canonical'), action_hash: 'sha256:abc' });
  assert.deepEqual(row, { message_id: 'msg_winner', duplicate: true });
  assert.ok(calls.some((call) => call.text === 'ROLLBACK'));
});

test('non-idempotency conflicts still propagate as errors', async () => {
  const client = {
    async query(text) {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.startsWith('INSERT INTO envelopes')) throw Object.assign(new Error('foreign key violation'), { code: '23503' });
      return { rows: [] };
    },
    release() {}
  };
  const pool = { async connect() { return client; }, async end() {} };
  await assert.rejects(
    () => new PostgresRepository({ pool }).persistAcceptedEnvelope({ envelope }),
    (error) => error.code === '23503'
  );
});

function fakeAckPool({ deliveryState = 'delivered', priorAck = null } = {}) {
  const calls = [];
  const acknowledgements = priorAck ? [priorAck] : [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.startsWith('INSERT INTO delivery_acknowledgements')) {
        const [deliveryId, endpointId, acknowledgedAt] = values;
        if (acknowledgements.some((row) => row.delivery_id === deliveryId)) return { rows: [] };
        acknowledgements.push({ delivery_id: deliveryId, endpoint_id: endpointId, acknowledged_at: acknowledgedAt });
        return { rows: [{ delivery_id: deliveryId }] };
      }
      if (text.startsWith('SELECT delivery_id, endpoint_id, acknowledged_at FROM delivery_acknowledgements')) {
        const row = acknowledgements.find((entry) => entry.delivery_id === values[0]);
        return { rows: row ? [row] : [] };
      }
      if (text.startsWith('SELECT * FROM deliveries')) {
        return { rows: [{ delivery_id: values[0], recipient_endpoint_id: values[1], state: deliveryState }] };
      }
      if (text.startsWith('UPDATE deliveries')) {
        return { rows: [{ delivery_id: values[1], state: 'acknowledged' }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  return { calls, acknowledgements, async connect() { return client; }, async end() {} };
}

test('acknowledgeDelivery records a fresh ack and transitions the delivery', async () => {
  const pool = fakeAckPool();
  const result = await new PostgresRepository({ pool }).acknowledgeDelivery({ deliveryId: 'del_1', endpointId: 'ep_claude', now: new Date('2026-08-14T00:00:00Z') });
  assert.equal(result.duplicate, false);
  assert.equal(result.delivery.state, 'acknowledged');
});

test('acknowledgeDelivery replays idempotently for a retried ack of the same delivery', async () => {
  const pool = fakeAckPool({ priorAck: { delivery_id: 'del_1', endpoint_id: 'ep_claude', acknowledged_at: '2026-08-14T00:00:00.000Z' } });
  const result = await new PostgresRepository({ pool }).acknowledgeDelivery({ deliveryId: 'del_1', endpointId: 'ep_claude', now: new Date('2026-08-14T00:05:00Z') });
  assert.equal(result.duplicate, true);
  assert.equal(result.acknowledged_at, '2026-08-14T00:00:00.000Z');
  assert.ok(!pool.calls.some((call) => call.text.startsWith('UPDATE deliveries')));
});

test('acknowledgeDelivery rejects a conflicting ack from a different endpoint', async () => {
  const pool = fakeAckPool({ priorAck: { delivery_id: 'del_1', endpoint_id: 'ep_claude', acknowledged_at: '2026-08-14T00:00:00.000Z' } });
  await assert.rejects(
    () => new PostgresRepository({ pool }).acknowledgeDelivery({ deliveryId: 'del_1', endpointId: 'ep_other', now: new Date('2026-08-14T00:05:00Z') }),
    { code: 'DELIVERY_UNAVAILABLE' }
  );
});

test('acknowledgeDelivery rejects a delivery that cannot reach acknowledged', async () => {
  const pool = fakeAckPool({ deliveryState: 'delivery_rejected' });
  await assert.rejects(
    () => new PostgresRepository({ pool }).acknowledgeDelivery({ deliveryId: 'del_1', endpointId: 'ep_claude', now: new Date('2026-08-14T00:00:00Z') }),
    { code: 'INVALID_STATE_TRANSITION' }
  );
});

test('lookupTaskRequest returns the accepted task.request row for the conversation', async () => {
  const calls = [];
  const pool = { async query(text, values) { calls.push({ text, values }); return { rows: [{ message_id: 'msg_original' }] }; } };
  const result = await new PostgresRepository({ pool }).lookupTaskRequest('task_1', 'conv_1');
  assert.deepEqual(result, { message_id: 'msg_original' });
  assert.match(calls[0].text, /message_type = 'task\.request'/);
  assert.deepEqual(calls[0].values, ['conv_1', 'task_1']);
});

test('lookupTaskRequest returns null when no accepted task.request matches', async () => {
  const pool = { async query() { return { rows: [] }; } };
  const result = await new PostgresRepository({ pool }).lookupTaskRequest('task_missing', 'conv_1');
  assert.equal(result, null);
});

test('repository registers WebAuthn credential for active human', async () => {
  const calls = [];
  const pool = { async query(text, values) { calls.push({ text, values }); return { rows: [{ credential_id: 'cred_1', human_id: 'usr_1', type: 'webauthn', status: 'active' }] }; } };
  const result = await new PostgresRepository({ pool }).registerHumanCredential({ humanId: 'usr_1', endpointId: 'ep_codex', credentialId: 'cred_1', publicKey: Buffer.from('key') });
  assert.equal(result.credential_id, 'cred_1'); assert.equal(calls.length, 1); assert.match(calls[0].text, /INSERT INTO human_credentials/);
});
