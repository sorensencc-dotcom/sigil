import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnector } from './connector.mjs';

function fixture() {
  const calls = []; const stored = new Map();
  const outbox = { queue(envelope) { stored.set(envelope.message_id, { envelope, state: 'pending' }); return stored.get(envelope.message_id); }, markAccepted(id) { stored.get(id).state = 'accepted'; } };
  const inbox = { receive(item) { stored.set(item.message_id, item); return { message: item }; }, get(id) { return stored.get(id) ?? null; } };
  const relay = { async sendEnvelope(envelope) { calls.push(['send', envelope]); return { message_id: envelope.message_id }; }, async reconcileInbox() { return { items: [{ delivery_id: 'd2', message_id: 'm2', envelope: { message_id: 'm2' } }], nextSince: 'c2' }; }, async acknowledge(id) { calls.push(['ack', id]); } };
  return { connector: createConnector({ relay, outbox, inbox }), calls, stored };
}

test('connector queues before relay send and reconciles inbox durably', async () => {
  const { connector, calls, stored } = fixture();
  assert.deepEqual(await connector.sendTask({ envelope: { message_id: 'm1' } }), { message_id: 'm1' });
  assert.equal(stored.get('m1').state, 'accepted');
  const page = await connector.checkInbox('c1');
  assert.equal(page.nextSince, 'c2'); assert.equal(page.items[0].message_id, 'm2');
  assert.deepEqual(calls, [['send', { message_id: 'm1' }], ['ack', 'd2']]);
});

test('connector keeps approval and context capabilities explicit', async () => {
  const { connector } = fixture();
  await assert.rejects(() => connector.requestApproval({}), { code: 'APPROVAL_REQUIRED' });
  await assert.rejects(() => connector.resolveContext('ref'), { code: 'CONTEXT_NOT_FOUND' });
});

test('connector exposes Claude processing only when explicitly configured', async () => {
  const { connector } = fixture();
  await assert.rejects(() => connector.processTask({ message_id: 'm1' }), { code: 'PROCESSING_UNAVAILABLE' });
  const configured = fixture().connector;
  const claude = (await import('./connector.mjs')).createConnector({
    relay: { sendEnvelope: async () => ({}), reconcileInbox: async () => ({ items: [], nextSince: '' }) },
    outbox: { queue: (envelope) => ({ envelope }), markAccepted() {} },
    inbox: { receive() {}, get() { return null; } },
    processTask: async (task) => ({ task, status: 'processed' }),
    submitResult: async (result) => ({ accepted: true, result })
  });
  assert.deepEqual(await claude.processTask({ message_id: 'm1' }), { task: { message_id: 'm1' }, status: 'processed' });
  assert.deepEqual(await claude.submitResult({ task_id: 't1' }), { accepted: true, result: { task_id: 't1' } });
  const states = [];
  const processing = (await import('./connector.mjs')).createConnector({
    relay: { sendEnvelope: async () => ({}), reconcileInbox: async () => ({ items: [], nextSince: '' }), async reportProcessing(...args) { states.push(args); } },
    outbox: { queue: (envelope) => ({ envelope }), markAccepted() {} }, inbox: { receive() {}, get() { return null; } },
    processTask: async () => ({ status: 'processed' })
  });
  assert.deepEqual(await processing.processDelivery({ deliveryId: 'd1', task: { message_id: 'm1' } }), { result: { status: 'processed' }, state: 'processed' });
  assert.deepEqual(states, [['d1', 'processing']]);
  void configured;
});

test('connector reports Claude processing failures before rethrowing', async () => {
  const states = [];
  const connector = (await import('./connector.mjs')).createConnector({
    relay: { sendEnvelope: async () => ({}), reconcileInbox: async () => ({ items: [], nextSince: '' }), async reportProcessing(...args) { states.push(args); } },
    outbox: { queue: (envelope) => ({ envelope }), markAccepted() {} }, inbox: { receive() {}, get() { return null; } },
    processTask: async () => { throw new Error('runtime failed'); }
  });
  await assert.rejects(() => connector.processDelivery({ deliveryId: 'd2', task: { message_id: 'm2' } }), { message: 'runtime failed' });
  assert.deepEqual(states, [['d2', 'processing'], ['d2', 'processing_failed', 'runtime failed']]);
});
