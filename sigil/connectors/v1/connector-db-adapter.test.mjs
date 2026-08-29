import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorDatabase } from './connector-db-adapter.mjs';

function withDatabase(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sigil-connector-db-'));
  const db = new ConnectorDatabase(join(dir, 'connector.db'), new URL('./connector-schema.sql', import.meta.url));
  db.upsertProfile({
    profile_id: 'prof_test',
    owner_id: 'usr_test',
    endpoint_id: 'ep_test',
    display_name: 'Test endpoint',
    relay_url: 'ws://127.0.0.1:8793/v1/stream',
    secure_key_reference: 'key://test',
    secure_token_reference: 'token://test'
  });
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('profile upsert updates mutable connection metadata without changing identity', () => withDatabase((db) => {
  db.upsertProfile({
    profile_id: 'prof_test',
    owner_id: 'usr_other',
    endpoint_id: 'ep_other',
    display_name: 'Renamed endpoint',
    relay_url: 'ws://relay.example/v1/stream',
    status: 'suspended',
    secure_key_reference: 'key://rotated',
    secure_token_reference: 'token://rotated'
  });

  const profile = db.getProfile('prof_test');
  assert.equal(profile.endpoint_id, 'ep_test');
  assert.equal(profile.owner_id, 'usr_test');
  assert.equal(profile.display_name, 'Renamed endpoint');
  assert.equal(profile.status, 'suspended');
  assert.equal(profile.relay_url, 'ws://relay.example/v1/stream');
}));

test('context cache access refreshes last-accessed time and expiry sweep returns paths', () => withDatabase((db) => {
  db.setContextCache({
    integrity_hash: 'sha256:cache1',
    kind: 'file',
    scope: 'scope:conversation/conv1',
    local_storage_path: 'C:/cache/one',
    size_bytes: 12,
    expires_at: '2099-01-01T00:00:00.000Z'
  });

  const cached = db.getContextCache('sha256:cache1');
  assert.equal(cached.local_storage_path, 'C:/cache/one');
  assert.equal(db.sweepExpiredCache(new Date('2098-12-31T23:59:59.000Z')).length, 0);

  db.setContextCache({
    integrity_hash: 'sha256:expired',
    kind: 'artifact',
    scope: 'scope:conversation/conv1',
    local_storage_path: 'C:/cache/expired',
    size_bytes: 4,
    expires_at: '2026-01-01T00:00:00.000Z'
  });
  assert.deepEqual(db.sweepExpiredCache(new Date('2026-01-02T00:00:00.000Z')), ['C:/cache/expired']);
  assert.equal(db.getContextCache('sha256:expired'), null);
}));

test('approval decision updates status, signature, and decision timestamp', () => withDatabase((db) => {
  db.createApprovalPrompt('approval_1', 'prof_test', 'sha256:action', 'sigil.task/submit', 'scope:conversation/conv1', 'ep_test');
  db.commitApprovalDecision('approval_1', 'approved', 'sig:decision');

  const approval = db.getApproval('approval_1');
  assert.equal(approval.status, 'approved');
  assert.equal(approval.decision_signature, 'sig:decision');
  assert.match(approval.decided_at, /^\d{4}-\d{2}-\d{2}T/);
}));

test('outbox duplicate idempotency key is ignored and pending query excludes expired messages', () => withDatabase((db) => {
  const envelope = {
    message_id: 'msg_out_1',
    conversation_id: 'conv_1',
    message_type: 'task.result',
    recipient: { endpoint_id: 'ep_remote' },
    body: { status: 'completed' },
    canonical_hash: 'sha256:out',
    signature_value: 'sig:out',
    idempotency_key: 'idem_1',
    expires_at: '2099-01-01T00:00:00.000Z'
  };
  db.queueOutboundMessage('out_1', 'prof_test', envelope);
  db.queueOutboundMessage('out_2', 'prof_test', { ...envelope, message_id: 'msg_out_2' });
  db.queueOutboundMessage('out_3', 'prof_test', { ...envelope, message_id: 'msg_out_3', idempotency_key: 'idem_3', expires_at: '2020-01-01T00:00:00.000Z' });

  const pending = db.getPendingOutboundQueue(new Date('2026-08-20T00:00:00.000Z'));
  assert.deepEqual(pending.map((row) => row.message_id), ['msg_out_1']);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM outbox_messages').get().count, 2);
}));

test('endpoint keys cache operations store, retrieve, and isolate by profile', () => withDatabase((db) => {
  db.upsertKeyCache({
    profile_id: 'prof_test',
    endpoint_id: 'ep_test@relay.example',
    key_id: 'key_1',
    algorithm: 'Ed25519',
    public_key_base64url: 'MCowBQYDK2VwAyEA1111111111111111111111111111111111111111111=',
    valid_from: '2026-08-01T00:00:00.000Z',
    valid_until: '2026-09-01T00:00:00.000Z',
    status: 'active',
    synced_sequence: 1
  });

  const key = db.getKeyCache('prof_test', 'ep_test@relay.example', 'key_1');
  assert.equal(key.key_id, 'key_1');
  assert.equal(key.status, 'active');
  assert.equal(db.getKeyCache('prof_other', 'ep_test@relay.example', 'key_1'), null);
}));

test('batch revocation interval upsert atomically commits intervals within a transaction', () => withDatabase((db) => {
  db.batchUpsertRevocationIntervals('prof_test', [
    {
      revocation_event_id: 'rev_1',
      endpoint_id: 'ep_test@relay.example',
      key_id: 'key_1',
      revoked_at: '2026-08-28T12:00:00.000Z',
      reason: 'compromised',
      valid_from: '2026-08-01T00:00:00.000Z',
      valid_until: '2026-09-01T00:00:00.000Z'
    }
  ], 10);

  const record = db.getRevocationInterval('prof_test', 'ep_test@relay.example', 'key_1');
  assert.equal(record.revoked_at, '2026-08-28T12:00:00.000Z');
  assert.equal(record.reason, 'compromised');

  const list = db.listRevocationIntervalsForEndpoint('prof_test', 'ep_test@relay.example');
  assert.equal(list.length, 1);
}));

