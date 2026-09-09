import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSessionResendRequestBody } from './session-resend-request-schema.mjs';

test('accepts a bounded session resend request body', () => {
  assert.doesNotThrow(() => validateSessionResendRequestBody({
    target_sender_endpoint_id: 'ep_sender',
    conversation_id: 'conv_1',
    begin_seq: 12,
    end_seq: 0,
  }));
});

for (const [name, body, field] of [
  ['missing target sender', { conversation_id: 'conv_1', begin_seq: 1, end_seq: 1 }, 'target_sender_endpoint_id'],
  ['missing conversation', { target_sender_endpoint_id: 'ep_sender', begin_seq: 1, end_seq: 1 }, 'conversation_id'],
  ['zero begin sequence', { target_sender_endpoint_id: 'ep_sender', conversation_id: 'conv_1', begin_seq: 0, end_seq: 1 }, 'begin_seq'],
  ['negative end sequence', { target_sender_endpoint_id: 'ep_sender', conversation_id: 'conv_1', begin_seq: 1, end_seq: -1 }, 'end_seq'],
  ['fractional sequence', { target_sender_endpoint_id: 'ep_sender', conversation_id: 'conv_1', begin_seq: 1.5, end_seq: 2 }, 'begin_seq'],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () => validateSessionResendRequestBody(body),
      (error) => error.code === 'INVALID_ENVELOPE' && error.details.field === field,
    );
  });
}
