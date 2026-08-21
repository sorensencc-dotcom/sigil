import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentDaemon } from './agent-daemon.mjs';
import { createIdentity } from './identity.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeWorkerScript = path.resolve(here, '..', 'scripts', 'claude-worker.mjs');

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

