// Fixed timeout and no-follow redirect policy for every outbound fetch. The
// signal is created per call: one shared AbortSignal.timeout would fire once and
// then stay aborted for every later request.
export function outboundFetchOptions() {
  return { signal: AbortSignal.timeout(5000), redirect: 'error' };
}
