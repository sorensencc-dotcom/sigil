import test from 'node:test';
import assert from 'node:assert/strict';
import { runResendWorkerPass } from './resend-worker.mjs';

const NOW = new Date('2026-09-09T12:01:00.000Z');

function job(overrides = {}) {
  return {
    id: 'job_resend_1', claimToken: 'claim_1', attemptCount: 0,
    createdAt: '2026-09-09T12:00:00.000Z',
    payload: {
      requester_endpoint_id: 'ep_requester', target_sender_endpoint_id: 'ep_sender',
      conversation_id: 'conv_resend', begin_seq: 1, end_seq: 3,
    },
    ...overrides,
  };
}

function repository({ jobs = [job()], envelopes = [] } = {}) {
  const calls = { finalize: [], audits: [], lookups: [] };
  return {
    calls,
    async claimDueRelayJobs(jobType, now, limit, leaseSeconds) {
      assert.equal(jobType, 'resend');
      assert.equal(now, NOW);
      assert.equal(limit, 10);
      assert.equal(leaseSeconds, 30);
      return jobs;
    },
    async listResendEnvelopes(targetSenderEndpointId, conversationId, beginSeq, endSeq, now) {
      calls.lookups.push({ targetSenderEndpointId, conversationId, beginSeq, endSeq, now });
      return envelopes;
    },
    async withTransaction(fn) { return fn({ id: 'resend-worker-client' }); },
    async finalizeRelayJob(jobType, id, claimToken, state, patch) {
      calls.finalize.push({ jobType, id, claimToken, state, patch });
      return { updated: true };
    },
    async recordAuditEvent(event) { calls.audits.push(event); return event; },
  };
}

test('re-pushes original signed envelopes in sequence order and fills an expired hole with sequence_reset', async () => {
  const repo = repository({
    envelopes: [
      { streamSeq: 1n, envelope: { message_id: 'msg_1', signature: { value: 'original_1' } } },
      { streamSeq: 3n, envelope: { message_id: 'msg_3', signature: { value: 'original_3' } } },
    ],
  });
  const frames = [];
  const stream = {
    notifyResend(endpointId, payload) { frames.push({ type: 'resend', endpointId, payload }); return true; },
    notifySequenceReset(endpointId, payload) { frames.push({ type: 'sequence_reset', endpointId, payload }); return true; },
  };
  const metricCalls = [];
  const metrics = { increment: (...args) => metricCalls.push(['increment', ...args]), observe: (...args) => metricCalls.push(['observe', ...args]) };

  const result = await runResendWorkerPass({ repository: repo, stream, now: NOW, metrics });

  assert.deepEqual(result, { claimed: 1, fulfilled: 1, requeued: 0, deadLettered: 0, resets: 1, pushed: 2 });
  assert.deepEqual(frames, [
    { type: 'resend', endpointId: 'ep_requester', payload: { streamSeq: 1n, envelope: { message_id: 'msg_1', signature: { value: 'original_1' } } } },
    { type: 'sequence_reset', endpointId: 'ep_requester', payload: { conversation_id: 'conv_resend', target_sender_endpoint_id: 'ep_sender', gap_fill_from: 2, new_seq: 3, reason: 'expired' } },
    { type: 'resend', endpointId: 'ep_requester', payload: { streamSeq: 3n, envelope: { message_id: 'msg_3', signature: { value: 'original_3' } } } },
  ]);
  assert.deepEqual(repo.calls.finalize[0], {
    jobType: 'resend', id: 'job_resend_1', claimToken: 'claim_1', state: 'done',
    patch: { attemptCount: 0, reasonCode: null },
  });
  assert.equal(repo.calls.audits[0].eventType, 'session.resend_fulfilled');
  assert.ok(metricCalls.some(([kind, name]) => kind === 'increment' && name === 'sigil_resend_fulfilled_total'));
  assert.ok(metricCalls.some(([kind, name]) => kind === 'increment' && name === 'sigil_sequence_reset_total'));
  assert.ok(metricCalls.some(([kind, name]) => kind === 'observe' && name === 'sigil_resend_latency_seconds'));
});

test('re-queues a closed requester stream on the first miss', async () => {
  const repo = repository({ envelopes: [{ streamSeq: 1n, envelope: { message_id: 'msg_1' } }] });
  const stream = { notifyResend: () => false, notifySequenceReset: () => false };

  const result = await runResendWorkerPass({ repository: repo, stream, now: NOW });

  assert.deepEqual(result, { claimed: 1, fulfilled: 0, requeued: 1, deadLettered: 0, resets: 0, pushed: 0 });
  assert.equal(repo.calls.finalize[0].state, 'pending');
  assert.equal(repo.calls.finalize[0].patch.attemptCount, 1);
  assert.equal(repo.calls.finalize[0].patch.reasonCode, 'REQUESTER_STREAM_UNAVAILABLE');
  assert.equal(repo.calls.finalize[0].patch.nextAttemptAt.toISOString(), '2026-09-09T12:02:00.000Z');
});

test('dead-letters a resend job only after the retry maximum', async () => {
  const repo = repository({ jobs: [job({ attemptCount: 3 })], envelopes: [{ streamSeq: 1n, envelope: { message_id: 'msg_1' } }] });
  const stream = { notifyResend: () => false, notifySequenceReset: () => false };
  const logs = [];

  const result = await runResendWorkerPass({ repository: repo, stream, now: NOW, logger: { error: (entry) => logs.push(entry) } });

  assert.deepEqual(result, { claimed: 1, fulfilled: 0, requeued: 0, deadLettered: 1, resets: 0, pushed: 0 });
  assert.equal(repo.calls.finalize[0].state, 'dead_letter');
  assert.equal(repo.calls.finalize[0].patch.attemptCount, 4);
  assert.equal(repo.calls.audits[0].eventType, 'session.resend_dead_letter');
  assert.equal(logs[0].event, 'session.resend_dead_letter');
});
