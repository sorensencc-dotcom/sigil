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

test('clampReason strips C1, bidi, and line/paragraph separator characters', () => {
  assert.equal(clampReason('a\u0085b\u009fc'), 'a b c');
  assert.equal(clampReason('a\u202ab\u202ec'), 'a b c');
  assert.equal(clampReason('a\u2066b\u2069c'), 'a b c');
  assert.equal(clampReason('a\u200eb\u200fc\u061cd'), 'a b c d');
  assert.equal(clampReason('a\u2028b\u2029c'), 'a b c');
});

test('validateRoomEventBody rejects remaining invalid shapes', () => {
  for (const bad of [null, undefined, 'x', [], 5]) {
    assert.throws(() => validateRoomEventBody(bad), (e) => e.code === 'INVALID_ENVELOPE' && e.details.field === 'body');
  }
  assert.throws(() => validateRoomEventBody({ kind: 'router_failed' }), (e) => e.details.field === 'endpoint_ids');
  assert.throws(() => validateRoomEventBody({ kind: 'router_failed', endpoint_ids: [''] }), (e) => e.details.field === 'endpoint_ids');
  assert.throws(() => validateRoomEventBody({ kind: 'router_failed', endpoint_ids: [5] }), (e) => e.details.field === 'endpoint_ids');
  assert.throws(() => validateRoomEventBody({ kind: 'router_failed', endpoint_ids: Array.from({ length: 51 }, (_, i) => `ep_${i}`) }), (e) => e.details.field === 'endpoint_ids');
  assert.throws(() => validateRoomEventBody({ ...ok, invocation_id: '' }), (e) => e.details.field === 'invocation_id');
  assert.throws(() => validateRoomEventBody({ ...ok, reason: 5 }), (e) => e.details.field === 'reason');
  assert.doesNotThrow(() => validateRoomEventBody({ ...ok, invocation_id: 'inv_1', reason: 'x'.repeat(ROOM_EVENT_REASON_MAX) }));
  assert.doesNotThrow(() => validateRoomEventBody({ kind: 'invocation_stopped', endpoint_ids: Array.from({ length: 50 }, (_, i) => `ep_${i}`) }));
});
