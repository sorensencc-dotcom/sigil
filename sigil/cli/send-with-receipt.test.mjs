import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sendWithOptionalReceiptWait } from './send-with-receipt.mjs';

class ScriptedSocket extends EventEmitter {
  constructor() { super(); this.sent = []; }
  send(raw) { this.sent.push(raw); }
  close() { this.emit('close'); }
  terminate() {}
}

test('opens the receipt stream and waits for it to be listening before sending the envelope, so an immediate receipt is never missed', async () => {
  const events = [];
  let socket;
  const WebSocketImpl = class extends ScriptedSocket {
    constructor(...args) {
      super(...args);
      socket = this;
      events.push('socket-constructed');
    }
  };
  const relay = {
    async sendEnvelope(envelope) {
      events.push('sendEnvelope-called');
      // Simulate the relay pushing the accept-time 'delivered' receipt the
      // instant the envelope is accepted -- this fires synchronously with
      // respect to sendEnvelope resolving, before the caller gets control
      // back. A correctly-ordered client must already be listening.
      queueMicrotask(() => socket.emit('message', JSON.stringify({
        type: 'delivery.receipt', message_id: 'msg_1', delivery_id: 'del_1', state: 'delivered', at: '2026-08-16T00:00:00Z',
      })));
      return { message_id: 'msg_1', duplicate: false };
    },
  };
  const printed = [];

  const resultPromise = sendWithOptionalReceiptWait({
    relay, envelope: { message_id: 'msg_1', conversation_id: 'conv_1' }, waitForReceipt: true,
    streamUrl: 'ws://stream', token: 'tok', WebSocketImpl, timeoutMs: 2000,
    print: (line) => printed.push(line),
  });

  // The socket must exist and be past 'open' -- i.e. already listening for
  // 'message' -- before sendEnvelope is invoked.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(socket, 'socket should be constructed before send resolves');
  socket.emit('open');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ['socket-constructed', 'sendEnvelope-called']);

  // Now let the accept-time receipt (queued via queueMicrotask above) and
  // a terminal receipt arrive.
  socket.emit('message', JSON.stringify({
    type: 'delivery.receipt', message_id: 'msg_1', delivery_id: 'del_1', state: 'acknowledged', at: '2026-08-16T00:00:01Z',
  }));

  const result = await resultPromise;
  assert.equal(result.message_id, 'msg_1');
  assert.ok(printed.some((line) => line.includes('delivered')), 'the accept-time delivered receipt must not be lost to the race');
  assert.ok(printed.some((line) => line.includes('acknowledged')));
});

test('does not open a stream at all when waitForReceipt is false, but still prints the Sent confirmation', async () => {
  let constructed = false;
  const WebSocketImpl = class extends ScriptedSocket { constructor(...args) { super(...args); constructed = true; } };
  const relay = { async sendEnvelope() { return { message_id: 'msg_2', duplicate: false }; } };
  const printed = [];

  const result = await sendWithOptionalReceiptWait({
    relay, envelope: { message_id: 'msg_2', conversation_id: 'conv_2' }, waitForReceipt: false,
    streamUrl: 'ws://stream', token: 'tok', WebSocketImpl, print: (line) => printed.push(line),
  });

  assert.equal(constructed, false);
  assert.equal(result.message_id, 'msg_2');
  assert.ok(printed.some((line) => line.includes('Sent.') && line.includes('msg_2')), 'must still print the Sent confirmation without --wait-for-receipt');
});
