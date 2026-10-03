import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRoomMessageBody, ROOM_MESSAGE_TEXT_MAX } from './room-message-schema.mjs';

test('accepts a minimal room message', () => {
  assert.doesNotThrow(() => validateRoomMessageBody({ text: 'hello room' }));
});

test('accepts a threaded reply with mentions', () => {
  assert.doesNotThrow(() => validateRoomMessageBody({ text: 'on it', thread_root_id: 'msg_root', mentions: ['ep_claude', 'ep_codex'] }));
});

for (const [name, body, field] of [
  ['non-object body', 'text', 'body'],
  ['array body', [], 'body'],
  ['missing text', {}, 'text'],
  ['empty text', { text: '' }, 'text'],
  ['oversized text', { text: 'x'.repeat(ROOM_MESSAGE_TEXT_MAX + 1) }, 'text'],
  ['empty thread root', { text: 'a', thread_root_id: '' }, 'thread_root_id'],
  ['mentions not an array', { text: 'a', mentions: 'ep_claude' }, 'mentions'],
  ['empty mention', { text: 'a', mentions: [''] }, 'mentions'],
  ['too many mentions', { text: 'a', mentions: Array.from({ length: 51 }, (_, i) => `ep_${i}`) }, 'mentions'],
  ['unknown field', { text: 'a', priority: 'high' }, 'priority'],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => validateRoomMessageBody(body), (error) => error.code === 'INVALID_ENVELOPE' && error.details.field === field);
  });
}
