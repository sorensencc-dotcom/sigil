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
  assert.deepEqual(row, { message_id: 'msg_1' });
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
