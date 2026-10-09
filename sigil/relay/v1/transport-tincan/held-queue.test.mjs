import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signedBytes } from '../validate-envelope.mjs';
import { canonicalEnvelopeHash, createHeldQueue } from './held-queue.mjs';

const envelope = () => ({ protocol: 'sigil/1', message_id: 'msg_1', sender: { endpoint_id: 'ep_claude' }, message_type: 'task.request', body: { task_id: 't1' }, signature: { value: 'abc' } });

test('hash is the hex sha256 of signedBytes and ignores the signature field', () => {
  const expected = crypto.createHash('sha256').update(signedBytes(envelope())).digest('hex');
  assert.equal(canonicalEnvelopeHash(envelope()), expected);
  assert.equal(canonicalEnvelopeHash({ ...envelope(), signature: { value: 'different' } }), expected);
});

test('holdForApproval submits action_hash and callback_url only', async () => {
  let submitted;
  const queue = createHeldQueue({ callbackUrl: 'http://127.0.0.1:8795/v1/approval-callback', submitChallengeFn: async (body, token) => { submitted = { body, token }; return { challenge_id: 'ch_1' }; } });
  const result = await queue.holdForApproval(envelope(), 'tok');
  assert.equal(result.challengeId, 'ch_1');
  assert.deepEqual(Object.keys(submitted.body).sort(), ['action_hash', 'callback_url']);
  assert.equal(submitted.body.action_hash, canonicalEnvelopeHash(envelope()));
  assert.equal(submitted.token, 'tok');
});

test('held envelope is frozen and releases byte-identical', async () => {
  const queue = createHeldQueue({ callbackUrl: 'http://127.0.0.1:8795/cb', submitChallengeFn: async () => ({ challenge_id: 'ch_1' }) });
  const { actionHash } = await queue.holdForApproval(envelope(), 'tok');
  const released = queue.releaseEnvelope(actionHash);
  assert.throws(() => { 'use strict'; released.body.task_id = 'tampered'; }, TypeError);
  assert.equal(canonicalEnvelopeHash(released), actionHash);
  assert.throws(() => queue.releaseEnvelope(actionHash), /not found/);
});
