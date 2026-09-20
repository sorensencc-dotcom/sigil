import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentMailControl } from './agentmail-control.mjs';

function fakeRepository() {
  const state = { control_id: 'agentmail', state: 'disabled', version: 1, lease_owner: null, lease_expires_at: null, reason: 'bootstrap', updated_by: 'system', updated_at: new Date().toISOString() };
  const queries = []; const audits = [];
  const repository = {
    state, queries, audits,
    async query(text, values) {
      queries.push(text);
      if (text.includes('SELECT')) return { rows: [{ ...state }] };
      if (text.startsWith('UPDATE') && text.includes('state =')) { state.state = values[1]; state.version = values[2]; state.reason = values[3]; state.updated_by = values[4]; return { rowCount: 1, rows: [] }; }
      if (text.startsWith('UPDATE') && text.includes('lease_owner = $2')) { state.lease_owner = values[1]; state.lease_expires_at = values[2]; return { rowCount: 1, rows: [] }; }
      if (text.startsWith('UPDATE') && text.includes('lease_owner = NULL')) { state.lease_owner = null; state.lease_expires_at = null; return { rowCount: 1, rows: [] }; }
      return { rowCount: 1, rows: [] };
    },
    async withTransaction(work) { return work({ query: (text, values) => repository.query(text, values) }); },
    async recordAuditEvent(entry) { audits.push(entry); },
  };
  return repository;
}

test('control transitions lock, version, audit, and notify after commit', async () => {
  const repository = fakeRepository(); const notifications = [];
  const control = createAgentMailControl({ repository, notify: async (entry) => notifications.push(entry), refreshMs: 0 });
  const result = await control.transition({ action: 'resume', expectedVersion: 1, snapshotGeneration: 'g1', actorId: 'ep_operator', requestId: 'req_1', reason: 'synthetic' });
  assert.equal(result.state, 'enabled');
  assert.equal(result.version, 2);
  assert.equal(repository.queries.some((query) => query.includes('FOR UPDATE')), true);
  assert.equal(repository.audits.length, 1);
  assert.equal(notifications[0].payload.version, 2);
});

test('control rejects stale versions and conflicting leases', async () => {
  const repository = fakeRepository(); const control = createAgentMailControl({ repository, refreshMs: 0 });
  await assert.rejects(control.transition({ action: 'resume', expectedVersion: 9, snapshotGeneration: 'g1' }), { code: 'CONTROL_VERSION_CONFLICT' });
  await control.acquireLease({ ownerId: 'rotation-1', ttlMs: 1000 });
  await assert.rejects(control.acquireLease({ ownerId: 'rotation-2', ttlMs: 1000 }), { code: 'CONTROL_LEASE_CONFLICT' });
  await control.releaseLease({ ownerId: 'rotation-1' });
});

test('cache fails closed when stale and coalesces refreshes', async () => {
  const repository = fakeRepository(); let now = new Date('2026-09-20T12:00:00Z');
  const control = createAgentMailControl({ repository, refreshMs: 0, maxStaleMs: 10, clock: () => now });
  const [one, two] = await Promise.all([control.cache.refresh(), control.cache.refresh()]);
  assert.equal(one.state, 'disabled');
  assert.deepEqual(two, one);
  now = new Date(now.getTime() + 11);
  assert.equal(control.cache.current().state, 'disabled');
  assert.equal(control.cache.current().reason, 'control cache is stale');
  control.cache.close();
});
