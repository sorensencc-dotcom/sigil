import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { INBOX_WAIT_EXIT_CODES, InboxWaitError, waitForOneInboxMessage } from './inbox-wait.mjs';

function item(id) {
  return { delivery_id: `delivery_${id}`, envelope: {
    created_at: '2026-08-16T00:00:00.000Z',
    sender: { endpoint_id: 'ep_claude' }, recipient: { endpoint_id: 'ep_codex' },
    message_type: 'chat.message', body: { text: id },
  } };
}

class IdleSocket extends EventEmitter {
  close() { this.emit('close'); }
}

test('wait consumes exactly one item and leaves the next item for the next invocation', async () => {
  const queue = [item('one'), item('two')];
  const acknowledged = [];
  const relay = {
    async reconcileInbox() { return { items: queue.slice() }; },
    async acknowledge(deliveryId) { acknowledged.push(deliveryId); queue.shift(); },
  };
  const output = [];
  const options = { relay, identity: { relay_token: 'token' }, streamUrl: 'ws://stream', WebSocketImpl: IdleSocket, print: (line) => output.push(line) };

  await waitForOneInboxMessage(options);
  await waitForOneInboxMessage(options);

  assert.deepEqual(acknowledged, ['delivery_one', 'delivery_two']);
  assert.equal(output.length, 2);
  assert.match(output[0], /one/);
  assert.match(output[1], /two/);
});

test('wait timeout exits with code 2 and acknowledges nothing', async () => {
  const acknowledged = [];
  await assert.rejects(
    waitForOneInboxMessage({
      relay: { async reconcileInbox() { return { items: [] }; }, async acknowledge(id) { acknowledged.push(id); } },
      identity: { relay_token: 'token' }, streamUrl: 'ws://stream', WebSocketImpl: IdleSocket, timeoutMs: 5,
    }),
    (error) => error instanceof InboxWaitError && error.exitCode === INBOX_WAIT_EXIT_CODES.TIMEOUT,
  );
  assert.deepEqual(acknowledged, []);
});

test('wait does not acknowledge malformed delivered items', async () => {
  const acknowledged = [];
  await assert.rejects(
    waitForOneInboxMessage({
      relay: { async reconcileInbox() { return { items: [{ delivery_id: 'bad', envelope: {} }] }; }, async acknowledge(id) { acknowledged.push(id); } },
      identity: { relay_token: 'token' }, streamUrl: 'ws://stream', WebSocketImpl: IdleSocket,
    }),
    (error) => error instanceof InboxWaitError && error.exitCode === INBOX_WAIT_EXIT_CODES.MALFORMED,
  );
  assert.deepEqual(acknowledged, []);
});
