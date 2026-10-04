import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRoomEventBody, clampReason, ROOM_EVENT_REASON_MAX } from './room-event-schema.mjs';

const ok = { kind: 'router_decision', endpoint_ids: ['ep_claude'], reason: 'asks about code' };

test('accepts a router decision body', () => {
  assert.doesNotThrow(() => validateRoomEventBody(ok));
  assert.doesNotThrow(() => validateRoomEventBody({ kind: 'router_failed', endpoint_ids: [] }));
});

test('rejects unknown kinds, unknown fields, and bad types', () => {
  assert.throws(() => validateRoomEventBody({ ...ok, kind: 'other' }), { code: 'INVALID_ENVELOPE' });
  assert.throws(() => validateRoomEventBody({ ...ok, extra: 1 }), { code: 'INVALID_ENVELOPE' });
  assert.throws(() => validateRoomEventBody({ ...ok, endpoint_ids: 'ep_claude' }), { code: 'INVALID_ENVELOPE' });
  assert.throws(() => validateRoomEventBody({ ...ok, reason: 'x'.repeat(ROOM_EVENT_REASON_MAX + 1) }), { code: 'INVALID_ENVELOPE' });
  assert.throws(() => validateRoomEventBody({ ...ok, invocation_id: 5 }), { code: 'INVALID_ENVELOPE' });
});

test('clampReason trims length and strips control characters', () => {
  assert.equal(clampReason('a\nb\u0000c'), 'a b c');
  assert.equal(clampReason('x'.repeat(400)).length, ROOM_EVENT_REASON_MAX);
  assert.equal(clampReason(undefined), '');
});
