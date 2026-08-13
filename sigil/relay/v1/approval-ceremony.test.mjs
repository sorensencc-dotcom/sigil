import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeApprovalResult, createApprovalChallenge } from './approval-ceremony.mjs';

test('approval URL uses relay origin and binds challenge to action', () => {
  const challenge = createApprovalChallenge({ relayOrigin: 'https://relay.example', actionHash: 'sha256:abc', endpointId: 'ep_codex', callbackUrl: 'http://127.0.0.1:4567/callback' });
  assert.equal(new URL(challenge.approvalUrl).origin, 'https://relay.example');
  assert.equal(new URL(challenge.approvalUrl).pathname, '/approve');
  assert.equal(new URL(challenge.approvalUrl).searchParams.get('cb'), challenge.callbackUrl);
});

test('approval result is single-use and action-bound', () => {
  const challenge = createApprovalChallenge({ relayOrigin: 'https://relay.example', actionHash: 'sha256:abc', callbackUrl: 'http://127.0.0.1/cb' });
  assert.deepEqual(consumeApprovalResult(challenge, { token: challenge.token, actionHash: 'sha256:abc', decisionToken: 'decision_1' }), { verified: true, decisionToken: 'decision_1' });
  assert.throws(() => consumeApprovalResult(challenge, { token: challenge.token, actionHash: 'sha256:abc' }), { code: 'APPROVAL_EXPIRED' });
});
