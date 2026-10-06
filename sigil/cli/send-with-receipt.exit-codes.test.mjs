import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sendWithOptionalReceiptWait, ReceiptWaitError, RECEIPT_WAIT_EXIT_CODES } from './send-with-receipt.mjs';

class FakeSocket extends EventEmitter {
  close() { this.emit('close'); }
}

function harness({ sendEnvelope } = {}) {
  let socket;
  class WebSocketImpl extends FakeSocket {
    constructor() { super(); socket = this; }
  }
  const relay = { sendEnvelope: sendEnvelope ?? (async () => ({ message_id: 'msg_1', duplicate: false })) };
  const printed = [];
  const envelope = { message_id: 'msg_1', conversation_id: 'conv_1', recipient: { endpoint_id: 'ep_b' } };
  const promise = sendWithOptionalReceiptWait({
    relay,
    envelope,
    waitForReceipt: true,
    streamUrl: 'ws://stream',
    token: 'tok',
    WebSocketImpl,
    timeoutMs: 30,
    print: (line) => printed.push(line),
  });
  return { promise, printed, getSocket: () => socket };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

const receipt = (state, extra = {}) => JSON.stringify({
  type: 'delivery.receipt',
  message_id: 'msg_1',
  delivery_id: 'del_1',
  recipient_endpoint_id: 'ep_b',
  state,
  at: '2026-10-06T00:00:00Z',
  ...extra,
});

test('timeout after acceptance rejects with exit 8, not 0 or 2', async () => {
  const { promise, printed, getSocket } = harness();
  await tick();
  getSocket().emit('open');
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ReceiptWaitError);
    assert.equal(error.exitCode, RECEIPT_WAIT_EXIT_CODES.TIMEOUT);
    assert.equal(error.exitCode, 8);
    assert.notEqual(error.exitCode, 2);
    assert.match(error.message, /msg_1/);
    assert.match(error.message, /do not resend/i);
    assert.deepEqual(error.pending, ['ep_b']);
    return true;
  });
  assert.ok(printed.some((line) => line.includes('Sent. message_id=msg_1')), 'sent line still prints');
});

test('timeout before the stream opens is a plain failure, not exit 8', async () => {
  const { promise } = harness();
  await assert.rejects(promise, (error) => {
    assert.ok(!(error instanceof ReceiptWaitError));
    assert.match(error.message, /did not open/);
    assert.equal(error.exitCode, undefined);
    return true;
  });
});

test('send rejected before acceptance keeps a plain error with no exit code', async () => {
  const { promise, getSocket } = harness({
    sendEnvelope: async () => { throw new Error('relay rejected: 403'); },
  });
  await tick();
  getSocket().emit('open');
  await assert.rejects(promise, (error) => {
    assert.ok(!(error instanceof ReceiptWaitError));
    assert.match(error.message, /403/);
    assert.equal(error.exitCode, undefined);
    return true;
  });
});

for (const state of ['processing_failed', 'dead_letter']) {
  test(`${state} receipt rejects with exit 7 and a do-not-resend line`, async () => {
    const { promise, getSocket } = harness();
    await tick();
    getSocket().emit('open');
    await tick();
    getSocket().emit('message', receipt(state));
    await assert.rejects(promise, (error) => {
      assert.ok(error instanceof ReceiptWaitError);
      assert.equal(error.exitCode, RECEIPT_WAIT_EXIT_CODES.FAILED);
      assert.equal(error.exitCode, 7);
      assert.match(error.message, /do not resend/i);
      assert.match(error.message, new RegExp(state));
      return true;
    });
  });
}

test('acknowledged receipt still resolves with no exit code', async () => {
  const { promise, getSocket } = harness();
  await tick();
  getSocket().emit('open');
  await tick();
  getSocket().emit('message', receipt('acknowledged'));
  const result = await promise;
  assert.equal(result.message_id, 'msg_1');
});

test('timeout lists only recipients that have not reached a terminal state', async () => {
  const { promise, getSocket } = harness();
  await tick();
  getSocket().emit('open');
  await tick();
  getSocket().emit('message', receipt('delivered'));
  await assert.rejects(promise, (error) => {
    assert.equal(error.exitCode, 8);
    assert.deepEqual(error.pending, ['ep_b']);
    return true;
  });
});
