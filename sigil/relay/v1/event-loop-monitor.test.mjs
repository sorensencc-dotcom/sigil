import test from 'node:test';
import assert from 'node:assert/strict';
import { startEventLoopMonitor } from './event-loop-monitor.mjs';

function fakeHistogram({ p99Ms, maxMs }) {
  return { enabled: false, resets: 0, max: maxMs * 1e6, mean: 1e6, percentile: () => p99Ms * 1e6, enable() { this.enabled = true; }, disable() { this.enabled = false; }, reset() { this.resets += 1; } };
}

test('logs when max delay is over the threshold and resets the window', () => {
  const logs = [];
  const histogram = fakeHistogram({ p99Ms: 20, maxMs: 1500 });
  const monitor = startEventLoopMonitor({ histogram, thresholdMs: 1000, log: (hop, fields) => logs.push({ hop, ...fields }) });
  monitor.check();
  monitor.stop();
  assert.deepEqual(logs, [{ hop: 'relay.event_loop_delay', p99_ms: 20, max_ms: 1500, mean_ms: 1 }]);
  assert.equal(histogram.resets, 1);
});

test('stays quiet under the threshold, and stop disables the histogram', () => {
  const logs = [];
  const histogram = fakeHistogram({ p99Ms: 15, maxMs: 40 });
  const monitor = startEventLoopMonitor({ histogram, thresholdMs: 1000, log: (hop) => logs.push(hop) });
  monitor.check();
  monitor.stop();
  assert.deepEqual(logs, []);
  assert.equal(histogram.enabled, false);
});
