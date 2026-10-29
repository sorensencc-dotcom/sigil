import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentDaemon } from './agent-daemon.mjs';
import { createIdentity } from './identity.mjs';
import { EventEmitter } from 'node:events';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeWorkerScript = path.resolve(here, '..', 'scripts', 'claude-worker.mjs');

test('agent daemon does not pass unrelated environment secrets to its worker', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sigil-worker-env-'));
  const workerScript = path.join(tempDir, 'worker.mjs');
  const originalSecret = process.env.AWS_SECRET_ACCESS_KEY;
  const originalOllamaFallback = process.env.SIGIL_OLLAMA_FALLBACK;
  process.env.AWS_SECRET_ACCESS_KEY = 'worker-env-regression-secret';
  process.env.SIGIL_OLLAMA_FALLBACK = '1';

  try {
    await fs.writeFile(workerScript, 'process.stdout.write(JSON.stringify({ secret: process.env.AWS_SECRET_ACCESS_KEY ?? null, ollamaFallback: process.env.SIGIL_OLLAMA_FALLBACK ?? null }));\n');
    const daemon = createAgentDaemon({
      identity: createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_claude', kind: 'agent' }),
      relayUrl: 'http://127.0.0.1:8791',
      workerCommand: process.execPath,
      workerArgs: [workerScript]
    });

    assert.deepEqual(await daemon.executeWorker({}), { secret: null, ollamaFallback: '1' });
  } finally {
    if (originalSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = originalSecret;
    if (originalOllamaFallback === undefined) delete process.env.SIGIL_OLLAMA_FALLBACK;
    else process.env.SIGIL_OLLAMA_FALLBACK = originalOllamaFallback;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('agent daemon executes local worker on task.request and sends signed task.result reply', async () => {
  const claudeIdentity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_claude', kind: 'agent' });
  const sentEnvelopes = [];
  const ackCalls = [];
  const reports = [];

  const fakeFetch = async (url, options = {}) => {
    const urlStr = url.toString();
    if (urlStr.includes('/v1/inbox')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          items: [{
            delivery_id: 'del_task_1',
            envelope: {
              protocol: 'sigil/1',
              message_id: 'msg_req_1',
              conversation_id: 'conv_agent_1',
              message_type: 'task.request',
              sender: { owner_id: 'usr_soren', endpoint_id: 'ep_codex' },
              recipient: { owner_id: 'usr_soren', endpoint_id: 'ep_claude' },
              body: { task_id: 'task_1', instruction: 'Audit dependencies' }
            }
          }]
        })
      };
    }
    if (urlStr.includes('/v1/envelopes')) {
      const body = JSON.parse(options.body);
      sentEnvelopes.push(body);
      return {
        ok: true,
        status: 202,
        text: async () => JSON.stringify({ code: 'OK', message_id: body.message_id })
      };
    }
    if (urlStr.includes('/processing')) {
      const body = JSON.parse(options.body);
      reports.push(body);
      return {
        ok: true,
        status: 204,
        text: async () => ''
      };
    }
    if (urlStr.includes('/ack')) {
      ackCalls.push(urlStr);
      return {
        ok: true,
        status: 204,
        text: async () => ''
      };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;

  try {
    const daemon = createAgentDaemon({
      identity: claudeIdentity,
      relayUrl: 'http://127.0.0.1:8791',
      workerCommand: process.execPath,
      workerArgs: [fakeWorkerScript],
      autoReply: true
    });

    const count = await daemon.poll();
    assert.equal(count, 1);
    assert.equal(reports.length, 2);
    assert.equal(reports[0].state, 'processing');
    assert.equal(reports[1].state, 'processed');
    assert.equal(sentEnvelopes.length, 1);
    assert.equal(sentEnvelopes[0].message_type, 'task.result');
    assert.equal(sentEnvelopes[0].correlation_id, 'msg_req_1');
    assert.equal(sentEnvelopes[0].recipient.endpoint_id, 'ep_codex');
    assert.equal(sentEnvelopes[0].body.task_id, 'task_1');
    assert.equal(sentEnvelopes[0].body.status, 'completed');
    assert.equal(ackCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent daemon derives the reply idempotency key from the inbound message_id, so redelivery cannot create a duplicate reply envelope', async () => {
  const claudeIdentity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_claude', kind: 'agent' });
  const sentEnvelopes = [];
  const inboundEnvelope = {
    protocol: 'sigil/1',
    message_id: 'msg_redelivered_1',
    conversation_id: 'conv_agent_redelivery',
    message_type: 'task.request',
    sender: { owner_id: 'usr_soren', endpoint_id: 'ep_codex' },
    recipient: { owner_id: 'usr_soren', endpoint_id: 'ep_claude' },
    body: { task_id: 'task_redelivered_1', instruction: 'Audit dependencies' }
  };

  const fakeFetch = async (url, options = {}) => {
    const urlStr = url.toString();
    if (urlStr.includes('/v1/inbox')) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ items: [{ delivery_id: 'del_redelivered_1', envelope: inboundEnvelope }] })
      };
    }
    if (urlStr.includes('/v1/envelopes')) {
      const body = JSON.parse(options.body);
      sentEnvelopes.push(body);
      return { ok: true, status: 202, text: async () => JSON.stringify({ code: 'OK', message_id: body.message_id }) };
    }
    return { ok: true, status: 204, text: async () => '' };
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;

  try {
    const daemon = createAgentDaemon({
      identity: claudeIdentity,
      relayUrl: 'http://127.0.0.1:8791',
      workerCommand: process.execPath,
      workerArgs: [fakeWorkerScript],
      autoReply: true
    });

    // Simulate the relay redelivering the same inbound message twice (e.g. the
    // first ack never reached it). Both poll() calls process the same envelope.
    await daemon.processItem({ delivery_id: 'del_redelivered_1', envelope: inboundEnvelope });
    await daemon.processItem({ delivery_id: 'del_redelivered_2', envelope: inboundEnvelope });

    assert.equal(sentEnvelopes.length, 2);
    assert.notEqual(sentEnvelopes[0].message_id, sentEnvelopes[1].message_id, 'message_id may still vary per attempt');
    assert.equal(sentEnvelopes[0].idempotency_key, sentEnvelopes[1].idempotency_key);
    assert.equal(sentEnvelopes[0].idempotency_key, `reply_${inboundEnvelope.message_id}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent daemon reports processing_failed when worker fails', async () => {
  const claudeIdentity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_claude', kind: 'agent' });
  const ackCalls = [];
  const reports = [];

  const fakeFetch = async (url, options = {}) => {
    const urlStr = url.toString();
    if (urlStr.includes('/v1/inbox')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          items: [{
            delivery_id: 'del_task_fail_1',
            envelope: {
              protocol: 'sigil/1',
              message_id: 'msg_req_fail',
              conversation_id: 'conv_fail_1',
              message_type: 'task.request',
              sender: { owner_id: 'usr_soren', endpoint_id: 'ep_codex' },
              body: { task_id: 'task_fail', instruction: 'fail' }
            }
          }]
        })
      };
    }
    if (urlStr.includes('/processing')) {
      const body = JSON.parse(options.body);
      reports.push(body);
      return { ok: true, status: 204, text: async () => '' };
    }
    if (urlStr.includes('/ack')) {
      ackCalls.push(urlStr);
      return { ok: true, status: 204, text: async () => '' };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;

  try {
    const daemon = createAgentDaemon({
      identity: claudeIdentity,
      relayUrl: 'http://127.0.0.1:8791',
      workerCommand: process.execPath,
      workerArgs: ['-e', 'process.exit(1)'],
      autoReply: true
    });

    const count = await daemon.poll();
    assert.equal(count, 1);
    assert.equal(reports.length, 2);
    assert.equal(reports[0].state, 'processing');
    assert.equal(reports[1].state, 'processing_failed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent daemon durably persists inbox intake and outbox state when dbPath is provided', async () => {
  const { tmpdir } = await import('node:os');
  const claudeIdentity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_claude', kind: 'agent' });
  const tmpDb = path.join(tmpdir(), `test-daemon-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

  const fakeFetch = async (url, options = {}) => {
    const urlStr = url.toString();
    if (urlStr.includes('/v1/inbox')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          items: [{
            delivery_id: 'del_task_db_1',
            envelope: {
              protocol: 'sigil/1',
              message_id: 'msg_req_db_1',
              conversation_id: 'conv_agent_db_1',
              message_type: 'task.request',
              sender: { owner_id: 'usr_soren', endpoint_id: 'ep_codex' },
              recipient: { owner_id: 'usr_soren', endpoint_id: 'ep_claude' },
              body: { task_id: 'task_db_1', instruction: 'Audit with db' }
            }
          }]
        })
      };
    }
    if (urlStr.includes('/v1/envelopes')) {
      const body = JSON.parse(options.body);
      return {
        ok: true,
        status: 202,
        text: async () => JSON.stringify({ code: 'OK', message_id: body.message_id })
      };
    }
    return { ok: true, status: 204, text: async () => '' };
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;

  try {
    const daemon = createAgentDaemon({
      identity: claudeIdentity,
      relayUrl: 'http://127.0.0.1:8791',
      dbPath: tmpDb,
      workerCommand: process.execPath,
      workerArgs: [fakeWorkerScript],
      autoReply: true
    });

    const count = await daemon.poll();
    assert.equal(count, 1);
    assert.notEqual(daemon.db, null);

    const inboxMsg = daemon.db.getInboxMessage('msg_req_db_1');
    assert.notEqual(inboxMsg, null);
    assert.equal(inboxMsg.processing_state, 'processed');

    daemon.db.close();
  } finally {
    globalThis.fetch = originalFetch;
    try { (await import('node:fs')).unlinkSync(tmpDb); } catch {}
  }
});


test('agent daemon ignores unsupported message types without executing or acknowledging them', async () => {
  const identity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_claude', kind: 'agent' });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url.toString());
    return { ok: true, status: 204, text: async () => '' };
  };

  try {
    const daemon = createAgentDaemon({
      identity,
      relayUrl: 'http://127.0.0.1:8791',
      workerCommand: process.execPath,
      workerArgs: ['-e', 'throw new Error("worker must not run")']
    });

    await daemon.processItem({
      delivery_id: 'del_notice_1',
      envelope: {
        protocol: 'sigil/1',
        message_id: 'msg_notice_1',
        message_type: 'status.notice',
        sender: { owner_id: 'usr_soren', endpoint_id: 'ep_codex' },
        body: { text: 'not a task' }
      }
    });

    assert.equal(calls.filter((url) => url.includes('/ack')).length, 1);
    assert.equal(calls.some((url) => url.includes('/processing')), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent daemon handles worker process failure by reporting processing_failed and omitting reply', async () => {
  const identity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_claude', kind: 'agent' });
  const reports = [];
  const sentEnvelopes = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options = {}) => {
    const urlStr = url.toString();
    if (urlStr.includes('/processing')) {
      reports.push(JSON.parse(options.body));
      return { ok: true, status: 204, text: async () => '' };
    }
    if (urlStr.includes('/v1/envelopes')) {
      sentEnvelopes.push(JSON.parse(options.body));
      return { ok: true, status: 202, text: async () => JSON.stringify({ code: 'OK' }) };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  };

  try {
    const daemon = createAgentDaemon({
      identity,
      relayUrl: 'http://127.0.0.1:8791',
      workerCommand: process.execPath,
      workerArgs: ['-e', 'process.stderr.write("Fatal crash in worker"); process.exit(1);'],
      autoReply: true,
      logger: { error: () => {}, warn: () => {}, log: () => {} }
    });

    const result = await daemon.processItem({
      delivery_id: 'del_fail_1',
      envelope: {
        protocol: 'sigil/1',
        message_id: 'msg_fail_1',
        conversation_id: 'conv_1',
        message_type: 'task.request',
        sender: { owner_id: 'usr_soren', endpoint_id: 'ep_codex' },
        body: { task_id: 'task_fail', instruction: 'Do something impossible' }
      }
    });

    assert.equal(result.outcome, 'processing_failed');
    assert.ok(result.error.includes('Worker exited with code 1'));
    assert.ok(reports.some((r) => r.state === 'processing_failed' && r.reason?.includes('Fatal crash in worker')));
    assert.equal(sentEnvelopes.length, 0, 'Must not send task.result envelope on failure');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent daemon handles relay poll network errors gracefully without crashing', async () => {
  const identity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_claude', kind: 'agent' });
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:8791');
  };

  try {
    const daemon = createAgentDaemon({
      identity,
      relayUrl: 'http://127.0.0.1:8791',
      logger: { error: () => {}, warn: () => {}, log: () => {} }
    });

    const processed = await daemon.poll();
    assert.equal(processed, 0, 'Must return 0 processed items on network error');
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('agent daemon hands room.message deliveries to onRoomMessage and acks them', async () => {
  const identity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_claude', kind: 'agent' });
  const acks = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { if (url.toString().includes('/ack')) acks.push(url.toString()); return { ok: true, status: 200, text: async () => '{}' }; };
  try {
    const handled = [];
    const daemon = createAgentDaemon({ identity, relayUrl: 'http://127.0.0.1:8791', onRoomMessage: async (item) => { handled.push(item); return { outcome: 'replied' }; } });
    const envelope = { message_id: 'msg_r', message_type: 'room.message', conversation_id: 'room_1', body: { text: 'hi' } };
    const result = await daemon.processItem({ delivery_id: 'del_r', envelope });
    assert.deepEqual(result, { delivery_id: 'del_r', outcome: 'room_replied' });
    assert.equal(handled[0].envelope.message_id, 'msg_r');
    assert.equal(acks.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent daemon poll() is not re-entrant: concurrent polls share one run, then re-read once', async () => {
  const identity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_claude', kind: 'agent' });
  const originalFetch = globalThis.fetch;
  const envelope = { message_id: 'msg_slow', message_type: 'room.message', conversation_id: 'room_1', body: { text: 'hi' } };
  let inboxFetches = 0;
  let acked = false;
  globalThis.fetch = async (url) => {
    if (url.toString().includes('/ack')) { acked = true; return { ok: true, status: 200, text: async () => '{}' }; }
    inboxFetches += 1;
    const items = acked ? [] : [{ delivery_id: 'del_slow', envelope }];
    return { ok: true, status: 200, text: async () => JSON.stringify({ items, next_since: 'c1' }) };
  };
  try {
    let calls = 0;
    const daemon = createAgentDaemon({
      identity,
      relayUrl: 'http://127.0.0.1:8791',
      logger: { error: () => {}, warn: () => {}, log: () => {} },
      onRoomMessage: async () => { calls += 1; await new Promise((r) => setTimeout(r, 300)); return { outcome: 'replied' }; }
    });
    const [a, b] = await Promise.all([daemon.poll(), daemon.poll()]);
    assert.equal(calls, 1);
    assert.equal(inboxFetches, 2, 'the poll requested mid-run re-read the inbox once');
    assert.deepEqual([a, b], [1, 1]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent daemon does not ack a room delivery when onRoomMessage throws, and the next poll retries it', async () => {
  const identity = createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_claude', kind: 'agent' });
  const originalFetch = globalThis.fetch;
  const envelope = { message_id: 'msg_retry', message_type: 'room.message', conversation_id: 'room_1', body: { text: 'hi' } };
  const acks = [];
  const sinces = [];
  let acked = false;
  globalThis.fetch = async (url) => {
    const text = url.toString();
    if (text.includes('/ack') || text.includes('/processing')) { acks.push(text); acked = true; return { ok: true, status: 200, text: async () => '{}' }; }
    sinces.push(new URL(text).searchParams.get('since'));
    const items = acked ? [] : [{ delivery_id: 'del_retry', queued_at: '2026-10-02T12:00:00.000Z', envelope }];
    return { ok: true, status: 200, text: async () => JSON.stringify({ items, next_since: items.at(-1)?.queued_at ?? '' }) };
  };
  try {
    const errors = [];
    let calls = 0;
    const daemon = createAgentDaemon({
      identity,
      relayUrl: 'http://127.0.0.1:8791',
      logger: { error: (message) => errors.push(message), warn: () => {}, log: () => {} },
      onRoomMessage: async () => { calls += 1; if (calls === 1) throw new Error('relay lookup failed'); return { outcome: 'replied' }; },
    });
    const direct = await daemon.processItem({ delivery_id: 'del_direct', envelope });
    assert.equal(direct.outcome, 'room_unacked');
    assert.equal(acks.length, 0, 'a throw is not acked');
    assert.ok(errors.some((message) => /relay lookup failed/.test(message)));
    calls = 0;
    await daemon.poll();
    assert.equal(acks.length, 0, 'still not acked after the failing poll');
    await daemon.poll();
    assert.equal(calls, 2, 'the next poll handed the same delivery to the bridge again');
    assert.deepEqual(sinces.slice(0, 2), ['', ''], 'since did not advance past the unacked delivery');
    assert.equal(acks.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

class FakeSocket extends EventEmitter {
  static instances = [];
  constructor(url, options) { super(); this.url = url; this.options = options; this.readyState = 0; this.sent = []; FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.emit('open'); }
  frame(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
  send(data) { this.sent.push(data); if (JSON.parse(data).type === 'ping') queueMicrotask(() => this.frame({ type: 'pong' })); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}

function streamHarness(t, { pollIntervalMs = 15000, safetyPollIntervalMs = 60000 } = {}) {
  FakeSocket.instances = [];
  const originalFetch = globalThis.fetch;
  const queue = [];
  const reads = [];
  globalThis.fetch = async (url) => {
    const text = url.toString();
    if (text.includes('/ack')) { const id = decodeURIComponent(text.split('/').at(-2)); const i = queue.findIndex((q) => q.delivery_id === id); if (i >= 0) queue.splice(i, 1); return { ok: true, status: 200, text: async () => '{}' }; }
    reads.push(Date.now());
    return { ok: true, status: 200, text: async () => JSON.stringify({ items: [...queue], next_since: '' }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const handled = [];
  const daemon = createAgentDaemon({
    identity: createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_chief', kind: 'agent' }),
    relayUrl: 'http://127.0.0.1:8791',
    streamUrl: 'ws://127.0.0.1:8792/v1/stream',
    WebSocketImpl: FakeSocket,
    pollIntervalMs,
    safetyPollIntervalMs,
    logger: { error: () => {}, warn: () => {}, info: () => {}, log: () => {} },
    onRoomMessage: async ({ envelope }) => { handled.push(envelope.message_id); return { outcome: 'forwarded' }; },
  });
  t.after(() => daemon.stop());
  const enqueue = (id) => queue.push({ delivery_id: `del_${id}`, envelope: { message_id: id, message_type: 'room.message', conversation_id: 'room_1', body: { text: 'hi' } } });
  return { daemon, handled, reads, enqueue };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function settle() { for (let i = 0; i < 10; i += 1) await flush(); }
async function advance(t, ms) { for (let left = ms; left > 0; left -= 5000) { t.mock.timers.tick(Math.min(5000, left)); await settle(); } }

test('agent daemon processes a delivery as soon as the stream sends a delivered frame, without waiting for a timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = streamHarness(t);
  h.daemon.start();
  await settle();
  const socket = FakeSocket.instances[0];
  assert.equal(socket.url, 'ws://127.0.0.1:8792/v1/stream');
  socket.open();
  await settle();
  assert.equal(h.daemon.streamOpen, true);
  h.enqueue('msg_live');
  socket.frame({ type: 'delivered', delivery_id: 'del_msg_live', stream_seq: '1' });
  await settle();
  assert.deepEqual(h.handled, ['msg_live']);
});

test('agent daemon backs the stream with a slow safety poll, and polls at the fallback interval while the stream is down', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = streamHarness(t, { pollIntervalMs: 5000, safetyPollIntervalMs: 60000 });
  h.daemon.start();
  await settle();
  FakeSocket.instances[0].open();
  await settle();
  const connectedReads = h.reads.length;
  h.enqueue('msg_missed');
  t.mock.timers.tick(5000);
  await settle();
  assert.deepEqual(h.handled, [], 'no 5s poll while the stream is open');
  await advance(t, 55000);
  assert.deepEqual(h.handled, ['msg_missed'], 'the safety poll caught a delivery whose frame was lost');
  assert.ok(h.reads.length > connectedReads);

  FakeSocket.instances[0].close();
  await settle();
  assert.equal(h.daemon.streamOpen, false);
  h.enqueue('msg_down');
  t.mock.timers.tick(5000);
  await settle();
  assert.deepEqual(h.handled, ['msg_missed', 'msg_down'], 'fallback poll ran at pollIntervalMs while disconnected');
  assert.ok(FakeSocket.instances.length >= 2, 'reconnected with backoff');
});

test('agent daemon re-reads the inbox when the stream reconnects', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = streamHarness(t, { pollIntervalMs: 15000 });
  h.daemon.start();
  await settle();
  FakeSocket.instances[0].open();
  await settle();
  FakeSocket.instances[0].close();
  await settle();
  h.enqueue('msg_gap');
  t.mock.timers.tick(250);
  await settle();
  FakeSocket.instances[1].open();
  await settle();
  assert.deepEqual(h.handled, ['msg_gap']);
});

test('agent daemon never hands the same delivery to the bridge twice while it is in flight', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' });
  try {
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const daemon = createAgentDaemon({
      identity: createIdentity({ ownerId: 'usr_soren', endpointId: 'ep_chief', kind: 'agent' }),
      relayUrl: 'http://127.0.0.1:8791',
      logger: { error: () => {}, warn: () => {}, info: () => {} },
      onRoomMessage: async () => { calls += 1; await gate; return { outcome: 'forwarded' }; },
    });
    const item = { delivery_id: 'del_dup', envelope: { message_id: 'msg_dup', message_type: 'room.message', conversation_id: 'room_1' } };
    const first = daemon.processItem(item);
    const second = await daemon.processItem(item);
    assert.equal(second.outcome, 'in_flight');
    release();
    assert.equal((await first).outcome, 'room_forwarded');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
