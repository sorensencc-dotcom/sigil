import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pollInbox } from './poll-inbox.mjs';

describe('Sigil Hook: poll-inbox', () => {
  it('returns an empty array when the ledger does not exist', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-poll-test-'));
    try {
      const ledgerPath = path.join(tempDir, 'inbox-ledger.jsonl');
      const lastSeenPath = path.join(tempDir, '.last_seen_cursor');
      const logs = [];

      const result = await pollInbox({
        ledgerPath,
        lastSeenPath,
        output: (msg) => logs.push(msg)
      });

      assert.deepEqual(result, []);
      assert.equal(logs.length, 0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('detects unread envelopes, logs them, and updates the last seen cursor', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-poll-test-'));
    try {
      const ledgerPath = path.join(tempDir, 'inbox-ledger.jsonl');
      const lastSeenPath = path.join(tempDir, '.last_seen_cursor');
      const logs = [];

      const envelope1 = {
        message_id: 'msg_01',
        conversation_id: 'conv_01',
        message_type: 'task.request',
        created_at: '2026-08-21T10:00:00.000Z',
        sender: { endpoint_id: 'endpoint_codex_01', owner_id: 'owner_alex' },
        recipient: { endpoint_id: 'endpoint_claude_01', owner_id: 'owner_soren' },
        body: { task: 'Review pull request' }
      };

      const envelope2 = {
        message_id: 'msg_02',
        conversation_id: 'conv_01',
        message_type: 'task.request',
        created_at: '2026-08-21T10:05:00.000Z',
        sender: { endpoint_id: 'endpoint_codex_01', owner_id: 'owner_alex' },
        recipient: { endpoint_id: 'endpoint_claude_01', owner_id: 'owner_soren' },
        body: { task: 'Run benchmark tests' }
      };

      fs.writeFileSync(
        ledgerPath,
        `${JSON.stringify({ envelope: envelope1 })}\n${JSON.stringify({ envelope: envelope2 })}\n`,
        'utf8'
      );

      const result1 = await pollInbox({
        ledgerPath,
        lastSeenPath,
        output: (msg) => logs.push(msg)
      });

      assert.equal(result1.length, 2);
      assert.ok(logs.some((msg) => msg.includes('2 new unread Sigil envelope(s)')));
      assert.ok(fs.existsSync(lastSeenPath));

      const storedCursor = JSON.parse(fs.readFileSync(lastSeenPath, 'utf8'));
      assert.equal(storedCursor.timestamp, new Date('2026-08-21T10:05:00.000Z').getTime());
      assert.deepEqual(storedCursor.ids, ['msg_02']);

      // Subsequent poll with no new messages should return empty
      const logs2 = [];
      const result2 = await pollInbox({
        ledgerPath,
        lastSeenPath,
        output: (msg) => logs2.push(msg)
      });

      assert.deepEqual(result2, []);
      assert.equal(logs2.length, 0);

      // Append a third message with newer timestamp
      const envelope3 = {
        message_id: 'msg_03',
        conversation_id: 'conv_01',
        message_type: 'task.result',
        created_at: '2026-08-21T10:10:00.000Z',
        sender: { endpoint_id: 'endpoint_codex_01', owner_id: 'owner_alex' },
        recipient: { endpoint_id: 'endpoint_claude_01', owner_id: 'owner_soren' },
        body: { status: 'completed' }
      };

      fs.appendFileSync(ledgerPath, `${JSON.stringify({ envelope: envelope3 })}\n`, 'utf8');

      const logs3 = [];
      const result3 = await pollInbox({
        ledgerPath,
        lastSeenPath,
        output: (msg) => logs3.push(msg)
      });

      assert.equal(result3.length, 1);
      assert.equal(result3[0].envelope.message_id, 'msg_03');
      assert.ok(logs3.some((msg) => msg.includes('1 new unread Sigil envelope(s)')));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('skips invalid json lines without crashing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-poll-test-'));
    try {
      const ledgerPath = path.join(tempDir, 'inbox-ledger.jsonl');
      const lastSeenPath = path.join(tempDir, '.last_seen_cursor');
      const logs = [];

      const envelope = {
        message_id: 'msg_valid',
        conversation_id: 'conv_01',
        message_type: 'task.request',
        created_at: '2026-08-21T10:00:00.000Z',
        sender: { endpoint_id: 'endpoint_codex_01', owner_id: 'owner_alex' },
        body: { task: 'valid task' }
      };

      fs.writeFileSync(
        ledgerPath,
        `INVALID_CORRUPT_JSON_LINE\n${JSON.stringify({ envelope })}\n`,
        'utf8'
      );

      const result = await pollInbox({
        ledgerPath,
        lastSeenPath,
        output: (msg) => logs.push(msg)
      });

      assert.equal(result.length, 1);
      assert.equal(result[0].envelope.message_id, 'msg_valid');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not drop a later envelope that shares the exact timestamp of the cursor', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-poll-test-'));
    try {
      const ledgerPath = path.join(tempDir, 'inbox-ledger.jsonl');
      const lastSeenPath = path.join(tempDir, '.last_seen_cursor');
      const sharedTimestamp = '2026-08-21T10:00:00.000Z';

      const envelopeA = {
        message_id: 'msg_a',
        conversation_id: 'conv_01',
        message_type: 'task.request',
        created_at: sharedTimestamp,
        sender: { endpoint_id: 'endpoint_codex_01', owner_id: 'owner_alex' },
        body: { task: 'first' }
      };

      fs.writeFileSync(ledgerPath, `${JSON.stringify({ envelope: envelopeA })}\n`, 'utf8');

      const result1 = await pollInbox({ ledgerPath, lastSeenPath, output: () => {} });
      assert.equal(result1.length, 1);

      const envelopeB = {
        message_id: 'msg_b',
        conversation_id: 'conv_01',
        message_type: 'task.request',
        created_at: sharedTimestamp,
        sender: { endpoint_id: 'endpoint_codex_01', owner_id: 'owner_alex' },
        body: { task: 'second, same millisecond' }
      };

      fs.appendFileSync(ledgerPath, `${JSON.stringify({ envelope: envelopeB })}\n`, 'utf8');

      const result2 = await pollInbox({ ledgerPath, lastSeenPath, output: () => {} });
      assert.equal(result2.length, 1);
      assert.equal(result2[0].envelope.message_id, 'msg_b');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
