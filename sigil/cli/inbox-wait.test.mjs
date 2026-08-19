import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { INBOX_WAIT_EXIT_CODES, InboxWaitError, waitForOneInboxMessage } from './inbox-wait.mjs';
import { readInboxLedger } from './ledger.mjs';

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

class SilentHeartbeatSocket extends EventEmitter {
  constructor() { super(); setImmediate(() => this.emit('open')); }
  send() {}
  close() { this.emit('close'); }
  terminate() {}
}

class PongReplyingSocket extends EventEmitter {
  constructor() { super(); setImmediate(() => this.emit('open')); }
  send(raw) {
    const message = JSON.parse(raw);
    if (message.type === 'ping') setImmediate(() => this.emit('message', JSON.stringify({ type: 'pong', timestamp: message.timestamp })));
  }
  close() { this.emit('close'); }
  terminate() {}
}

class DeliveredEventSocket extends EventEmitter {
  constructor() { super(); setImmediate(() => { this.emit('open'); this.emit('message', JSON.stringify({ type: 'delivered', message_id: 'msg_bad' })); }); }
  send() {}
  close() { this.emit('close'); }
  terminate() {}
}

class UnauthorizedStreamSocket extends EventEmitter {
  constructor() { super(); setImmediate(() => this.emit('unexpected-response', null, { statusCode: 401 })); }
  send() {}
  close() { this.emit('close'); }
  terminate() {}
}

class CloseThenSilentSocket extends EventEmitter {
  static created = 0;
  constructor() {
    super();
    this.id = ++CloseThenSilentSocket.created;
    setImmediate(() => {
      if (this.id === 1) this.emit('close');
      else this.emit('open');
    });
  }
  send() {}
  close() { this.emit('close'); }
  terminate() {}
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

test('wait records consumed message into local ledger before acknowledgment', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sigil-wait-ledger-'));
  const ledgerPath = path.join(tmpDir, 'inbox.jsonl');
  const queue = [item('ledger_test')];
  const acknowledged = [];
  const relay = {
    async reconcileInbox() { return { items: queue.slice() }; },
    async acknowledge(deliveryId) { acknowledged.push(deliveryId); queue.shift(); },
  };
  const output = [];

  await waitForOneInboxMessage({
    relay, identity: { relay_token: 'token' }, streamUrl: 'ws://stream',
    WebSocketImpl: IdleSocket, print: (line) => output.push(line), ledgerPath,
  });

  assert.deepEqual(acknowledged, ['delivery_ledger_test']);
  const records = await readInboxLedger(ledgerPath);
  assert.equal(records.length, 1);
  assert.equal(records[0].delivery_id, 'delivery_ledger_test');
  assert.equal(records[0].envelope.body.text, 'ledger_test');

  await fs.rm(tmpDir, { recursive: true, force: true });
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

test('stream-triggered wait does not acknowledge or print malformed delivered items', async () => {
  const acknowledged = [];
  const output = [];
  await assert.rejects(
    waitForOneInboxMessage({
      relay: { async reconcileInbox() { return { items: [{ delivery_id: 'bad_stream', envelope: {} }] }; }, async acknowledge(id) { acknowledged.push(id); } },
      identity: { relay_token: 'token' }, streamUrl: 'ws://stream', WebSocketImpl: DeliveredEventSocket, print: (line) => output.push(line),
    }),
    (error) => error instanceof InboxWaitError && error.exitCode === INBOX_WAIT_EXIT_CODES.MALFORMED,
  );
  assert.deepEqual(acknowledged, []);
  assert.deepEqual(output, []);
});

test('SIGINT rejects with exit code 130 and acknowledges nothing', async () => {
  const acknowledged = [];
  const signalSource = new EventEmitter();
  const pending = assert.rejects(
    waitForOneInboxMessage({
      relay: { async reconcileInbox() { return { items: [] }; }, async acknowledge(id) { acknowledged.push(id); } },
      identity: { relay_token: 'token' }, streamUrl: 'ws://stream', WebSocketImpl: IdleSocket, signalSource,
    }),
    (error) => error instanceof InboxWaitError && error.exitCode === INBOX_WAIT_EXIT_CODES.SIGINT,
  );
  signalSource.emit('SIGINT');
  await pending;
  assert.deepEqual(acknowledged, []);
});

test('SIGTERM rejects with exit code 143 and acknowledges nothing', async () => {
  const acknowledged = [];
  const signalSource = new EventEmitter();
  const pending = assert.rejects(
    waitForOneInboxMessage({
      relay: { async reconcileInbox() { return { items: [] }; }, async acknowledge(id) { acknowledged.push(id); } },
      identity: { relay_token: 'token' }, streamUrl: 'ws://stream', WebSocketImpl: IdleSocket, signalSource,
    }),
    (error) => error instanceof InboxWaitError && error.exitCode === INBOX_WAIT_EXIT_CODES.SIGTERM,
  );
  signalSource.emit('SIGTERM');
  await pending;
  assert.deepEqual(acknowledged, []);
});

test('SIGTERM during output rejects before acknowledging delivered item', async () => {
  const acknowledged = [];
  const output = [];
  const signalSource = new EventEmitter();
  await assert.rejects(
    waitForOneInboxMessage({
      relay: { async reconcileInbox() { return { items: [item('signal_before_ack')] }; }, async acknowledge(id) { acknowledged.push(id); } },
      identity: { relay_token: 'token' }, streamUrl: 'ws://stream', WebSocketImpl: IdleSocket, signalSource,
      print: async (line) => { output.push(line); signalSource.emit('SIGTERM'); },
    }),
    (error) => error instanceof InboxWaitError && error.exitCode === INBOX_WAIT_EXIT_CODES.SIGTERM,
  );
  assert.equal(output.length, 1);
  assert.deepEqual(acknowledged, []);
});

test('SIGINT during an in-flight reconcile does not print or acknowledge the item it returns', async () => {
  const acknowledged = [];
  const output = [];
  const signalSource = new EventEmitter();
  let releaseReconcile;
  const reconcileStarted = new Promise((resolve) => {
    releaseReconcile = () => resolve();
  });
  const relay = {
    async reconcileInbox() {
      // Let the test fire SIGINT while this call is still pending.
      await reconcileStarted;
      return { items: [item('late')] };
    },
    async acknowledge(id) { acknowledged.push(id); },
  };
  const pending = assert.rejects(
    waitForOneInboxMessage({ relay, identity: { relay_token: 'token' }, streamUrl: 'ws://stream', WebSocketImpl: IdleSocket, signalSource, print: (line) => output.push(line) }),
    (error) => error instanceof InboxWaitError && error.exitCode === INBOX_WAIT_EXIT_CODES.SIGINT,
  );
  signalSource.emit('SIGINT');
  releaseReconcile();
  await pending;
  assert.deepEqual(acknowledged, []);
  assert.deepEqual(output, []);
});

test('fails with RELAY_UNREACHABLE after exactly missedBeforeTimeout missed heartbeats, not one extra', async () => {
  const started = Date.now();
  await assert.rejects(
    waitForOneInboxMessage({
      relay: { async reconcileInbox() { return { items: [] }; }, async acknowledge() {} },
      identity: { relay_token: 'token' }, streamUrl: 'ws://stream',
      WebSocketImpl: SilentHeartbeatSocket,
      heartbeat: { intervalMs: 100, missedBeforeTimeout: 1 },
    }),
    (error) => error instanceof InboxWaitError && error.exitCode === INBOX_WAIT_EXIT_CODES.RELAY_UNREACHABLE,
  );
  // missedBeforeTimeout: 1 means the FIRST missed heartbeat must trip it --
  // one interval (~100ms), not two (~200ms+). Bound set well under 2x to
  // stay clear of the old off-by-one while tolerating scheduler jitter.
  assert.ok(Date.now() - started < 170, `expected failure within ~1 interval, took ${Date.now() - started}ms`);
});

test('stream 401 maps to auth exit code and acknowledges nothing', async () => {
  const acknowledged = [];
  await assert.rejects(
    waitForOneInboxMessage({
      relay: { async reconcileInbox() { return { items: [] }; }, async acknowledge(id) { acknowledged.push(id); } },
      identity: { relay_token: 'bad-token' }, streamUrl: 'ws://stream', WebSocketImpl: UnauthorizedStreamSocket,
    }),
    (error) => error instanceof InboxWaitError && error.exitCode === INBOX_WAIT_EXIT_CODES.AUTH && error.message === 'Authentication required',
  );
  assert.deepEqual(acknowledged, []);
});

test('reconnected stream still maps missed heartbeat to RELAY_UNREACHABLE', async () => {
  CloseThenSilentSocket.created = 0;
  await assert.rejects(
    waitForOneInboxMessage({
      relay: { async reconcileInbox() { return { items: [] }; }, async acknowledge() {} },
      identity: { relay_token: 'token' }, streamUrl: 'ws://stream',
      WebSocketImpl: CloseThenSilentSocket,
      heartbeat: { intervalMs: 20, missedBeforeTimeout: 1 },
    }),
    (error) => error instanceof InboxWaitError && error.exitCode === INBOX_WAIT_EXIT_CODES.RELAY_UNREACHABLE,
  );
  assert.equal(CloseThenSilentSocket.created >= 2, true);
});

test('a pong reply resets the missed-heartbeat counter, so a live relay never trips RELAY_UNREACHABLE', async () => {
  const signalSource = new EventEmitter();
  const pending = assert.rejects(
    waitForOneInboxMessage({
      relay: { async reconcileInbox() { return { items: [] }; }, async acknowledge() {} },
      identity: { relay_token: 'token' }, streamUrl: 'ws://stream',
      WebSocketImpl: PongReplyingSocket, signalSource,
      heartbeat: { intervalMs: 15, missedBeforeTimeout: 2 },
    }),
    (error) => error instanceof InboxWaitError && error.exitCode === INBOX_WAIT_EXIT_CODES.SIGINT,
  );
  // Outlive several heartbeat intervals (each answered with a pong) before
  // ending the wait deliberately -- if pong didn't reset the counter this
  // would already have failed with RELAY_UNREACHABLE by now.
  await new Promise((resolve) => setTimeout(resolve, 80));
  signalSource.emit('SIGINT');
  await pending;
});

test('cleanup removes signal listeners so they do not leak across invocations', async () => {
  const signalSource = new EventEmitter();
  await waitForOneInboxMessage({
    relay: { async reconcileInbox() { return { items: [item('one')] }; }, async acknowledge() {} },
    identity: { relay_token: 'token' }, streamUrl: 'ws://stream', WebSocketImpl: IdleSocket, signalSource, print: () => {},
  });
  assert.equal(signalSource.listenerCount('SIGINT'), 0);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
});
