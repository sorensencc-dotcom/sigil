import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentMailLedger } from './agentmail-ledger.mjs';

const base = { eventId: 'evt_1', providerEventId: 'evt_1', providerMessageId: 'msg_1', inboxId: 'inbox_a', idempotencyKey: 'agentmail:key', provenance: { classification: 'internal' } };

test('ledger is idempotent and enforces the ingress state machine', async () => {
  const ledger = createAgentMailLedger();
  const first = await ledger.recordIngressEvent(base);
  assert.equal(first.duplicate, false);
  const duplicate = await ledger.recordIngressEvent(base);
  assert.equal(duplicate.duplicate, true);
  assert.equal((await ledger.transitionIngressState('evt_1', 'quarantined')).state, 'quarantined');
  assert.equal((await ledger.transitionIngressState('evt_1', 'accepted')).state, 'accepted');
  assert.equal((await ledger.transitionIngressState('evt_1', 'dispatched')).state, 'dispatched');
  assert.equal((await ledger.transitionIngressState('evt_1', 'completed')).state, 'completed');
  await assert.rejects(ledger.transitionIngressState('evt_1', 'accepted'), { code: 'INGRESS_STATE_INVALID' });
});

test('ledger rejects out-of-order transitions and requires operator-approved replay', async () => {
  const ledger = createAgentMailLedger();
  await ledger.recordIngressEvent({ ...base, eventId: 'evt_2', providerEventId: 'evt_2', idempotencyKey: 'agentmail:key2' });
  await assert.rejects(ledger.transitionIngressState('evt_2', 'dispatched'), { code: 'INGRESS_STATE_INVALID' });
  await ledger.transitionIngressState('evt_2', 'rejected');
  await assert.rejects(ledger.transitionIngressState('evt_2', 'quarantined'), { code: 'INGRESS_REPLAY_APPROVAL_REQUIRED' });
  assert.equal((await ledger.transitionIngressState('evt_2', 'quarantined', { operatorApprovedReplay: true })).state, 'quarantined');
});

test('ledger bounds queue depth per workflow', async () => {
  const ledger = createAgentMailLedger({ maxQueueDepth: 1 });
  await ledger.recordIngressEvent({ ...base, workflow: 'trm' });
  await assert.rejects(ledger.recordIngressEvent({ ...base, eventId: 'evt_3', providerEventId: 'evt_3', providerMessageId: 'msg_3', idempotencyKey: 'agentmail:key3', workflow: 'trm' }), { code: 'QUEUE_SATURATED' });
});

test('terminal states release memory queue depth', async () => {
  const ledger = createAgentMailLedger({ maxQueueDepth: 1 });
  await ledger.recordIngressEvent({ ...base, workflow: 'trm' });
  await ledger.transitionIngressState('evt_1', 'rejected');
  const next = await ledger.recordIngressEvent({ ...base, eventId: 'evt_4', providerEventId: 'evt_4', providerMessageId: 'msg_4', idempotencyKey: 'agentmail:key4', workflow: 'trm' });
  assert.equal(next.duplicate, false);
});
