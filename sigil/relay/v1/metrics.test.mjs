import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayMetrics } from './metrics.mjs';

test('records session counters, gauges, and observations with stable label ordering', () => {
  const metrics = createRelayMetrics();
  metrics.increment('sigil_resend_request_total', 2, { conversation_kind: 'direct', sender: 'ep_a' });
  metrics.set('sigil_relay_jobs_depth', 3, { job_type: 'resend' });
  metrics.observe('sigil_resend_latency_seconds', 1.5, { conversation_kind: 'direct' });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters['sigil_resend_request_total{conversation_kind=direct,sender=ep_a}'], 2);
  assert.equal(snapshot.counters['sigil_relay_jobs_depth{job_type=resend}'], 3);
  assert.deepEqual(snapshot.observations['sigil_resend_latency_seconds{conversation_kind=direct}'], [1.5]);
});
