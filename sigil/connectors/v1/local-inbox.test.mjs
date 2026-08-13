import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalInbox } from './local-inbox.mjs';

test('stores before acknowledgement and deduplicates message IDs', () => {
  const inbox = new LocalInbox();
  const envelope = { message_id: 'msg_1', body: { task_id: 'task_1' } };
  const first = inbox.receive(envelope);
  const second = inbox.receive({ ...envelope, body: { changed: true } });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.message.envelope, envelope);
  assert.equal(inbox.size(), 1);
});

test('records processing failure without deleting the original envelope', () => {
  const inbox = new LocalInbox();
  inbox.receive({ message_id: 'msg_1', body: {} });
  const result = inbox.process('msg_1', { state: 'processing_failed', reason: 'runtime unavailable' });
  assert.equal(result.state, 'processing_failed');
  assert.equal(result.failure_reason, 'runtime unavailable');
  assert.equal(inbox.get('msg_1').envelope.message_id, 'msg_1');
});

test('rejects missing messages and invalid outcomes', () => {
  const inbox = new LocalInbox();
  assert.throws(() => inbox.receive({}), { code: 'INVALID_ENVELOPE' });
  assert.throws(() => inbox.process('missing', { state: 'processed' }), { code: 'CONTEXT_NOT_FOUND' });
  inbox.receive({ message_id: 'msg_1', body: {} });
  assert.throws(() => inbox.process('msg_1', { state: 'queued' }), { code: 'INVALID_ENVELOPE' });
});
