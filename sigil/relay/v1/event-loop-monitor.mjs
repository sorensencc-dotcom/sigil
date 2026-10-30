import { monitorEventLoopDelay } from 'node:perf_hooks';
import { logHop } from './hop-log.mjs';

export const DEFAULT_EVENT_LOOP_WARN_MS = 1000;

export function startEventLoopMonitor({ intervalMs = 5000, thresholdMs = DEFAULT_EVENT_LOOP_WARN_MS, histogram = monitorEventLoopDelay({ resolution: 20 }), log = logHop } = {}) {
  histogram.enable();
  const check = () => {
    const toMs = (ns) => Math.round(ns / 1e6);
    const p99Ms = toMs(histogram.percentile(99));
    const maxMs = toMs(histogram.max);
    if (p99Ms > thresholdMs || maxMs > thresholdMs) log('relay.event_loop_delay', { p99_ms: p99Ms, max_ms: maxMs, mean_ms: toMs(histogram.mean) });
    histogram.reset();
  };
  const timer = setInterval(check, intervalMs);
  timer.unref();
  return { check, stop: () => { clearInterval(timer); histogram.disable(); } };
}
